/**
 * Parser: Generic Production CSV  (covers 25+ Frio-family + partner-report CSVs)
 * ------------------------------------------------------------------------------
 * Why this exists
 * ---------------
 * When Caleb forwarded his first real batch of 17 emails (62 attachments),
 * we discovered the operator-CSV landscape is far messier than the original
 * 10-format spec suggested. Across 30 CSVs we surveyed we found *26 distinct
 * header signatures* — every pad / operator / export profile had its own
 * column naming, column order, and column subset.
 *
 * Rather than ship 26 near-identical per-file parsers, this ONE adapter
 * covers them all. It works because every CSV in the corpus shares the same
 * underlying DNA:
 *
 *   - at least one column containing a production date
 *   - at least one identifying column (API or well name)
 *   - at least one volume column (oil prod / gas prod / water prod / sales)
 *
 * What varies is the label spelling and the column order — both of which
 * this adapter tolerates via a big alias dictionary + header-index lookup.
 *
 * Drift tolerance (user requirement, 2026-04-20)
 * ----------------------------------------------
 * Caleb: "sometimes the header is correct but the subdata may be shifted
 *         throughout the doc, so you need to be sure the parser puts the
 *         right data into the right header even if the row data shifts
 *         one column altogether or partially."
 *
 * We implement two layers of drift repair per row:
 *   1. Global shift ±1/±2 — try shifting the whole row left or right and
 *      re-type-check. If a shifted layout passes, use it and flag the row
 *      via extraFields.driftShift.
 *   2. Per-column local search — if the global shift fails, each critical
 *      field (API, date) is allowed to be found at an index ±2 from its
 *      header position, provided the value validates against that field's
 *      type.
 *
 * Rows that still can't be resolved are pushed into `skipped` with a reason
 * and never silently dropped. The adapter errors out if 0 records parse.
 *
 * What this adapter does NOT try to handle
 * ----------------------------------------
 * 1. Aftermath Dailies CSV — already has its own dedicated parser
 *    (more precise detect, audit-trail extraFields). Aftermath adapter
 *    MUST be registered BEFORE this one.
 * 2. Hierarchical XLSX files (Monthly_Report.xlsx, Tap Rock) — different
 *    shape entirely; handled by its own adapter.
 * 3. Injection-only / tank-gauge columns — explicitly ignored via the
 *    SKIP_ALIASES set so we don't accidentally miscode a tank-balance
 *    number as production.
 *
 * Data-type classification
 * ------------------------
 * We infer daily vs monthly from two signals:
 *   a. Filename — "daily" / "dailies" → daily; "monthly" → monthly.
 *   b. Date pattern — all dates are first-of-month → monthly;
 *      varied within a month / per-well dates → daily.
 * When the two disagree, DATA WINS (filename is often wrong — e.g. a file
 * named "Monthly Production.csv" with daily rows).
 */

import type { FormatAdapter, ParserContext, ProductionRecord } from './types.js';
import { normalizeApi } from './apiNormalization.js';

/* ════════════════════════════════════════════════════════════════
 * SECTION 1 — Alias dictionary
 * Maps every label we've ever seen to a canonical field name.
 * All keys are normalized (trimmed, uppercased, spaces collapsed,
 * dots and parentheticals stripped) before lookup. See normalize().
 * ════════════════════════════════════════════════════════════════ */

type CanonicalField =
  | 'prodDate'
  | 'api'
  | 'api14'
  | 'wellName'
  | 'wellId'
  | 'completionNo'
  | 'chosenId'
  | 'oilProd'
  | 'oilSales'
  | 'gasProd'
  | 'gasSales'
  | 'waterProd'
  | 'waterInj'
  | 'tubingPres'
  | 'casingPres'
  | 'choke'
  | 'hoursDown'
  | 'hoursOn'
  | 'daysOn'
  | 'downtimeReason'
  | 'mmbtu'
  | 'btu'
  | 'bhp'
  | 'oilBegin'
  | 'oilEnd'
  | 'oilCum'
  | 'gasCum'
  | 'gasInj'
  | 'daysInj'
  | 'ownerId'
  | 'ownerName'
  | 'producingStatus'
  | 'wellStatus'
  | 'pressureBase'
  | 'reservoir'
  | 'inptId'
  | 'ariesId'
  | 'phdwinId'
  | 'check'
  | 'wellNumber'
  | 'opTimeHours'
  | 'ignore';

// Fields that make it into the ProductionRecord directly (plus the ID fields).
const MAPPED_FIELDS = new Set<CanonicalField>([
  'prodDate',
  'api',
  'api14',
  'wellName',
  'wellId',
  'completionNo',
  'chosenId',
  'oilProd',
  'oilSales',
  'gasProd',
  'gasSales',
  'waterProd',
  'waterInj',
  'tubingPres',
  'casingPres',
  'choke',
  'hoursDown',
  'hoursOn',
  'daysOn',
  'downtimeReason',
]);

