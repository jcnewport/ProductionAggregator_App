/**
 * Parser: Arlo / Pinon Partner Report XLSX  (Format 7 + variants)
 * -----------------------------------------------------------------
 * Source format:
 *   - 2026.03.30 Arlo Production.xlsx
 *   - pinonPartnerReport.nopag.xlsx
 *   - any future workbook that uses the same flat "partner-report" sheet layout
 *
 * Operator:    Arlo (and Pinon — same template, different operator name)
 * Data type:   DAILY production
 *
 * Workbook shape (verified across 2 sample files):
 *   Sheet name: "partner-report"  (exact — case-insensitive)
 *   Row 0 = headers:
 *     Date | Well Name | (blank) | API # | Oil Production | Gas Production |
 *     Water Production | Tubing | Casing | PIP | HZ | Comments
 *   Row 1..N = data, one row per well-day.
 *
 * Quirks observed:
 *   1. `Date` is an Excel serial number (e.g. 46081). The `xlsx` lib gives us
 *      the raw serial, so we convert it with XLSX.SSF.parse_date_code().
 *      If a string creeps in ("3/20/2026"), fall back to MDY parser.
 *   2. `API #` arrives as:
 *      - numeric  (4211534077)  — Arlo
 *      - hyphenated ("42-115-34077") — pinon
 *      We strip non-digits, then pad to 10 / 14 digits consistently.
 *   3. No Oil/Gas Sales columns in this format. `oilSales` and `gasSales`
 *      are set to null — NOT zero. Absent ≠ zero is a project rule.
 *   4. PIP (pump intake pressure) and HZ (frequency/hertz) are NOT in the
 *      ComboCurve template. Stored in extraFields.pip and extraFields.hz.
 *   5. Blank `Comments` column is stored as null in extraFields.comments.
 *   6. Column 3 is always blank (spacer) — the header row emits "" for it.
 *
 * Separation of concerns:
 *   - exportable `parseArloPartnerReportXlsx(buffer)` for tests and reuse
 *   - registered `arloPartnerReportXlsxAdapter` for the dispatcher
 */

import * as XLSX from 'xlsx';
import type { FormatAdapter, ParserContext, ProductionRecord } from './types.js';
import { normalizeApi } from './apiNormalization.js';

/* ────────────────────────────────────────────────────────────────
 * Small utilities — kept local so this adapter has no runtime
 * dependency on other parser files.
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

/** "4211534077" or "42-115-34077" → "4211534077" (10-digit string).
 *  Delegates to shared normalizer. */
function toApi10(raw: unknown): string {
  // normalizeApi tolerates null/undefined and returns { api10: '', api14: '' }.
  return normalizeApi(raw as any).api10;
}

/** 10-digit API → 14-digit (pad sidetrack + completion with trailing zeros).
 *  Delegates to shared normalizer. */
function api10ToApi14(api10: string): string {
  return normalizeApi(api10).api14;
}

/**
 * Convert a value that might be (a) an Excel date serial number, (b) an
 * ISO date string, or (c) an M/D/YYYY date string into a YYYY-MM-DD string.
 * Returns null on anything it can't parse.
 */
function toIsoDate(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;

  // Excel serial number (e.g. 46081 → 2026-03-20)
  if (typeof v === 'number' && Number.isFinite(v)) {
    // XLSX.SSF.parse_date_code returns { y, m, d, H, M, S } — Excel's epoch is
    // 1899-12-30 (accounting for the 1900 leap-year bug), so this gives us the
    // correct calendar date.
    const parts = XLSX.SSF.parse_date_code(v);
    if (!parts) return null;
    const mm = String(parts.m).padStart(2, '0');
    const dd = String(parts.d).padStart(2, '0');
    return `${parts.y}-${mm}-${dd}`;
  }

  // Already an ISO date?
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // M/D/YYYY or M-D-YYYY fallback
  const mdy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (mdy) {
    let [, mm, dd, yyyy] = mdy;
    if (yyyy.length === 2) yyyy = (Number(yyyy) > 50 ? '19' : '20') + yyyy;
    const mmi = Number(mm);
    const ddi = Number(dd);
    if (mmi < 1 || mmi > 12 || ddi < 1 || ddi > 31) return null;
    return `${yyyy}-${String(mmi).padStart(2, '0')}-${String(ddi).padStart(2, '0')}`;
  }

  // xlsx sometimes emits a JS Date for date-formatted cells
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const yyyy = v.getFullYear();
    const mm = String(v.getMonth() + 1).padStart(2, '0');
    const dd = String(v.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  return null;
}

/** Normalize a header label for comparison — lowercase + collapsed whitespace. */
function normHeader(s: unknown): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[\u00a0\s]+/g, ' ')
    .trim();
}

