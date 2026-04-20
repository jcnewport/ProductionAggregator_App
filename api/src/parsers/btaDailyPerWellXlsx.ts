/**
 * Parser: BTA Daily Per-Well Sheets XLSX  (Format 9)
 * ----------------------------------------------------
 * Source format:
 *   - March 2026 Daily Production.xlsx  (from BTA Oil Producers)
 *   - Any future workbook with one sheet per well, "Well Site" column compound,
 *     and BTA's specific daily header row.
 *
 * Operator:  BTA Oil Producers, LLC
 * Data type: DAILY production
 *
 * Workbook shape (verified across all 4 sheets of the March 2026 sample):
 *   Multi-sheet workbook, one sheet per well:
 *     "Hideout 1H", "Hideout 2H", "Box Elder 3H", "Box Elder 4H"
 *   Every sheet has the SAME header row:
 *     [0] Well Site | Date | Oil | Gas | Water | Tubing Pressure |
 *         Casing Pressure | Choke | Down Time Hours | Down Time Reason |
 *         Down Time Notes
 *   Rows 1..N = one per day (~31 days for a full month).
 *   Last row: ["Grand Total ", null, null, ...] — MUST be filtered out.
 *
 * Quirks the parser handles:
 *   1. "Well Site" is a compound field, e.g.:
 *        "Hideout 24-13 State Com #1H (PSHA) - 2211506"
 *      Broken down into:
 *        wellName       = "Hideout 24-13 State Com #1H"
 *        extraFields.wellSiteCode       = "PSHA"   (from parens)
 *        operatorWellId = 2211506       (number after the dash)
 *      The raw compound is also saved as extraFields.rawWellSite for audit.
 *   2. Date is an Excel serial number (e.g. 46082 → 2026-03-01).
 *   3. NO API NUMBER anywhere in the file. Leave api10 and api14 as empty
 *      strings — downstream well_name_aliases table resolves the well.
 *   4. NO Oil/Gas Sales columns. Stored as null, NEVER 0.
 *   5. Choke arrives as string "64/64" — preserved verbatim.
 *   6. "Grand Total" summary row at the bottom of each sheet — detect by
 *      the Well Site cell containing "grand total" (case-insensitive) OR
 *      a blank Date cell, and skip.
 *   7. "Down Time Notes" is a free-text column NOT in the ComboCurve template.
 *      Concatenated with "Down Time Reason" when both are present:
 *        downtimeReason = "Gas Plant Down — shut in due to pm"
 *      If only one of the two is present, that one's used verbatim.
 *
 * Separation of concerns:
 *   - exportable `parseBtaDailyPerWellXlsx(buffer)` for tests
 *   - registered `btaDailyPerWellXlsxAdapter` for the dispatcher
 */

import * as XLSX from 'xlsx';
import type { FormatAdapter, ParserContext, ProductionRecord } from './types.js';

/* ────────────────────────────────────────────────────────────────
 * Local utilities
 * ──────────────────────────────────────────────────────────────── */

/** Parse a numeric cell. Empty/non-numeric → null (never 0). */
function parseNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (s === '') return null;
  const cleaned = s.replace(/,/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Normalize a header label for HEADER_MAP lookup. */
function normHeader(s: unknown): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[\u00a0\s]+/g, ' ')
    .trim();
}

/**
 * Convert Excel serial / ISO / M/D/YYYY / JS Date into YYYY-MM-DD.
 * Returns null on anything it can't parse.
 */
