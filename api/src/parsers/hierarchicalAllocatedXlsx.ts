/**
 * Parser: Hierarchical Allocated-Production XLSX  (covers Formats 10 + 35)
 * -------------------------------------------------------------------------
 * ONE adapter that covers three distinct file sources because they all share
 * the same hierarchical "well-name row → indented date rows" layout:
 *
 *   1. Tap Rock Partner Report                (2026.03.03/04.03 Tap Rock Partner Report *.xlsx)
 *   2. West Pecos Partner Report              (PARTNER REPORT - WEST PECOS.xlsx)
 *   3. Gretchen / EFG STATE Monthly Report    (Monthly Report.xlsx)
 *
 * Shared structure (verified across all 4 real sample files):
 *   Row 0 = workbook metadata ("Partner Report" or "Daily Production"
 *           + "Printed: ..." + "Date: ... to ...")
 *   Row 1 = column headers (row-0-text is ignored; row-1 is truth)
 *   Row 2..N =
 *       well-identity row: col 0 is the well name, col 2 is BLANK,
 *                          col 4+ hold the well's monthly totals
 *       date rows: col 0 is an indented date ("    3/1/2026"),
 *                  col 2 is the 14-digit API (Tap Rock/West Pecos)
 *                  OR also blank (Monthly Report has NO API anywhere)
 *                  col 4+ hold that day's production volumes
 *   Last row = blank padding row (not always present)
 *
 * Quirks handled:
 *   - Column-1/3/10/12 are always blank spacers. Ignored safely via header map.
 *   - Well-identity rows emit NO daily record (they are monthly totals; a
 *     separate monthly-roll-up feature can surface them later — for now we
 *     store daily detail only, matching project "never aggregate" rule).
 *   - Dates are strings with 4 leading spaces ("    3/1/2026"). Trimmed.
 *   - Monthly Report.xlsx has NO API column. When API is missing, api10/api14
 *     are left empty strings; downstream well_name_aliases lookup handles
 *     resolution. Record is still emitted — never dropped for missing API
 *     (that's a data-quality issue to flag, not a reason to lose volumes).
 *   - Negative Oil values (e.g. EFG STATE 3/26/2026 -3.11) are allocation
 *     corrections — stored as-is per project convention.
 *   - "DT (hr)" (down time hours) → canonical hoursDown.
 *   - "OpTm (hr)" (operating time hours) is NOT in ComboCurve template;
 *     kept in extraFields.opTmHr for future use.
 *   - "Well Param Chk Sz (1/64\")" is the choke (an integer like 42 meaning
 *     42/64"). Stored as string to preserve operator-reported format.
 *   - "Well Param P(tub)" → tubingPres; "Well Param P(cas)" → casingPres.
 *
 * Data type classification (daily vs monthly):
 *   - All three files emit DAILY date rows. So dataType='daily' statically.
 *   - The well-identity rows (monthly totals) are preserved in extraFields.
 *     wellTotalBlock of the FIRST daily record for each well — so the monthly
 *     operator number isn't lost if the user later wants to spot-check it.
 */

import * as XLSX from 'xlsx';
import type { FormatAdapter, ParserContext, ProductionRecord } from './types.js';

/* ────────────────────────────────────────────────────────────────
 * Utilities (kept local — no dependency on other adapter files).
 * ──────────────────────────────────────────────────────────────── */

function parseNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (s === '') return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function toApi10(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  const digits = String(raw).replace(/\D/g, '');
  if (digits === '') return '';
  return digits.slice(0, 10).padStart(10, '0');
}

function api10ToApi14(api10: string): string {
  const digits = api10.replace(/\D/g, '');
  if (digits === '') return '';
  if (digits.length >= 14) return digits.slice(0, 14);
  return digits.padEnd(14, '0');
}

/** Parse an indented-date cell like "    3/1/2026" or a plain Date/serial. */
function toIsoDateMaybe(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;

  // Excel serial number
  if (typeof v === 'number' && Number.isFinite(v) && v > 1000) {
    const parts = XLSX.SSF.parse_date_code(v);
    if (!parts) return null;
    return `${parts.y}-${String(parts.m).padStart(2, '0')}-${String(parts.d).padStart(2, '0')}`;
  }

  // JS Date instance
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const yyyy = v.getFullYear();
    const mm = String(v.getMonth() + 1).padStart(2, '0');
    const dd = String(v.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  // Whitespace-prefixed M/D/YYYY string
  const s = String(v).trim();
  if (s === '') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const mdy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (mdy) {
    let [, mm, dd, yyyy] = mdy;
    if (yyyy.length === 2) yyyy = (Number(yyyy) > 50 ? '19' : '20') + yyyy;
    const mmi = Number(mm);
    const ddi = Number(dd);
    if (mmi < 1 || mmi > 12 || ddi < 1 || ddi > 31) return null;
    return `${yyyy}-${String(mmi).padStart(2, '0')}-${String(ddi).padStart(2, '0')}`;
  }
  return null;
}

function normHeader(s: unknown): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[\u00a0\s]+/g, ' ')
    .trim();
}