/* ────────────────────────────────────────────────────────────────
 * Header → canonical column mapping. One entry per expected header.
 * Unknown headers are ignored, which is fine — the sample column set
 * is stable across Arlo and pinon.
 * ──────────────────────────────────────────────────────────────── */

type Canonical =
  | 'date'
  | 'wellName'
  | 'api'
  | 'oilProd'
  | 'gasProd'
  | 'waterProd'
  | 'tubingPres'
  | 'casingPres'
  | 'pip'
  | 'hz'
  | 'comments'
  | 'choke'
  | 'hoursDown';

const HEADER_MAP: Record<string, Canonical> = {
  'date': 'date',
  'prod date': 'date',
  'production date': 'date',

  'well name': 'wellName',
  'well': 'wellName',

  'api': 'api',
  'api #': 'api',
  'api#': 'api',
  'api number': 'api',

  'oil production': 'oilProd',
  'oil prod': 'oilProd',
  'oil': 'oilProd',
  'oil (bbl)': 'oilProd',

  'gas production': 'gasProd',
  'gas prod': 'gasProd',
  'gas': 'gasProd',
  'gas (mcf)': 'gasProd',

  'water production': 'waterProd',
  'water prod': 'waterProd',
  'water': 'waterProd',
  'water (bbl)': 'waterProd',

  'tubing': 'tubingPres',
  'tubing pressure': 'tubingPres',
  'tubing pres': 'tubingPres',
  'tubing pres.': 'tubingPres',

  'casing': 'casingPres',
  'casing pressure': 'casingPres',
  'casing pres': 'casingPres',
  'casing pres.': 'casingPres',

  'pip': 'pip',
  'hz': 'hz',
  'comments': 'comments',
  'choke': 'choke',
  'hours down': 'hoursDown',
  'down time hours': 'hoursDown',
};

/* ────────────────────────────────────────────────────────────────
 * Core parser — returns ProductionRecord[] from a workbook buffer.
 * Exported separately so tests can call it directly without going
 * through the dispatcher.
 * ──────────────────────────────────────────────────────────────── */