function toIsoDate(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;

  if (typeof v === 'number' && Number.isFinite(v)) {
    const parts = XLSX.SSF.parse_date_code(v);
    if (!parts) return null;
    const mm = String(parts.m).padStart(2, '0');
    const dd = String(parts.d).padStart(2, '0');
    return `${parts.y}-${mm}-${dd}`;
  }

  const s = String(v).trim();
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

  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const yyyy = v.getFullYear();
    const mm = String(v.getMonth() + 1).padStart(2, '0');
    const dd = String(v.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  return null;
}

/**
 * Parse BTA's compound "Well Site" cell:
 *   "Hideout 24-13 State Com #1H (PSHA) - 2211506"
 * into:
 *   { wellName: "Hideout 24-13 State Com #1H",
 *     siteCode: "PSHA",
 *     operatorWellId: 2211506 }
 * If the format differs, return whatever we can parse — never throw.
 */
function parseWellSite(raw: unknown): {
  wellName: string;
  siteCode: string | null;
  operatorWellId: number | null;
  rawWellSite: string;
} {
  const rawStr = String(raw ?? '').trim();
  if (!rawStr) {
    return {
      wellName: '',
      siteCode: null,
      operatorWellId: null,
      rawWellSite: '',
    };
  }

  // Pull the trailing " - NNNNNNN" numeric ID (if present)
  let operatorWellId: number | null = null;
  let working = rawStr;
  const tailMatch = working.match(/\s-\s*(\d{3,})\s*$/);
  if (tailMatch) {
    operatorWellId = Number(tailMatch[1]);
    if (!Number.isFinite(operatorWellId)) operatorWellId = null;
    working = working.slice(0, tailMatch.index).trim();
  }

  // Pull the "(code)" parenthetical (if present) — take the LAST paren group
  // so we don't swallow parens that might legitimately be in the well name.
  let siteCode: string | null = null;
  const parenMatch = working.match(/\(([^()]+)\)\s*$/);
  if (parenMatch) {
    siteCode = parenMatch[1].trim() || null;
    working = working.slice(0, parenMatch.index).trim();
  }

  return {
    wellName: working,
    siteCode,
    operatorWellId,
    rawWellSite: rawStr,
  };
}

/* ────────────────────────────────────────────────────────────────
 * Header → canonical column mapping.
 * BTA's header is stable across all four sheets of the sample, but
 * we keep the map flexible so variants (e.g. "Tubing Press", "DT Hours")
 * still bind correctly.
 * ──────────────────────────────────────────────────────────────── */

type Canonical =
  | 'wellSite'
  | 'date'
  | 'oilProd'
  | 'gasProd'
  | 'waterProd'
  | 'tubingPres'
  | 'casingPres'
  | 'choke'
  | 'hoursDown'
  | 'downtimeReason'
  | 'downtimeNotes';

const HEADER_MAP: Record<string, Canonical> = {
  'well site': 'wellSite',
  'well': 'wellSite',
  'well name': 'wellSite',

  'date': 'date',
  'prod date': 'date',
  'production date': 'date',

  'oil': 'oilProd',
  'oil prod': 'oilProd',
  'oil production': 'oilProd',
  'oil (bbl)': 'oilProd',

  'gas': 'gasProd',
  'gas prod': 'gasProd',
  'gas production': 'gasProd',
  'gas (mcf)': 'gasProd',

  'water': 'waterProd',
  'water prod': 'waterProd',
  'water production': 'waterProd',
  'water (bbl)': 'waterProd',

  'tubing': 'tubingPres',
  'tubing pres': 'tubingPres',
  'tubing press': 'tubingPres',
  'tubing pressure': 'tubingPres',

  'casing': 'casingPres',
  'casing pres': 'casingPres',
  'casing press': 'casingPres',
  'casing pressure': 'casingPres',

  'choke': 'choke',

  'down time hours': 'hoursDown',
  'downtime hours': 'hoursDown',
  'hours down': 'hoursDown',
  'dt hours': 'hoursDown',
  'dt (hr)': 'hoursDown',

  'down time reason': 'downtimeReason',
  'downtime reason': 'downtimeReason',
  'dt reason': 'downtimeReason',

  'down time notes': 'downtimeNotes',
  'downtime notes': 'downtimeNotes',
  'dt notes': 'downtimeNotes',
  'notes': 'downtimeNotes',
};

/* ────────────────────────────────────────────────────────────────
 * Core parser — returns ProductionRecord[] from a workbook buffer.
 * Iterates ALL sheets (one per well in the sample).
 * ──────────────────────────────────────────────────────────────── */

export function parseBtaDailyPerWellXlsx(buf: Buffer): ProductionRecord[] {
  const wb = XLSX.read(buf, { type: 'buffer' });
  if (wb.SheetNames.length === 0) {
    throw new Error('BTA Daily: workbook has no sheets');
  }

  const allRecords: ProductionRecord[] = [];
  const skippedSheets: string[] = [];

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: '',
      raw: true,
      blankrows: false,
    });

    if (rows.length < 2) {
      skippedSheets.push(`${sheetName} (only ${rows.length} row(s))`);
      continue;
    }

    // Row 0 is the header row in every BTA sheet.
    const headers = (rows[0] as unknown[]).map(normHeader);
    const colMap = new Map<number, Canonical>();
    const seen = new Set<Canonical>();
    headers.forEach((h, idx) => {
      const canonical = HEADER_MAP[h];
      if (canonical && !seen.has(canonical)) {
        colMap.set(idx, canonical);
        seen.add(canonical);
      }
    });

    // Sanity: need at minimum a Well Site col, a Date col, and one volume col.
    if (
      !seen.has('wellSite') ||
      !seen.has('date') ||
      !(seen.has('oilProd') || seen.has('gasProd') || seen.has('waterProd'))
    ) {
      skippedSheets.push(
        `${sheetName} (unrecognized header row: [${headers.join(', ')}])`
      );
      continue;
    }

    // Data rows — skip "Grand Total" and any row with a blank/unparseable date.
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i] as unknown[];

      // Fully-blank row? Skip.
      if (row.every((c) => c === '' || c === null || c === undefined)) continue;

      const picked: Record<Canonical, unknown> = Object.create(null);
      for (const [idx, canonical] of colMap) {
        picked[canonical] = row[idx];
      }

      // "Grand Total" guard — typically appears with a string well-site cell
      // containing "grand total" and no numeric data.
      const wellSiteStr = String(picked.wellSite ?? '')
        .toLowerCase()
        .trim();
      if (wellSiteStr.includes('grand total') || wellSiteStr.includes('total')) {
        continue;
      }

      const prodDate = toIsoDate(picked.date);
      if (!prodDate) continue; // rows without parseable date aren't production rows

      const { wellName, siteCode, operatorWellId, rawWellSite } = parseWellSite(
        picked.wellSite
      );
      if (!wellName) continue;

      const oilProd = parseNum(picked.oilProd);
      const gasProd = parseNum(picked.gasProd);
      const waterProd = parseNum(picked.waterProd);
      const tubingPres = parseNum(picked.tubingPres);
      const casingPres = parseNum(picked.casingPres);
      const hoursDown = parseNum(picked.hoursDown);

      // Choke: preserve string form ("64/64"); fall back to number → string.
      let choke: string | null = null;
      if (picked.choke !== undefined && picked.choke !== '' && picked.choke !== null) {
        choke = String(picked.choke).trim() || null;
      }

      // Downtime reason + notes — merge when both present.
      const reason = String(picked.downtimeReason ?? '').trim();
      const notes = String(picked.downtimeNotes ?? '').trim();
      let downtimeReason: string | null = null;
      if (reason && notes) {
        downtimeReason = `${reason} — ${notes}`;
      } else if (reason) {
        downtimeReason = reason;
      } else if (notes) {
        downtimeReason = notes;
      }

      const extraFields: Record<string, unknown> = {
        source: 'bta-daily-per-well-xlsx',
        sheetName,
        rawWellSite,
      };
      if (siteCode) extraFields.wellSiteCode = siteCode;

      allRecords.push({
        api14: '', // BTA daily has no API column — well_name_aliases fills later
        api10: '',
        wellName,
        combocurveWellId: null,
        operatorWellId: operatorWellId ?? null,
        prodDate,
        oilProd,
        gasProd,
        waterProd,
        oilSales: null, // not in this format
        gasSales: null, // not in this format
        waterInj: null,
        daysOn: null,
        choke,
        tubingPres,
        casingPres,
        hoursDown,
        downtimeReason,
        extraFields,
      });
    }
  }

  if (allRecords.length === 0) {
    const detail =
      skippedSheets.length > 0
        ? `Skipped sheets: ${skippedSheets.join('; ')}`
        : 'No data rows found in any sheet.';
    throw new Error(`BTA Daily: produced 0 records. ${detail}`);
  }

  return allRecords;
}