/* ────────────────────────────────────────────────────────────────
 * Canonical column slots we can pick from the header row.
 * ──────────────────────────────────────────────────────────────── */

type CanonicalCol =
  | 'nameOrDate' // col 0 — dual-role: well name on parent rows, date on child rows
  | 'api'
  | 'opTmHr' // extra metadata (hours up)
  | 'hoursDown'
  | 'oilProd'
  | 'gasProd'
  | 'waterProd'
  | 'choke'
  | 'tubingPres'
  | 'casingPres';

const HEADER_MAP: Record<string, CanonicalCol> = {
  'completion well name/date': 'nameOrDate',
  'completion name/date': 'nameOrDate',
  'well name/date': 'nameOrDate',

  'unit api - 14': 'api',
  'unit api': 'api',
  'api': 'api',
  'api #': 'api',
  'api#': 'api',
  'api 14': 'api',
  'api14': 'api',

  'optm (hr)': 'opTmHr',
  'op tm (hr)': 'opTmHr',
  'operating time (hr)': 'opTmHr',

  'dt (hr)': 'hoursDown',
  'down time (hr)': 'hoursDown',
  'down time hours': 'hoursDown',
  'downtime (hr)': 'hoursDown',
  'hours down': 'hoursDown',

  'alloc oil (bbl)': 'oilProd',
  'alloc oil': 'oilProd',
  'oil (bbl)': 'oilProd',

  'alloc gas (mcf)': 'gasProd',
  'alloc gas': 'gasProd',
  'new prod gas (mcf)': 'gasProd',
  'new prod gas': 'gasProd',
  'gas (mcf)': 'gasProd',

  'alloc wat (bbl)': 'waterProd',
  'alloc wat': 'waterProd',
  'alloc water (bbl)': 'waterProd',
  'alloc water': 'waterProd',
  'water (bbl)': 'waterProd',

  'well param chk sz (1/64")': 'choke',
  'well param chk sz': 'choke',
  'chk sz (1/64")': 'choke',
  'chk sz': 'choke',
  'choke': 'choke',

  'well param p(tub) (psi)': 'tubingPres',
  'well param p(tub)': 'tubingPres',
  'p(tub) (psi)': 'tubingPres',
  'p(tub)': 'tubingPres',
  'tubing pressure': 'tubingPres',
  'tubing': 'tubingPres',

  'well param p(cas) (psi)': 'casingPres',
  'well param p(cas)': 'casingPres',
  'p(cas) (psi)': 'casingPres',
  'p(cas)': 'casingPres',
  'casing pressure': 'casingPres',
  'casing': 'casingPres',
};

/* ────────────────────────────────────────────────────────────────
 * Core parser
 * ──────────────────────────────────────────────────────────────── */