export function parseArloPartnerReportXlsx(buf: Buffer): ProductionRecord[] {
  const wb = XLSX.read(buf, { type: 'buffer' });

  // Pick the partner-report sheet if it exists; otherwise first sheet.
  const sheetName =
    wb.SheetNames.find((n) => /partner.?report/i.test(n)) ?? wb.SheetNames[0];
  if (!sheetName) throw new Error('Arlo Partner Report: workbook has no sheets');

  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: '',
    raw: true, // keep numeric dates as serial numbers for precise conversion
  });

  if (rows.length < 2) {
    throw new Error(
      `Arlo Partner Report: sheet "${sheetName}" has ${rows.length} row(s), expected at least 2 (header + data)`
    );
  }

  // Row 0 is the header row. Build column index → canonical map.
  const headers = (rows[0] as unknown[]).map(normHeader);
  const colMap = new Map<number, Canonical>();
  headers.forEach((h, idx) => {
    const canonical = HEADER_MAP[h];
    if (canonical && !Array.from(colMap.values()).includes(canonical)) {
      // First-occurrence-wins: if two columns map to the same canonical field,
      // trust the first (matches the generic CSV adapter's behavior).
      colMap.set(idx, canonical);
    }
  });

  // Sanity: we need at LEAST a date col + a well identity col + one volume col.
  const haveDate = Array.from(colMap.values()).includes('date');
  const haveIdentity =
    Array.from(colMap.values()).includes('wellName') ||
    Array.from(colMap.values()).includes('api');
  const haveVolume =
    Array.from(colMap.values()).includes('oilProd') ||
    Array.from(colMap.values()).includes('gasProd') ||
    Array.from(colMap.values()).includes('waterProd');
  if (!haveDate || !haveIdentity || !haveVolume) {
    throw new Error(
      `Arlo Partner Report: header row missing required columns. Got: [${headers.join(', ')}]`
    );
  }

  const records: ProductionRecord[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] as unknown[];

    // Skip fully-blank rows (trailing padding rows in some exports).
    if (row.every((c) => c === '' || c === null || c === undefined)) continue;

    // Extract cells by canonical role.
    const picked: Record<Canonical, unknown> = Object.create(null);
    for (const [idx, canonical] of colMap) {
      picked[canonical] = row[idx];
    }

    const prodDate = toIsoDate(picked.date);
    if (!prodDate) continue; // rows without a parseable date are metadata, not production

    const rawApi = picked.api === undefined ? '' : String(picked.api).trim();
    const api10 = rawApi ? toApi10(rawApi) : '';
    const api14 = api10 ? api10ToApi14(api10) : '';

    const wellName = (picked.wellName === undefined ? '' : String(picked.wellName)).trim();

    // Skip rows with neither API nor well name — we can't identify the well.
    if (!api10 && !wellName) continue;

    const oilProd = parseNum(picked.oilProd);
    const gasProd = parseNum(picked.gasProd);
    const waterProd = parseNum(picked.waterProd);

    // Extra fields — keep whatever we got that doesn't map to the template.
    const extraFields: Record<string, unknown> = {};
    if (picked.pip !== undefined && picked.pip !== '') {
      extraFields.pip = parseNum(picked.pip);
    }
    if (picked.hz !== undefined && picked.hz !== '') {
      extraFields.hz = parseNum(picked.hz);
    }
    if (picked.comments !== undefined && String(picked.comments).trim() !== '') {
      extraFields.comments = String(picked.comments).trim();
    }
    // Also preserve the original API format for audit (Arlo=numeric, pinon=hyphenated)
    if (rawApi && rawApi !== api10) {
      extraFields.rawApi = rawApi;
    }

    records.push({
      api14,
      api10,
      wellName,
      combocurveWellId: null,
      operatorWellId: null,
      prodDate,
      oilProd,
      gasProd,
      waterProd,
      oilSales: null, // not provided in this format
      gasSales: null, // not provided in this format
      waterInj: null,
      daysOn: null,
      choke: picked.choke !== undefined && picked.choke !== '' ? String(picked.choke) : null,
      tubingPres: parseNum(picked.tubingPres),
      casingPres: parseNum(picked.casingPres),
      hoursDown: parseNum(picked.hoursDown),
      downtimeReason: null,
      extraFields,
    });
  }

  return records;
}

/* ────────────────────────────────────────────────────────────────
 * Adapter registration
 * ──────────────────────────────────────────────────────────────── */

export const arloPartnerReportXlsxAdapter: FormatAdapter = {
  name: 'Arlo Partner Report XLSX',
  operatorName: 'Arlo',
  dataType: 'daily',
  fileKinds: ['xlsx', 'xls'],
  senderEmailPatterns: [/@arlo\.com$/i, /@pinonoil\.com$/i],

  detect(ctx: ParserContext): boolean {
    // Sheet name is the strong signature. Arlo + pinon both use exactly
    // "partner-report" (hyphenated, lower-case).
    if (!ctx.sheetNames || ctx.sheetNames.length === 0) return false;
    if (!ctx.sheetNames.some((n) => /^partner.?report$/i.test(n))) return false;

    // Double-check by looking at the first-row headers — this guards against
    // Tap Rock / West Pecos workbooks that use "Sheet1" with a different
    // layout (those go to the Hierarchical parser, not this one).
    if (!ctx.sheetPreview || ctx.sheetPreview.length === 0) return false;
    const headerRow = (ctx.sheetPreview[0] ?? []).map(normHeader);
    const hasDateCol = headerRow.some((h) => h === 'date' || h === 'prod date');
    const hasWellNameCol = headerRow.some((h) => h === 'well name');
    const hasApiCol = headerRow.some((h) => /^api\s*#?$/.test(h));
    const hasOilProdCol = headerRow.some((h) => /oil\s*prod(uction)?/.test(h));
    return hasDateCol && hasWellNameCol && hasApiCol && hasOilProdCol;
  },

  async parse(ctx: ParserContext): Promise<ProductionRecord[]> {
    return parseArloPartnerReportXlsx(ctx.buffer);
  },
};
