/**
 * Structured Engine — CSV / XLSX / XLS → ProductionRecord[]
 * ---------------------------------------------------------
 * Takes a StructuredMappingConfig (stored as JSONB in format_mappings) and a
 * raw file buffer, returns normalized ProductionRecord[]. This is the
 * generic, data-driven counterpart to hand-written adapters like
 * aftermathDailiesCsv.ts.
 *
 * Design principle — DUMB ENGINE, SMART CONFIG:
 *   The engine itself has no operator-specific logic. Everything unique to
 *   a given operator (column names, date format, API width, hierarchical
 *   rows, etc.) lives in the config. Changing an operator's format means
 *   editing a row in the DB, not the code.
 *
 * Coverage (Phase 1):
 *   - Flat CSV with headers (Aftermath, ComboCurve-style exports)
 *   - Flat XLSX single-sheet (Arlo)
 *   - XLSX multi-sheet with sheet-name selection (BTA Daily — one sheet/well)
 *   - Hierarchical layout (Format 10 / Tap Rock / Gretchen — well name row
 *     above indented date rows)
 *   - column-letter matching (for files with unusable header names)
 *   - header-regex matching (for volatile header phrasing)
 *   - extraFields capture
 *   - Conventions (date format + API width/hyphenation) driven from config
 *
 * What this DOES NOT do:
 *   - PDF parsing — see pdfEngine.ts (stubbed for Phase 1, built out Phase 4)
 *   - Weekly → daily splitting — out of scope for first cut; a future transform
 *
 * All throws here produce messages prefixed "[structured-engine]" so they
 * surface cleanly in email_log.error_messages.
 */

import * as XLSX from 'xlsx';
import type { ProductionRecord } from '../types.js';
import { normalizeApi } from '../apiNormalization.js';
import type {
  StructuredMappingConfig,
  StructuredColumnSpec,
  TemplateField,
  ValueTransform,
  Conventions,
  SheetSelection,
} from './schema.js';

/* ══════════════════════════════════════════════════════════════════════
 * Tiny utilities
 * ═════════════════════════════════════════════════════════════════════ */

/** All row types that can appear in a 2-D sheet representation. */
type Cell = string | number | boolean | null | undefined;
type Sheet2D = Cell[][];

/** Convert a raw cell to a trimmed string. null/undefined → ''. */
function cellToString(c: Cell): string {
  if (c === null || c === undefined) return '';
  return String(c).trim();
}

/** Excel column letter "A" → 0, "Z" → 25, "AA" → 26, ... */
function colLetterToIndex(letter: string): number {
  let idx = 0;
  const upper = letter.toUpperCase();
  for (let i = 0; i < upper.length; i++) {
    const ch = upper.charCodeAt(i);
    if (ch < 65 || ch > 90) {
      throw new Error(`[structured-engine] invalid column letter "${letter}"`);
    }
    idx = idx * 26 + (ch - 64);
  }
  return idx - 1;
}

/** Case-insensitive + whitespace-trim equality. */
function headerMatches(a: string, b: string): boolean {
  return a.trim().toUpperCase() === b.trim().toUpperCase();
}

/* ══════════════════════════════════════════════════════════════════════
 * Cell → value transforms
 * ═════════════════════════════════════════════════════════════════════ */