export function parseHierarchicalAllocatedXlsx(buf: Buffer): ProductionRecord[] {
  const wb = XLSX.read(buf, { type: 'buffer' });
  if (wb.SheetNames.length === 0) {
    throw new Error('Hierarchical Allocated XLSX: no sheets in workbook');
  }

  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: '',
    raw: true,
  });

  if (rows.length < 3) {
    throw new Error(
      `Hierarchical Allocated XLSX: only ${rows.length} row(s) — expected at least 3 (metadata + headers + data)`
    );
  }

  // Row 1 is the header row (row 0 is the workbook title metadata).
  const headerRow = rows[1] as unknown[];
  const headers = headerRow.map(normHeader);

  // Build column index → canonical map. First-occurrence-wins.
  const colMap = new Map<number, CanonicalCol>();
  const usedCanonicals = new Set<CanonicalCol>();
  headers.forEach((h, idx) => {
    const canonical = HEADER_MAP[h];
    if (canonical && !usedCanonicals.has(canonical)) {
      colMap.set(idx, canonical);
      usedCanonicals.add(canonical);
    }
  });

  // Reverse-lookup helper: get column index for a canonical slot (or -1).
  const colIdxOf = (canonical: CanonicalCol): number => {
    for (const [idx, c] of colMap) if (c === canonical) return idx;
    return -1;
  };

  const nameOrDateIdx = colIdxOf('nameOrDate');
  if (nameOrDateIdx === -1) {
    throw new Error(
      `Hierarchical Allocated XLSX: no "Completion Name/Date" column in header row. Got: [${headers.join(', ')}]`
    );
  }
  if (colIdxOf('oilProd') === -1 && colIdxOf('gasProd') === -1 && colIdxOf('waterProd') === -1) {
    throw new Error(
      `Hierarchical Allocated XLSX: no production volume column in header row. Got: [${headers.join(', ')}]`
    );
  }

  const apiIdx = colIdxOf('api'); // may be -1 if Monthly_Report

  const records: ProductionRecord[] = [];
  let currentWellName = '';
  let currentWellApi = ''; // captured from first date row under a well
  let currentWellTotalBlock: Record<string, unknown> | null = null;
  let firstRecordForCurrentWell = true;

  for (let i = 2; i < rows.length; i++) {
    const row = rows[i] as unknown[];

    // Fully-blank row — end of well block OR trailing padding. Reset.
    if (row.every((c) => c === '' || c === null || c === undefined)) {
      currentWellTotalBlock = null;
      firstRecordForCurrentWell = true;
      continue;
    }

    const col0 = row[nameOrDateIdx];
    const maybeDate = toIsoDateMaybe(col0);

    if (maybeDate === null) {
      // This is a WELL-IDENTITY ROW (parent) — col 0 is the well name.
      const wellName = String(col0 ?? '').trim();
      if (wellName === '') continue; // weird whitespace-only row
      currentWellName = wellName;
      currentWellApi = ''; // will be captured from first date row

      // Capture monthly totals as a snapshot so they flow through extraFields
      // of the first daily record we emit for this well.
      const totals: Record<string, unknown> = {};
      for (const [idx, canonical] of colMap) {
        if (canonical === 'nameOrDate') continue;
        const v = row[idx];
        if (v !== '' && v !== null && v !== undefined) {
          totals[canonical] = v;
        }
      }
      currentWellTotalBlock = Object.keys(totals).length > 0 ? totals : null;
      firstRecordForCurrentWell = true;
      continue;
    }

    // DATE ROW — emit a daily ProductionRecord for the current well.
    if (!currentWellName) {
      // Date row with no parent well context — skip but don't throw. Likely
      // a malformed export; we don't want to lose the rest of the file.
      continue;
    }

    // Capture API from the first date row under the current well (Tap Rock /
    // West Pecos). Monthly_Report has no API column at all.
    if (apiIdx !== -1 && !currentWellApi) {
      const rawApi = String(row[apiIdx] ?? '').trim();
      if (rawApi !== '') currentWellApi = rawApi;
    }

    const api10 = currentWellApi ? toApi10(currentWellApi) : '';
    const api14 = api10 ? api10ToApi14(api10) : '';

    const get = (canonical: CanonicalCol): unknown => {
      const idx = colIdxOf(canonical);
      return idx === -1 ? undefined : row[idx];
    };

    const extraFields: Record<string, unknown> = {};
    const opTm = parseNum(get('opTmHr'));
    if (opTm !== null) extraFields.opTmHr = opTm;
    if (firstRecordForCurrentWell && currentWellTotalBlock) {
      extraFields.wellTotalBlock = currentWellTotalBlock;
      firstRecordForCurrentWell = false;
    }

    records.push({
      api14,
      api10,
      wellName: currentWellName,
      combocurveWellId: null,
      operatorWellId: null,
      prodDate: maybeDate,
      oilProd: parseNum(get('oilProd')),
      gasProd: parseNum(get('gasProd')),
      waterProd: parseNum(get('waterProd')),
      oilSales: null, // not reported in allocated format — never 0
      gasSales: null,
      waterInj: null,
      daysOn: null,
      choke: (() => {
        const v = get('choke');
        if (v === undefined || v === '' || v === null) return null;
        return String(v).trim() || null;
      })(),
      tubingPres: parseNum(get('tubingPres')),
      casingPres: parseNum(get('casingPres')),
      hoursDown: parseNum(get('hoursDown')),
      downtimeReason: null,
      extraFields,
    });
  }

  return records;
}

/* ────────────────────────────────────────────────────────────────
 * Adapter registration
 * ──────────────────────────────────────────────────────────────── */

export const hierarchicalAllocatedXlsxAdapter: FormatAdapter = {
  name: 'Hierarchical Allocated Production XLSX',
  operatorName: 'Various (Tap Rock / West Pecos / EFG)',
  dataType: 'daily',
  fileKinds: ['xlsx', 'xls'],

  detect(ctx: ParserContext): boolean {
    if (!ctx.sheetPreview || ctx.sheetPreview.length < 2) return false;
    // Row 1 has the column headers — that's the reliable signature.
    const headerRow = (ctx.sheetPreview[1] ?? []).map(normHeader);
    if (headerRow.length === 0) return false;

    const hasNameOrDateCol = headerRow.some(
      (h) => h === 'completion well name/date' || h === 'completion name/date' || h === 'well name/date'
    );
    if (!hasNameOrDateCol) return false;

    // Must also have an "Alloc" volume column OR the Monthly_Report's
    // "New Prod Gas" variant — these prevent false-positives from random
    // workbooks that happen to have a name/date header.
    const hasAllocOrNewProd = headerRow.some(
      (h) => /\balloc\s+(oil|gas|wat|water)\b/.test(h) || /\bnew prod gas\b/.test(h)
    );
    return hasAllocOrNewProd;
  },

  async parse(ctx: ParserContext): Promise<ProductionRecord[]> {
    return parseHierarchicalAllocatedXlsx(ctx.buffer);
  },
};