/* ────────────────────────────────────────────────────────────────
 * Adapter registration
 * ──────────────────────────────────────────────────────────────── */

export const btaDailyPerWellXlsxAdapter: FormatAdapter = {
  name: 'BTA Daily Per-Well Sheets',
  operatorName: 'BTA Oil Producers',
  dataType: 'daily',
  fileKinds: ['xlsx', 'xls'],
  senderEmailPatterns: [/@btaoil\.com$/i, /@btaoilproducers\.com$/i],

  detect(ctx: ParserContext): boolean {
    // Strongest signature: multi-sheet workbook with BTA's exact header row
    // on the first sheet + at least one well-site value that matches the
    // compound "<name> (<code>) - <wellNum>" shape.
    if (!ctx.sheetNames || ctx.sheetNames.length < 1) return false;
    if (!ctx.sheetPreview || ctx.sheetPreview.length < 2) return false;

    // Header row check (row 0) — must include Well Site, Date, and the
    // three core volume columns.
    const headerRow = (ctx.sheetPreview[0] ?? []).map(normHeader);
    const hasWellSite = headerRow.some((h) => h === 'well site');
    const hasDate = headerRow.some((h) => h === 'date' || h === 'prod date');
    const hasOil = headerRow.some((h) => h === 'oil' || h === 'oil prod');
    const hasGas = headerRow.some((h) => h === 'gas' || h === 'gas prod');
    const hasWater = headerRow.some((h) => h === 'water' || h === 'water prod');
    if (!(hasWellSite && hasDate && hasOil && hasGas && hasWater)) return false;

    // Row 1 = first data row. Well Site should match the compound pattern.
    // This distinguishes BTA from any other "Well Site + Date + Oil/Gas/Water"
    // layout that might appear in a generic partner report.
    const firstDataRow = ctx.sheetPreview[1] ?? [];
    const wellSiteIdx = headerRow.findIndex((h) => h === 'well site');
    if (wellSiteIdx < 0) return false;
    const wellSiteCell = String(firstDataRow[wellSiteIdx] ?? '').trim();

    // BTA's compound pattern: "... ( <code> ) - <wellNum>"  (numeric tail)
    const looksCompound = /\([^()]+\)\s*-\s*\d{3,}/.test(wellSiteCell);
    return looksCompound;
  },

  async parse(ctx: ParserContext): Promise<ProductionRecord[]> {
    return parseBtaDailyPerWellXlsx(ctx.buffer);
  },
};