// Fields we recognize but stash in extraFields rather than mapping to
// a template column (metadata, cumulative totals, tank gauges, etc.).
const METADATA_FIELDS = new Set<CanonicalField>([
  'mmbtu',
  'btu',
  'bhp',
  'oilBegin',
  'oilEnd',
  'oilCum',
  'gasCum',
  'gasInj',
  'daysInj',
  'ownerId',
  'ownerName',
  'producingStatus',
  'wellStatus',
  'pressureBase',
  'reservoir',
  'inptId',
  'ariesId',
  'phdwinId',
  'check',
  'wellNumber',
  'opTimeHours',
]);

/**
 * The alias table — left side is the *normalized* header string we might
 * encounter; right side is the canonical field name.
 *
 * Normalized form rules (applied to both keys here and live headers):
 *   - uppercase
 *   - trim
 *   - collapse runs of whitespace to one space
 *   - remove periods ('.'), commas (','), parens + their contents "(...)"
 *   - remove "#" and "/"
 *   - keep letters, digits, single spaces
 *
 * Example: "Tubing Press." → "TUBING PRESS"
 *          "Oil (BBL/D)"    → "OIL"     (parens stripped)
 *          "Well Param P(tub) (psi)" → "WELL PARAM PTUB"  (we keep inner parens if embedded in a word — see normalize)
 */