function parseNumericCell(c: Cell): number | null {
  if (c === null || c === undefined || c === '') return null;
  if (typeof c === 'number') return Number.isFinite(c) ? c : null;
  const s = String(c).trim();
  if (s === '') return null;
  const cleaned = s.replace(/,/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseTextCell(c: Cell): string | null {
  if (c === null || c === undefined) return null;
  const s = String(c).trim();
  return s === '' ? null : s;
}

function parseScientificInt(c: Cell): number | null {
  if (c === null || c === undefined || c === '') return null;
  if (typeof c === 'number') return Number.isFinite(c) ? Math.round(c) : null;
  const n = Number(String(c).trim());
  return Number.isFinite(n) ? Math.round(n) : null;
}

function stripHyphens(c: Cell): string | null {
  if (c === null || c === undefined) return null;
  const s = String(c).replace(/\D/g, '');
  return s === '' ? null : s;
}

/** Apply a ValueTransform by name — the glue between config strings and our
 *  typed helpers above. Defaults by-field if no transform specified. */
function applyTransform(raw: Cell, transform: ValueTransform | undefined, defaultT: ValueTransform): Cell {
  const t = transform ?? defaultT;
  switch (t) {
    case 'number':
      return parseNumericCell(raw);
    case 'text':
      return parseTextCell(raw);
    case 'scientific-notation-int':
      return parseScientificInt(raw);
    case 'strip-hyphens':
      return stripHyphens(raw);
    case 'date':
      return parseTextCell(raw); // date parsing is handled below with conventions
    default:
      return raw;
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * Date parsing (honors Conventions.dateFormat)
 * ═════════════════════════════════════════════════════════════════════ */

/** Excel serial date (days since 1899-12-30) → YYYY-MM-DD. */
function excelSerialToIso(serial: number): string | null {
  if (!Number.isFinite(serial)) return null;
  // Excel's epoch bug: 1900 is treated as a leap year. Using 1899-12-30 as
  // the anchor makes the math correct for all dates past 1900-03-01.
  const ms = Math.round(serial * 86400 * 1000);
  const d = new Date(Date.UTC(1899, 11, 30) + ms);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Try to parse a raw cell as a date, honoring the config's dateFormat.
 *  Returns YYYY-MM-DD string or null. */
function parseDateCell(raw: Cell, conv: Conventions): string | null {
  if (raw === null || raw === undefined || raw === '') return null;

  // If numeric, assume Excel serial (unless explicitly told otherwise).
  if (typeof raw === 'number') {
    if (conv.dateFormat === 'excel-serial' || conv.dateFormat === 'auto') {
      return excelSerialToIso(raw);
    }
    // Treat as string fallback.
    raw = String(raw);
  }

  const s = String(raw).trim().replace(/^\s+/, '');
  if (s === '') return null;

  // YYYY-MM-DD (ISO)
  const iso = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (iso && (conv.dateFormat === 'YYYY-MM-DD' || conv.dateFormat === 'auto')) {
    const [, y, m, d] = iso;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // M/D/YYYY or MM/DD/YYYY
  const mdy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (mdy && (conv.dateFormat === 'M/D/YYYY' || conv.dateFormat === 'MM/DD/YYYY' || conv.dateFormat === 'auto')) {
    let [, mm, dd, yyyy] = mdy;
    if (yyyy.length === 2) yyyy = (Number(yyyy) > 50 ? '19' : '20') + yyyy;
    const mmi = Number(mm);
    const ddi = Number(dd);
    if (mmi < 1 || mmi > 12 || ddi < 1 || ddi > 31) return null;
    return `${yyyy}-${String(mmi).padStart(2, '0')}-${String(ddi).padStart(2, '0')}`;
  }

  // D/M/YYYY (explicit — ambiguous shapes only resolve this way when asked)
  if (conv.dateFormat === 'D/M/YYYY') {
    const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
    if (dmy) {
      let [, dd, mm, yyyy] = dmy;
      if (yyyy.length === 2) yyyy = (Number(yyyy) > 50 ? '19' : '20') + yyyy;
      return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
    }
  }

  // Excel-rendered text forms — the XLSX library can emit stuff like
  // "4/6/26" or ISO with T00:00:00. Try Date.parse as last resort.
  const parsed = Date.parse(s);
  if (!Number.isNaN(parsed)) {
    const d = new Date(parsed);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }

  return null;
}

/** Normalize a monthly date per the config. first-of-month by default. */
function applyMonthlyNormalization(iso: string, conv: Conventions): string {
  if (!conv.monthlyNormalization || conv.monthlyNormalization === 'first-of-month') {
    return `${iso.slice(0, 7)}-01`;
  }
  if (conv.monthlyNormalization === 'last-of-month') {
    const [y, m] = iso.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return `${iso.slice(0, 7)}-${String(last).padStart(2, '0')}`;
  }
  return iso; // 'as-is'
}

/* ══════════════════════════════════════════════════════════════════════
 * Sheet loading — turn a Buffer + config into a flat Sheet2D
 * ═════════════════════════════════════════════════════════════════════ */

/** Load the workbook and return a list of { sheetName, rows } pairs matching
 *  the sheetSelection config. For CSV, returns a single entry. */
function loadSheets(buffer: Buffer, fileKind: 'csv' | 'xlsx' | 'xls', sel?: SheetSelection): Array<{ sheetName: string; rows: Sheet2D }> {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false, raw: true });
  if (!wb.SheetNames || wb.SheetNames.length === 0) {
    throw new Error('[structured-engine] workbook has no sheets');
  }

  // Default selection: first sheet only.
  const selection: SheetSelection = sel ?? { mode: 'first' };

  let wanted: string[] = [];
  if (selection.mode === 'first') {
    wanted = [wb.SheetNames[0]];
  } else if (selection.mode === 'all') {
    wanted = [...wb.SheetNames];
  } else if (selection.mode === 'named') {
    const names = (selection.names ?? []).map((n) => n.trim().toUpperCase());
    wanted = wb.SheetNames.filter((sn) => names.includes(sn.trim().toUpperCase()));
  } else if (selection.mode === 'pattern') {
    if (!selection.pattern) throw new Error('[structured-engine] sheetSelection.pattern missing');
    const re = new RegExp(selection.pattern, 'i');
    wanted = wb.SheetNames.filter((sn) => re.test(sn));
  }

  if (wanted.length === 0) {
    throw new Error(`[structured-engine] no sheets matched selection ${JSON.stringify(selection)}. Available: ${wb.SheetNames.join(', ')}`);
  }

  return wanted.map((sheetName) => {
    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      blankrows: false,
      raw: true,
      defval: null,
    }) as Sheet2D;
    return { sheetName, rows };
  });
}

/* ══════════════════════════════════════════════════════════════════════
 * Header lookup — given header row + column spec, return column index
 * ═════════════════════════════════════════════════════════════════════ */

function resolveColumnIndex(headerRow: Cell[], spec: StructuredColumnSpec): number {
  switch (spec.matchType) {
    case 'header':
    case 'header-alias': {
      const headers = (spec.headers ?? []).map((h) => h.trim());
      if (headers.length === 0) return -1;
      for (let i = 0; i < headerRow.length; i++) {
        const cell = cellToString(headerRow[i]);
        if (headers.some((h) => headerMatches(cell, h))) return i;
      }
      return -1;
    }
    case 'column-letter': {
      if (!spec.columnLetter) return -1;
      return colLetterToIndex(spec.columnLetter);
    }
    case 'header-regex': {
      if (!spec.regex) return -1;
      const re = new RegExp(spec.regex, 'i');
      for (let i = 0; i < headerRow.length; i++) {
        if (re.test(cellToString(headerRow[i]))) return i;
      }
      return -1;
    }
    default:
      return -1;
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * Main extraction
 * ═════════════════════════════════════════════════════════════════════ */

/** Per-template-field default transform. Mirrors what a human parser author
 *  would pick if they skipped specifying a transform explicitly. */
const DEFAULT_TRANSFORM: Record<TemplateField, ValueTransform> = {
  wellName: 'text',
  api: 'text',
  prodDate: 'date',
  oilProd: 'number',
  oilSales: 'number',
  gasProd: 'number',
  gasSales: 'number',
  waterProd: 'number',
  waterInj: 'number',
  daysOn: 'number',
  choke: 'text',
  tubingPres: 'number',
  casingPres: 'number',
  hoursDown: 'number',
  downtimeReason: 'text',
  operatorWellId: 'scientific-notation-int',
};

/** Extract records from a single sheet using the config. */
function extractFromSheet(rows: Sheet2D, cfg: StructuredMappingConfig): ProductionRecord[] {
  if (rows.length === 0) return [];

  const headerRowIdx = (cfg.headerRow ?? 1) - 1;
  const dataStartIdx = (cfg.dataStartRow ?? cfg.headerRow + 1) - 1;

  if (headerRowIdx < 0 || headerRowIdx >= rows.length) {
    throw new Error(`[structured-engine] headerRow=${cfg.headerRow} is out of bounds (sheet has ${rows.length} rows)`);
  }

  const headerRow = rows[headerRowIdx];

  // Resolve every mapped column's index once up-front.
  const colIdx: Partial<Record<TemplateField, number>> = {};
  for (const [field, spec] of Object.entries(cfg.columnMappings)) {
    if (!spec) continue;
    const idx = resolveColumnIndex(headerRow, spec);
    if (idx < 0 && (spec.missingPolicy ?? 'null') === 'error') {
      throw new Error(`[structured-engine] required column for field "${field}" not found in header row. Header: [${headerRow.map(cellToString).join(', ')}]`);
    }
    colIdx[field as TemplateField] = idx;
  }

  // Extra-field columns (for audit).
  const extraIdx: Record<string, { idx: number; spec: StructuredColumnSpec }> = {};
  for (const [name, spec] of Object.entries(cfg.extraFieldsCapture ?? {})) {
    const idx = resolveColumnIndex(headerRow, spec);
    if (idx >= 0) extraIdx[name] = { idx, spec };
  }

  const records: ProductionRecord[] = [];
  const skipped: Array<{ rowNum: number; reason: string }> = [];

  // Hierarchical-layout state — sticky well-identity row carries forward.
  let stickyWellName: string | null = null;

  for (let r = dataStartIdx; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((c) => cellToString(c) === '')) continue;

    // Hierarchical support: decide if this is a well-identity row or a date row.
    if (cfg.hierarchical?.enabled) {
      const first = cellToString(row[0] ?? '');
      const rawFirst = row[0] !== null && row[0] !== undefined ? String(row[0]) : '';
      const indent = rawFirst.match(/^(\s*)/)?.[1].length ?? 0;
      const isIndented = indent >= (cfg.hierarchical.dateRowIndent ?? 2);

      // Well-identity row = first column matches wellHeaderPattern and NOT indented.
      const wellHdrRe = cfg.hierarchical.wellHeaderPattern
        ? new RegExp(cfg.hierarchical.wellHeaderPattern)
        : null;

      if (!isIndented && wellHdrRe && wellHdrRe.test(first)) {
        stickyWellName = first;
        continue; // skip the totals row itself — we only emit per-date rows
      }
      // Otherwise treat as data row (inherits stickyWellName).
    }

    // Pull raw cells for each mapped field.
    const get = (field: TemplateField): Cell => {
      const i = colIdx[field];
      return i !== undefined && i >= 0 ? row[i] : null;
    };

    // Well identification — API (direct) or fallback to well name lookup.
    const apiRaw = get('api');
    const api10Direct = apiRaw !== null && apiRaw !== undefined && cellToString(apiRaw) !== ''
      ? normalizeApi(cellToString(apiRaw))
      : { api10: '', api14: '' };

    // Well name: take from column if present, else sticky (hierarchical).
    let wellName = cellToString(get('wellName') ?? '');
    if (!wellName && stickyWellName) wellName = stickyWellName;

    const prodDateRaw = get('prodDate');
    const prodIso = parseDateCell(prodDateRaw, cfg.conventions);

    // Required: prodDate + (wellName OR api).
    if (!prodIso) {
      skipped.push({ rowNum: r + 1, reason: `unparseable date ${JSON.stringify(prodDateRaw)}` });
      continue;
    }
    if (!wellName && !api10Direct.api10) {
      skipped.push({ rowNum: r + 1, reason: 'missing well name AND api' });
      continue;
    }

    // Monthly normalization (first-of-month unless config says otherwise).
    const finalDate = cfg.dataType === 'monthly'
      ? applyMonthlyNormalization(prodIso, cfg.conventions)
      : prodIso;

    // Numeric volumes + optionals.
    const num = (f: TemplateField): number | null =>
      applyTransform(get(f), cfg.columnMappings[f]?.transform, DEFAULT_TRANSFORM[f]) as number | null;
    const txt = (f: TemplateField): string | null =>
      applyTransform(get(f), cfg.columnMappings[f]?.transform, DEFAULT_TRANSFORM[f]) as string | null;

    // operatorWellId: may be scientific notation, may be plain int.
    const opWellIdRaw = get('operatorWellId');
    const operatorWellId = opWellIdRaw !== null && opWellIdRaw !== undefined
      ? parseScientificInt(opWellIdRaw)
      : null;

    // extraFields — include raw operatorWellId for audit parity with
    // hand-written adapters like Aftermath's.
    const extraFields: Record<string, unknown> = {};
    for (const [name, { idx, spec }] of Object.entries(extraIdx)) {
      const raw = row[idx];
      const transform = spec.transform ?? 'text';
      extraFields[name] = applyTransform(raw, transform, 'text');
    }

    records.push({
      api14: api10Direct.api14 || '',
      api10: api10Direct.api10 || '',
      wellName,
      combocurveWellId: null,
      operatorWellId,
      prodDate: finalDate,
      oilProd: num('oilProd'),
      gasProd: num('gasProd'),
      waterProd: num('waterProd'),
      gasSales: num('gasSales'),
      oilSales: num('oilSales'),
      waterInj: num('waterInj'),
      daysOn: num('daysOn'),
      choke: txt('choke'),
      tubingPres: num('tubingPres'),
      casingPres: num('casingPres'),
      hoursDown: num('hoursDown'),
      downtimeReason: txt('downtimeReason'),
      extraFields,
    });
  }

  if (records.length === 0) {
    throw new Error(
      `[structured-engine] 0 records produced. ${skipped.length} rows skipped. ` +
        `First reason: ${skipped[0]?.reason ?? 'unknown'}`
    );
  }

  return records;
}

/* ══════════════════════════════════════════════════════════════════════
 * Public entry point
 * ═════════════════════════════════════════════════════════════════════ */

/**
 * Run a StructuredMappingConfig against a raw file buffer.
 * Throws on detection/structural errors; returns ProductionRecord[] on success.
 */
export function runStructuredEngine(
  buffer: Buffer,
  cfg: StructuredMappingConfig
): ProductionRecord[] {
  if (cfg.kind !== 'structured') {
    throw new Error(`[structured-engine] expected kind='structured', got '${cfg.kind}'`);
  }

  // CSV → wrap in a fake-workbook via XLSX.read which understands CSV too.
  // Multi-sheet is irrelevant for CSV, so we always take the first sheet.
  const sheets = loadSheets(buffer, cfg.fileKind, cfg.sheetSelection);

  const allRecords: ProductionRecord[] = [];
  for (const { sheetName, rows } of sheets) {
    try {
      const recs = extractFromSheet(rows, cfg);
      // Stamp sheet name into extraFields for multi-sheet audit.
      if (sheets.length > 1) {
        for (const rec of recs) rec.extraFields.__sheetName = sheetName;
      }
      allRecords.push(...recs);
    } catch (err) {
      // Surface the sheet name in the error so multi-sheet debugging is easy.
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[structured-engine] sheet "${sheetName}": ${msg}`);
    }
  }

  if (allRecords.length === 0) {
    throw new Error('[structured-engine] produced zero records across all sheets');
  }

  return allRecords;
}