const ALIASES: Record<string, CanonicalField> = {
  /* Date */
  'PRODDATE':            'prodDate',
  'PROD DATE':           'prodDate',
  'PRODUCTION DATE':     'prodDate',
  'DATE':                'prodDate',
  'MONTH':               'prodDate',

  /* API (10 or 14 digits, often scientific notation when Excel exports) */
  'API':                 'api',
  'API WELL NUMBER':     'api',
  'API10':               'api',
  'API 10':              'api',
  'UNIT API 14':         'api14',
  'API14':               'api14',
  'API 14':              'api14',

  /* Well name */
  'WELL NAME':           'wellName',
  'WELLNAME':            'wellName',
  'NAME':                'wellName',
  'COMPLETION NAME':     'wellName',
  'COMPETION NAME':      'wellName',         // sic — typo observed in Sig 4
  'COMPLETION WELL NAME DATE': 'wellName',   // hierarchical-style compound header
  'WELL SITE':           'wellName',         // BTA XLSX; also appears in CSV Sig 8
  'SELECTED ITEM':       'wellName',         // Link VJ daily
  'INVESTOR':            'wellName',         // BTA WIO

  /* Well identifiers */
  'WELL ID':             'wellId',
  'WELLID':              'wellId',
  'COMPLETION NO':       'completionNo',
  'COMP NO':             'completionNo',
  'COMPNO':              'completionNo',
  'COMP ID':             'completionNo',
  'COMPL ID':            'completionNo',
  'COMPLID':             'completionNo',
  'CHOSEN ID':           'chosenId',
  'CHOSENID':            'chosenId',
  'CHOOSEN':             'chosenId',         // sic — typo observed in Sig 12
  'CHOOSEN ID':          'chosenId',

  /* Volumes — OIL */
  'OIL PROD':            'oilProd',
  'OILPROD':             'oilProd',
  'OIL PRODUCTION':      'oilProd',
  'OIL':                 'oilProd',
  'OIL BBL':             'oilProd',
  'OIL BBLD':            'oilProd',
  'GROSS OIL':           'oilProd',
  'TOTAL OIL':           'oilProd',
  'BOPD':                'oilProd',
  'ALLOC OIL BBL':       'oilProd',
  'ALLOC OIL':           'oilProd',
  'NEW PROD OIL BBL':    'oilProd',
  'NEW PROD OIL':        'oilProd',

  'OIL SALES':           'oilSales',
  'OILSALES':            'oilSales',
  'OIL SOLD':            'oilSales',
  'NET OIL':             'oilSales',
  'SALES OIL':           'oilSales',

  /* Volumes — GAS */
  'GAS PROD':            'gasProd',
  'GASPROD':             'gasProd',
  'GAS PRODUCTION':      'gasProd',
  'GAS':                 'gasProd',
  'GAS MCF':             'gasProd',
  'GAS MCFD':            'gasProd',
  'MCFPD':               'gasProd',
  'GROSS GAS':           'gasProd',
  'TOTAL GAS':           'gasProd',
  'GAS VOLUME':          'gasProd',
  'ALLOC GAS MCF':       'gasProd',
  'ALLOC GAS':           'gasProd',
  'NEW PROD GAS MCF':    'gasProd',
  'NEW PROD GAS':        'gasProd',

  'GAS SALES':           'gasSales',
  'GASSALES':            'gasSales',
  'GAS SOLD':            'gasSales',
  'NET GAS':             'gasSales',
  'SALES GAS':           'gasSales',
  'GAS DELIVERED':       'gasSales',

  /* Volumes — WATER */
  'WATER PROD':          'waterProd',
  'WATERPROD':           'waterProd',
  'WATER PRODUCTION':    'waterProd',
  'WATER':                'waterProd',
  'WATER BBL':           'waterProd',
  'WATER BBLD':          'waterProd',
  'BWPD':                'waterProd',
  'ALLOC WAT BBL':       'waterProd',
  'ALLOC WAT':           'waterProd',
  'ALLOC WATER BBL':     'waterProd',
  'ALLOC WATER':         'waterProd',

  'WATER INJ':           'waterInj',
  'WATERINJ':            'waterInj',
  'WATER INJECT':        'waterInj',
  'WATER INJECTION':     'waterInj',

  /* Pressures */
  'TUBING PRESSURE':     'tubingPres',
  'TUBING PRESS':        'tubingPres',   // "Tubing Press." → "TUBING PRESS"
  'TUBING':              'tubingPres',
  'THP':                 'tubingPres',
  'FTP':                 'tubingPres',

  'CASING PRESSURE':     'casingPres',
  'CASING PRESSURE1':    'casingPres',   // Link VJ Sig 23
  'CASING PRESS':        'casingPres',
  'CASING':              'casingPres',
  'CHP':                 'casingPres',
  'CP':                  'casingPres',

  'BHP':                 'bhp',
  'BOTTOMHOLE PRESSURE': 'bhp',
  'BOTTOM HOLE PRESSURE':'bhp',

  /* Choke */
  'CHOKE':               'choke',
  'CHOKE SIZE':          'choke',
  'CHOKE SIZE 64TH':     'choke',

  /* Downtime / uptime */
  'DOWNTIME':            'hoursDown',
  'DOWN TIME':           'hoursDown',
  'DOWN TIME HOURS':     'hoursDown',
  'DOWNTIME HOURS':      'hoursDown',
  'HOURS DOWN':          'hoursDown',
  'HOURS OFF':           'hoursDown',
  'DT HR':               'hoursDown',
  'HOURS ON':            'hoursOn',
  'OP TM HR':            'opTimeHours',
  'OPTIME HR':           'opTimeHours',
  'OP TIME HR':          'opTimeHours',
  'DOWNTIME REASON':     'downtimeReason',
  'DOWN TIME REASON':    'downtimeReason',
  'DOWNTIME NOTES':      'downtimeReason', // fold BTA's split reason+notes
  'DOWN TIME NOTES':     'downtimeReason',
  'DAYS ON':             'daysOn',
  'DAYSON':              'daysOn',
  'DAYS INJECTED':       'daysInj',

  /* Heating content / metadata */
  'BTU':                 'btu',
  'MMBTU':               'mmbtu',
  'MMBTUSALES':          'mmbtu',
  'MMBTU SALES':         'mmbtu',

  /* Tank gauges — MUST NOT map to Prod/Sales */
  'OIL BEGIN':           'oilBegin',
  'BEGIN OIL':           'oilBegin',
  'OILBEGIN':            'oilBegin',
  'OIL END':             'oilEnd',
  'END OIL':             'oilEnd',
  'OILEND':              'oilEnd',

  /* Cumulative — running totals, NOT periodic volumes */
  'OIL CUM':             'oilCum',
  'OILCUM':              'oilCum',
  'GAS CUM':             'gasCum',
  'GASCUM':              'gasCum',

  /* Injection volumes other than water */
  'GAS INJ':             'gasInj',
  'GASINJ':              'gasInj',
  'GAS INJECTION':       'gasInj',

  /* Misc operator/investor metadata */
  'OWNERID':             'ownerId',
  'OWNER ID':            'ownerId',
  'OWNERNAME':           'ownerName',
  'OWNER NAME':          'ownerName',
  'PRODUCING STATUS':    'producingStatus',
  'WELL STATUS':         'wellStatus',
  'PRESSURE BASE':       'pressureBase',
  'RESERVOIR':           'reservoir',
  'INPT ID':             'inptId',
  'ARIES ID':            'ariesId',
  'PHDWIN ID':           'phdwinId',
  'CHECK':               'check',
  'WELL NUMBER':         'wellNumber',
  'WELL NUM':            'wellNumber',
  'WELLNUM':             'wellNumber',
};

/* ════════════════════════════════════════════════════════════════
 * SECTION 2 — CSV splitting + small utils
 * (copied from aftermathDailiesCsv; kept local so this adapter has
 * zero internal cross-dependencies beyond ./types)
 * ════════════════════════════════════════════════════════════════ */

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
      else if (ch === '"') { inQuotes = false; }
      else { cur += ch; }
    } else if (ch === '"') { inQuotes = true; }
    else if (ch === ',') { out.push(cur); cur = ''; }
    else { cur += ch; }
  }
  out.push(cur);
  return out;
}

function splitCsvRows(csvText: string): string[] {
  const rows: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i];
    if (inQuotes) {
      if (ch === '"' && csvText[i + 1] === '"') { cur += '""'; i += 1; }
      else if (ch === '"') { inQuotes = false; cur += ch; }
      else { cur += ch; }
    } else if (ch === '"') { inQuotes = true; cur += ch; }
    else if (ch === '\r') { /* ignore */ }
    else if (ch === '\n') { rows.push(cur); cur = ''; }
    else { cur += ch; }
  }
  if (cur.length > 0) rows.push(cur);
  return rows;
}

/**
 * Normalize a header label for alias lookup.
 * Rules:
 *  - uppercase + trim
 *  - strip any "(...)" parenthetical group
 *  - remove periods, commas, "#", "/"
 *  - collapse runs of whitespace to single space
 */
function normalize(label: string): string {
  return label
    .replace(/\(.*?\)/g, ' ')
    .toUpperCase()
    .replace(/[.,#/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Parse a numeric token. Empty / non-numeric → null (NOT zero). */
function parseNum(token: string | undefined | null): number | null {
  if (token === null || token === undefined) return null;
  const trimmed = String(token).trim();
  if (trimmed === '' || trimmed === '.') return null;
  const cleaned = trimmed.replace(/,/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse an integer from scientific notation or plain digits.
 * "1.00E+14" → 100000000000000, "392398" → 392398.
 */
function parseSciInt(token: string | undefined | null): number | null {
  if (token === null || token === undefined) return null;
  const trimmed = String(token).trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

/** Digits only, project-convention API10. Delegates to shared normalizer.
 *  Note: Scientific-notation API values like "3.00E+13" already lose
 *  precision at the Excel layer — we can't recover the true 14-digit API
 *  from that float, so callers must still prefer a real 14-digit column
 *  over this helper when present. */
function toApi10(anyApi: string): string {
  return normalizeApi(anyApi).api10;
}

/** 10-digit → 14-digit with trailing zeros. Delegates to shared normalizer. */
function api10ToApi14(api10: string): string {
  return normalizeApi(api10).api14;
}

/**
 * Parse a date string into YYYY-MM-DD.
 * Accepts:
 *   - "M/D/YYYY", "M/D/YYYY H:MM", "M/D/YYYY 0:00"
 *   - "YYYY-MM-DD"
 *   - Excel serial numbers (numeric input like 45678) — via days-from-1899 math
 * Returns null if unparseable.
 */
function parseDateToIso(raw: string | number | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // Excel epoch (Windows): 1899-12-30 = serial 0
    const epoch = Date.UTC(1899, 11, 30);
    const ms = epoch + Math.round(raw) * 86400000;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return null;
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  const s = String(raw).trim();
  if (s === '') return null;
  // Strip a trailing time portion if present (e.g., "4/5/2026 0:00").
  const dateOnly = s.split(/\s+/)[0];
  // YYYY-MM-DD
  const iso = dateOnly.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    const [, y, m, d] = iso;
    const mi = Number(m), di = Number(d);
    if (mi >= 1 && mi <= 12 && di >= 1 && di <= 31) {
      return `${y}-${String(mi).padStart(2, '0')}-${String(di).padStart(2, '0')}`;
    }
  }
  // M/D/YYYY
  const mdy = dateOnly.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (mdy) {
    let [, mm, dd, yyyy] = mdy;
    if (yyyy.length === 2) yyyy = (Number(yyyy) > 50 ? '19' : '20') + yyyy;
    const mmi = Number(mm), ddi = Number(dd);
    if (mmi >= 1 && mmi <= 12 && ddi >= 1 && ddi <= 31) {
      return `${yyyy}-${String(mmi).padStart(2, '0')}-${String(ddi).padStart(2, '0')}`;
    }
  }
  return null;
}

/* ════════════════════════════════════════════════════════════════
 * SECTION 3 — Value type validators
 * Used by the drift-repair logic to decide whether a cell value is
 * plausible for a given field.
 * ════════════════════════════════════════════════════════════════ */

function looksLikeNumber(v: string): boolean {
  const t = String(v).trim().replace(/,/g, '');
  if (t === '' || t === '.') return false;
  const n = Number(t);
  return Number.isFinite(n);
}

function looksLikeDate(v: string): boolean {
  return parseDateToIso(v) !== null;
}

/** Accepts either raw digits (8–14) or scientific notation that floors to digits. */
function looksLikeApi(v: string): boolean {
  const t = String(v).trim();
  if (t === '') return false;
  // Digits with optional separators
  const digits = t.replace(/\D/g, '');
  if (digits.length >= 8 && digits.length <= 14) return true;
  // Scientific notation: 3.00E+13 and friends
  if (/^\d+(\.\d+)?[Ee][+-]?\d+$/.test(t)) return true;
  return false;
}

function looksLikeWellName(v: string): boolean {
  const t = String(v).trim();
  if (t === '') return false;
  // A well name must contain at least one letter. Pure digits → not a name.
  return /[A-Za-z]/.test(t);
}

/* ════════════════════════════════════════════════════════════════
 * SECTION 4 — Header → field index map
 * ════════════════════════════════════════════════════════════════ */

interface HeaderMap {
  /** Index of each canonical field we found, or -1 if absent. */
  ix: Partial<Record<CanonicalField, number>>;
  /** Normalized headers, same length as columns. */
  normalizedHeaders: string[];
  /** Raw headers as typed by operator (for debugging). */
  rawHeaders: string[];
  /** Columns we couldn't map to any canonical field (kept so we can
   *  stash their values in extraFields for audit). */
  unknownIndices: number[];
}

function buildHeaderMap(rawHeaders: string[]): HeaderMap {
  const normalized = rawHeaders.map(normalize);
  const ix: Partial<Record<CanonicalField, number>> = {};
  const unknownIndices: number[] = [];

  for (let i = 0; i < normalized.length; i++) {
    const norm = normalized[i];
    if (norm === '') { unknownIndices.push(i); continue; }
    const canonical = ALIASES[norm];
    if (!canonical) {
      // Try a looser "starts with" lookup — some headers have weird suffixes
      // like "Chosen ID (internal)" that normalize() can't always clean.
      const fuzzy = Object.keys(ALIASES).find((k) => norm.startsWith(k + ' ') || norm === k);
      if (fuzzy) {
        const f = ALIASES[fuzzy];
        if (ix[f] === undefined) ix[f] = i;   // first occurrence wins
      } else {
        unknownIndices.push(i);
      }
      continue;
    }
    // First occurrence of a canonical field wins; later duplicates fall
    // into unknownIndices (rare but defensive — some sheets have multiple
    // "Chosen ID"-style columns).
    if (ix[canonical] === undefined) ix[canonical] = i;
    else unknownIndices.push(i);
  }

  return { ix, normalizedHeaders: normalized, rawHeaders, unknownIndices };
}

/** Return the list of canonical fields this header map can populate. */
function mappedFieldsPresent(map: HeaderMap): CanonicalField[] {
  return (Object.keys(map.ix) as CanonicalField[]).filter((k) => MAPPED_FIELDS.has(k));
}

/* ════════════════════════════════════════════════════════════════
 * SECTION 5 — Detection
 * ════════════════════════════════════════════════════════════════ */

/**
 * Detect if a CSV is processable by this adapter.
 *
 * Minimum requirement: the header row contains
 *   - a date column, AND
 *   - at least one identity column (API or well name), AND
 *   - at least one production-volume column (oilProd / gasProd / waterProd / oilSales / gasSales)
 *
 * This is deliberately loose so we pick up unknown operator formats we
 * haven't seen yet but that clearly ARE production CSVs. Precision comes
 * from registry ORDER: Aftermath's tighter match runs first.
 */
export function canParseGenericProductionCsv(ctx: ParserContext): boolean {
  // Must look at the header row — preferring the dispatcher's sheetPreview,
  // falling back to a raw-buffer sniff for CSV files.
  let headerRow: string[] = [];
  if (ctx.sheetPreview && ctx.sheetPreview.length > 0) {
    headerRow = (ctx.sheetPreview[0] ?? []).map((c) => String(c ?? ''));
  } else if (ctx.fileKind === 'csv' && ctx.buffer?.length) {
    const head = ctx.buffer.toString('utf-8').slice(0, 4000);
    const firstLine = head.split(/\r?\n/)[0] ?? '';
    headerRow = splitCsvLine(firstLine);
  }
  if (headerRow.length === 0) return false;

  const map = buildHeaderMap(headerRow);
  const hasDate = map.ix.prodDate !== undefined;
  const hasIdentity =
    map.ix.api !== undefined ||
    map.ix.api14 !== undefined ||
    map.ix.wellName !== undefined ||
    map.ix.chosenId !== undefined;
  const hasVolume =
    map.ix.oilProd !== undefined ||
    map.ix.gasProd !== undefined ||
    map.ix.waterProd !== undefined ||
    map.ix.oilSales !== undefined ||
    map.ix.gasSales !== undefined;

  return hasDate && hasIdentity && hasVolume;
}

/* ════════════════════════════════════════════════════════════════
 * SECTION 6 — Drift repair for a single row
 * ════════════════════════════════════════════════════════════════ */

/**
 * Try to produce a "repaired" column array for a row whose values don't
 * line up with the header positions.
 *
 * Strategy:
 *   1. If no drift → return cols unchanged.
 *   2. Try a global shift of -2, -1, +1, +2. A shift is acceptable if
 *      the critical anchor cells (API and date) type-check after the shift.
 *   3. If no global shift works, return null — caller treats this as a
 *      parse failure for the row (will be added to `skipped`).
 *
 * We use API + date as anchors because they have the most distinctive
 * type signatures (digits vs parseable date). Once those align, the
 * volume columns should fall into place.
 *
 * Returns: { cols, shiftApplied } or null if unrecoverable.
 */
function repairRow(
  cols: string[],
  map: HeaderMap
): { cols: string[]; shiftApplied: number } | null {
  const iApi  = map.ix.api  ?? map.ix.api14 ?? -1;
  const iDate = map.ix.prodDate ?? -1;

  const checkFit = (shiftedCols: string[]): boolean => {
    const apiOk = iApi < 0 || looksLikeApi(shiftedCols[iApi] ?? '');
    const dateOk = iDate < 0 || looksLikeDate(shiftedCols[iDate] ?? '');
    return apiOk && dateOk;
  };

  if (checkFit(cols)) return { cols, shiftApplied: 0 };

  for (const shift of [-1, 1, -2, 2]) {
    const shifted = shift < 0
      // shift left: drop the first |shift| cells; pad with '' on the right
      ? [...cols.slice(-shift), ...Array.from({ length: -shift }, () => '')]
      // shift right: prepend |shift| empty cells; drop from the right
      : [...Array.from({ length: shift }, () => ''), ...cols.slice(0, cols.length - shift)];
    if (checkFit(shifted)) return { cols: shifted, shiftApplied: shift };
  }

  return null;
}

/* ════════════════════════════════════════════════════════════════
 * SECTION 7 — Row → ProductionRecord
 * ════════════════════════════════════════════════════════════════ */

interface ParseStats {
  totalRows: number;
  parsed: number;
  skipped: Array<{ rowNum: number; reason: string; rawFirst60: string }>;
  driftRepaired: number;
}

function parseRow(
  rawCols: string[],
  map: HeaderMap,
  stats: ParseStats,
  rowNum: number
): ProductionRecord | null {
  const repaired = repairRow(rawCols, map);
  if (!repaired) {
    stats.skipped.push({
      rowNum,
      reason: 'row drift could not be resolved (API and/or date don\'t type-check at any ±2 shift)',
      rawFirst60: rawCols.slice(0, 6).join(',').slice(0, 60),
    });
    return null;
  }
  const cols = repaired.cols;
  if (repaired.shiftApplied !== 0) stats.driftRepaired += 1;

  const get = (field: CanonicalField): string => {
    const i = map.ix[field];
    if (i === undefined || i < 0) return '';
    return String(cols[i] ?? '').trim();
  };

  /* ── Identity fields — need at least (API or api14 or wellName) + date ── */
  const apiRaw   = get('api');
  const api14Raw = get('api14');
  const wellName = get('wellName');
  const dateRaw  = get('prodDate');
  const chosenId = get('chosenId');

  if (!dateRaw) {
    stats.skipped.push({ rowNum, reason: 'missing date', rawFirst60: cols.slice(0, 6).join(',').slice(0, 60) });
    return null;
  }
  const prodDate = parseDateToIso(dateRaw);
  if (!prodDate) {
    stats.skipped.push({ rowNum, reason: `unparseable date "${dateRaw}"`, rawFirst60: cols.slice(0, 6).join(',').slice(0, 60) });
    return null;
  }

  // Derive API14 / API10 with priority:
  //   1) explicit api14 column if present (most precise)
  //   2) api column
  //   3) chosen id column (often mirrors API10)
  // Scientific-notation values like "3.00E+13" lose precision — skip them
  // when a cleaner value exists.
  let api14 = '';
  let api10 = '';
  const cleanDigits = (s: string) => s.replace(/\D/g, '');
  const isSci = (s: string) => /^\d+(\.\d+)?[Ee][+-]?\d+$/.test(s.trim());

  const candidates = [api14Raw, apiRaw, chosenId].filter((v) => v !== '');
  // Prefer a candidate with >= 10 clean digits before falling back to sci-notation.
  const goodCandidate = candidates.find((c) => !isSci(c) && cleanDigits(c).length >= 10);
  const fallbackCandidate = candidates.find((c) => c !== '');
  const apiSource = goodCandidate || fallbackCandidate || '';

  if (apiSource) {
    // Single shared normalizer handles 8/10/12/14-digit inputs correctly.
    const pair = normalizeApi(apiSource);
    api10 = pair.api10;
    api14 = pair.api14;
  }

  if (!api10 && !wellName) {
    stats.skipped.push({ rowNum, reason: 'missing both API and well name', rawFirst60: cols.slice(0, 6).join(',').slice(0, 60) });
    return null;
  }

  /* ── Volumes ── */
  const oilProd   = parseNum(get('oilProd'));
  const oilSales  = parseNum(get('oilSales'));
  const gasProd   = parseNum(get('gasProd'));
  const gasSales  = parseNum(get('gasSales'));
  const waterProd = parseNum(get('waterProd'));
  const waterInj  = parseNum(get('waterInj'));

  // Must have at least ONE volume reading (otherwise this row is noise).
  const anyVolume = [oilProd, oilSales, gasProd, gasSales, waterProd, waterInj]
    .some((v) => v !== null);
  if (!anyVolume) {
    stats.skipped.push({ rowNum, reason: 'row contains no production volumes', rawFirst60: cols.slice(0, 6).join(',').slice(0, 60) });
    return null;
  }

  /* ── Pressures / choke / downtime ── */
  const tubingPres = parseNum(get('tubingPres'));
  const casingPres = parseNum(get('casingPres'));
  const chokeRaw   = get('choke');
  const choke      = chokeRaw === '' ? null : chokeRaw;  // keep "64/64" strings as-is
  const hoursDown  = parseNum(get('hoursDown'));
  const hoursOn    = parseNum(get('hoursOn'));
  const daysOn     = parseNum(get('daysOn'));
  const reasonRaw  = get('downtimeReason');
  const downtimeReason = reasonRaw === '' ? null : reasonRaw;

  // If the sheet exposes "Hours On" but not "Hours Down", leave hoursDown
  // null and stash hoursOn in extraFields; we don't invert without knowing
  // the length of the reporting period (daily vs monthly).
  const extraFields: Record<string, unknown> = {
    genericCsvUsed: true,
    driftShift: repaired.shiftApplied,
  };
  if (hoursOn !== null) extraFields.hoursOn = hoursOn;

  /* ── Metadata columns — collect for audit ── */
  for (const field of Object.keys(map.ix) as CanonicalField[]) {
    if (!METADATA_FIELDS.has(field)) continue;
    const i = map.ix[field];
    if (i === undefined) continue;
    const v = String(cols[i] ?? '').trim();
    if (v === '') continue;
    extraFields[`meta_${field}`] = v;
  }

  // Preserve raw values from unknown columns too, keyed by their header name.
  for (const ui of map.unknownIndices) {
    const headerName = map.rawHeaders[ui]?.trim() || `col_${ui}`;
    const v = String(cols[ui] ?? '').trim();
    if (v === '') continue;
    const safeKey = `raw_${headerName.replace(/[^A-Za-z0-9]/g, '_').slice(0, 40)}`;
    extraFields[safeKey] = v;
  }

  /* ── Operator/Well IDs ── */
  const wellIdRaw = get('wellId');
  const completionNoRaw = get('completionNo');

  return {
    api14,
    api10,
    wellName: wellName || '', // empty string ok — storage layer can still upsert by API
    combocurveWellId: null,
    operatorWellId: parseSciInt(wellIdRaw),
    prodDate,
    oilProd,
    gasProd,
    waterProd,
    gasSales,
    oilSales,
    waterInj,
    daysOn,
    choke,
    tubingPres,
    casingPres,
    hoursDown,
    downtimeReason,
    extraFields: {
      ...extraFields,
      operatorWellIdRaw: wellIdRaw || null,
      completionNoRaw: completionNoRaw || null,
      chosenIdRaw: chosenId || null,
    },
  };
}

/* ════════════════════════════════════════════════════════════════
 * SECTION 8 — Daily vs monthly classification
 * ════════════════════════════════════════════════════════════════ */

function classifyDataType(
  filename: string,
  records: ProductionRecord[]
): 'daily' | 'monthly' {
  // Signal 1 — filename hint
  const lower = filename.toLowerCase();
  const nameSaysDaily = /\b(daily|dailies)\b/.test(lower);
  const nameSaysMonthly = /\b(monthly|month)\b/.test(lower);

  // Signal 2 — date cadence inspection
  // Bucket dates by "YYYY-MM" and look at unique day counts.
  const byMonth = new Map<string, Set<number>>();
  for (const r of records) {
    const ym = r.prodDate.slice(0, 7);
    const day = Number(r.prodDate.slice(8, 10));
    if (!byMonth.has(ym)) byMonth.set(ym, new Set());
    byMonth.get(ym)!.add(day);
  }
  // If >70% of months have only 1 unique day seen (and that day is 1 or the
  // last day of that month), we're looking at monthly rows.
  let monthlyLike = 0;
  let dailyLike = 0;
  for (const days of byMonth.values()) {
    if (days.size === 1) monthlyLike += 1;
    else if (days.size >= 10) dailyLike += 1;
  }
  const dataSaysMonthly = monthlyLike > 0 && dailyLike === 0;
  const dataSaysDaily = dailyLike > 0;

  if (dataSaysDaily) return 'daily';
  if (dataSaysMonthly) return 'monthly';
  // Ambiguous middle ground — fall back to filename.
  if (nameSaysDaily) return 'daily';
  if (nameSaysMonthly) return 'monthly';
  // Last resort: treat as daily (preserves granularity; never rolls up).
  return 'daily';
}

/* ════════════════════════════════════════════════════════════════
 * SECTION 9 — Public parse entry point
 * ════════════════════════════════════════════════════════════════ */

export interface GenericCsvParseResult {
  records: ProductionRecord[];
  dataType: 'daily' | 'monthly';
  stats: ParseStats;
  headerMap: HeaderMap;
}

/**
 * Parse a CSV string. Returns full parse result including diagnostic
 * stats — useful for tests. The adapter's parse() method just returns
 * records[].
 */
export function parseGenericProductionCsv(
  csvText: string,
  filename = ''
): GenericCsvParseResult {
  const rows = splitCsvRows(csvText).filter((r) => r.trim() !== '');
  if (rows.length < 2) {
    throw new Error('CSV has no data rows.');
  }

  const rawHeaders = splitCsvLine(rows[0]).map((h) => h.trim());
  const headerMap = buildHeaderMap(rawHeaders);
  const mapped = mappedFieldsPresent(headerMap);
  if (!mapped.includes('prodDate')) {
    throw new Error(
      `Generic CSV parser could not locate a date column. Headers: [${rawHeaders.join(', ')}]`
    );
  }

  const stats: ParseStats = { totalRows: rows.length - 1, parsed: 0, skipped: [], driftRepaired: 0 };
  const records: ProductionRecord[] = [];

  for (let r = 1; r < rows.length; r++) {
    const line = rows[r];
    if (line.trim() === '') continue;
    const cols = splitCsvLine(line).map((c) => c.trim());
    // Blank-row guard: some exports (Pierogi, Flea Flicker, etc.) pad
    // the bottom of the file with dozens of `,,,,,` rows. Treat those
    // as silent EOF markers — do NOT count them as skipped.
    if (cols.every((c) => c === '')) continue;
    const rec = parseRow(cols, headerMap, stats, r + 1);
    if (rec) {
      records.push(rec);
      stats.parsed += 1;
    }
  }

  if (records.length === 0) {
    const firstSkip = stats.skipped[0];
    throw new Error(
      `Generic CSV parser produced zero records out of ${stats.totalRows} data rows. ` +
        `First skip: row ${firstSkip?.rowNum} — ${firstSkip?.reason}`
    );
  }

  const dataType = classifyDataType(filename, records);
  return { records, dataType, stats, headerMap };
}

/* ════════════════════════════════════════════════════════════════
 * SECTION 10 — FormatAdapter registration
 * ════════════════════════════════════════════════════════════════
 *
 * IMPORTANT — registry order:
 *   This adapter is deliberately loose on detect() to catch unknown
 *   operator CSVs. Register it AFTER any stricter CSV adapter (e.g.
 *   aftermathDailiesCsvAdapter) so those win on their own signatures.
 */

// We need the parse() return type to be ProductionRecord[], but the
// adapter also needs to decide daily vs monthly at dispatch time so the
// dispatcher's ParserOutcome.dataType is correct. Since FormatAdapter
// has readonly `dataType`, we expose a small classifyAndParse() helper
// on this module that the dispatcher (or the test harness) can call
// directly when it wants the classified type. For the registry, we
// pick 'daily' as the default dataType — this is the safest choice
// because daily data never rolls up into monthly (per project spec),
// and the actual type is re-determined from the records during parse.

export const genericProductionCsvAdapter: FormatAdapter & {
  /** Extra entry point: parse and classify in one call. */
  parseWithClassification: (ctx: ParserContext) => Promise<GenericCsvParseResult>;
} = {
  name: 'Generic Production CSV',
  operatorName: 'Various (Frio family and partner reports)',
  // NOTE: registry uses this, but the dispatcher will override from the
  // classification in parseWithClassification when available. See
  // parsers/index.ts for how this is wired.
  dataType: 'daily',
  fileKinds: ['csv'] as const,

  detect(ctx: ParserContext): boolean {
    if (ctx.fileKind !== 'csv') return false;
    // Filename guard: explicitly named templates/mappings/samples shouldn't
    // be ingested even though they have production-shaped columns. If one
    // of those files accidentally lands in the intake, we want it FLAGGED
    // as unrecognized so Caleb sees it on the dashboard, not quietly
    // absorbed as "real" data.
    // Underscores are word chars in regex, so we normalize them to spaces
    // before doing word-boundary matching. Otherwise "Prod_Template" slips
    // past `\btemplate\b`.
    const lowerNorm = ctx.filename.toLowerCase().replace(/[_\-.]/g, ' ');
    if (/\btemplate\b|\bsample\b|\bmapping\b|\bwell (list|database)\b/.test(lowerNorm)) {
      return false;
    }
    return canParseGenericProductionCsv(ctx);
  },

  async parse(ctx: ParserContext): Promise<ProductionRecord[]> {
    const text = ctx.buffer.toString('utf-8');
    const result = parseGenericProductionCsv(text, ctx.filename);
    return result.records;
  },

  async parseWithClassification(ctx: ParserContext): Promise<GenericCsvParseResult> {
    const text = ctx.buffer.toString('utf-8');
    return parseGenericProductionCsv(text, ctx.filename);
  },
};
