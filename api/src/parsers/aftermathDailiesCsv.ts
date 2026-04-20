/**
 * Parser: Aftermath Dailies CSV  (Format 6)
 * -----------------------------------------------
 * Source format: 2026_04_07_Aftermath_Dailies.csv (and similarly-named files)
 * Operator:      Aftermath  (rolls up under Concho / ConocoPhillips)
 * Data type:     DAILY production
 *
 * Column header (case-insensitive, order-preserving):
 *   WELL ID, COMPLETION NO, WELL NAME, API, PRODDATE,
 *   OIL PROD, OIL SALES, GAS PROD, GAS SALES, WATER PROD,
 *   TUBING PRESSURE, CASING PRESSURE, BOTTOMHOLE PRESSURE
 *
 * Quirks observed in the sample file:
 *   1. WELL ID and COMPLETION NO arrive as scientific notation ("1.00E+14").
 *      Excel exports a 14-digit int as scientific when the column is "General".
 *      We parse as Number then round — the raw 1.00E+14 in the sample is just
 *      a rounded placeholder, so we keep the original string in extraFields
 *      alongside the int for audit.
 *   2. API is 10-digit ("4230135870"). Pad with trailing "0000" to derive API14.
 *      10-digit API = State(2)+County(3)+Well(5). Adding sidetrack(2)+completion(2)
 *      zeros is the project convention when the operator doesn't provide them.
 *   3. PRODDATE is M/D/YYYY (no zero-padding). Normalize to YYYY-MM-DD.
 *   4. OIL SALES column is ALWAYS blank in this format. Map to null,
 *      NOT zero — "absent" and "zero" are semantically different.
 *   5. BOTTOMHOLE PRESSURE is extra (not in the ComboCurve template).
 *      Store in extraFields.bhp for future use.
 *   6. Negative production values, if any, are preserved as-is (per project rules).
 *
 * Design:
 *   - Pure-string CSV parser below (no xlsx library dependency) so unit tests
 *     don't need any native modules.
 *   - Exposes parseAftermathCsv(text) for standalone testing (what test scripts
 *     hit) plus aftermathDailyAdapter for the registry dispatcher.
 */

import type { FormatAdapter, ParserContext, ProductionRecord } from './types.js';

/* ────────────────────────────────────────────────────────────────
 * Small utilities
 * ──────────────────────────────────────────────────────────────── */

/** Parse a numeric token. Empty / whitespace / non-numeric → null (not zero). */
function parseNum(token: string | undefined | null): number | null {
  if (token === null || token === undefined) return null;
  const trimmed = token.trim();
  if (trimmed === '') return null;
  const cleaned = trimmed.replace(/,/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a scientific-notation integer like "1.00E+14" → 100000000000000.
 * Falls back to null on anything unparseable.
 * (These WELL ID / COMPLETION NO values are rounded by Excel's default
 * formatting, so the parsed int is lossy by the time it reaches us.
 * That's fine — API10 is the authoritative join key for wells.)
 */
function parseSciInt(token: string | undefined | null): number | null {
  if (token === null || token === undefined) return null;
  const trimmed = token.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

/** "4230135870" → "42301358700000"  (10 digits → 14 with trailing zeros). */
function api10ToApi14(api10: string): string {
  const cleaned = api10.replace(/\D/g, '');
  if (cleaned.length >= 14) return cleaned.slice(0, 14);
  return cleaned.padEnd(14, '0');
}

/** Left-pad to 10 chars so leading zeros survive. */
function toApi10(anyApi: string): string {
  const cleaned = anyApi.replace(/\D/g, '');
  return cleaned.slice(0, 10).padStart(10, '0');
}

/** "4/6/2026" → "2026-04-06" ; "12/31/2025" → "2025-12-31". */
function parseMdyToIso(mdy: string): string | null {
  const m = mdy.trim().match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (!m) return null;
  let [, mm, dd, yyyy] = m;
  if (yyyy.length === 2) yyyy = (Number(yyyy) > 50 ? '19' : '20') + yyyy;
  const mmi = Number(mm);
  const ddi = Number(dd);
  if (mmi < 1 || mmi > 12 || ddi < 1 || ddi > 31) return null;
  return `${yyyy}-${String(mmi).padStart(2, '0')}-${String(ddi).padStart(2, '0')}`;
}

/* ────────────────────────────────────────────────────────────────
 * Tiny CSV splitter — handles quoted fields + escaped double quotes.
 * Not RFC-4180 complete, but enough for the export shapes we see
 * from operator ticketing systems.
 * ──────────────────────────────────────────────────────────────── */

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** Split a CSV blob into rows, respecting newlines inside quoted fields. */
function splitCsvRows(csvText: string): string[] {
  const rows: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i];
    if (inQuotes) {
      if (ch === '"' && csvText[i + 1] === '"') {
        cur += '""';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
        cur += ch;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
      cur += ch;
    } else if (ch === '\r') {
      // ignore — handled by \n
    } else if (ch === '\n') {
      rows.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.length > 0) rows.push(cur);
  return rows;
}

/* ────────────────────────────────────────────────────────────────
 * Format signature — cheap detect for the dispatcher.
 * ──────────────────────────────────────────────────────────────── */

const REQUIRED_HEADER_TOKENS = [
  'WELL ID',
  'COMPLETION NO',
  'WELL NAME',
  'API',
  'PRODDATE',
  'OIL PROD',
  'GAS PROD',
  'WATER PROD',
];

/**
 * Return true if the supplied headers row (any case) looks like an
 * Aftermath Dailies export. We don't require 100% header match because
 * operator sometimes adds/renames columns between exports — we just
 * require the distinguishing set.
 */
function headersLookLikeAftermath(headers: string[]): boolean {
  const upper = headers.map((h) => String(h ?? '').trim().toUpperCase());
  return REQUIRED_HEADER_TOKENS.every((tok) => upper.includes(tok));
}

export function isAftermathDailiesCsv(ctx: ParserContext): boolean {
  // Preferred path — dispatcher populated a sheetPreview (first ~20 rows).
  if (ctx.sheetPreview && ctx.sheetPreview.length > 0) {
    const headerRow = (ctx.sheetPreview[0] ?? []).map((c) => String(c ?? ''));
    if (headersLookLikeAftermath(headerRow)) {
      return true;
    }
  }
  // Fallback — sniff the raw CSV buffer directly. Covers CSVs that hit
  // the dispatcher without sheetPreview (e.g., from a manual upload path).
  if (ctx.fileKind === 'csv' && ctx.buffer && ctx.buffer.length > 0) {
    const head = ctx.buffer.toString('utf-8').slice(0, 2000);
    const firstLine = head.split(/\r?\n/)[0] ?? '';
    const cols = splitCsvLine(firstLine);
    if (headersLookLikeAftermath(cols)) return true;
  }
  return false;
}

/* ────────────────────────────────────────────────────────────────
 * Public: parse a CSV string into ProductionRecord[].
 * Separated so tests can exercise the parser without a Buffer.
 * ──────────────────────────────────────────────────────────────── */

export function parseAftermathCsv(csvText: string): ProductionRecord[] {
  const rawRows = splitCsvRows(csvText).filter((r) => r.trim() !== '');
  if (rawRows.length < 2) {
    throw new Error('Aftermath CSV has no data rows.');
  }

  const headers = splitCsvLine(rawRows[0]).map((h) => h.trim().toUpperCase());
  if (!headersLookLikeAftermath(headers)) {
    throw new Error(
      'Aftermath CSV header does not match expected schema. ' +
        `Got: [${headers.join(', ')}]`
    );
  }

  // Build a header-name → index lookup (tolerates column reordering).
  const idx = (name: string): number => headers.indexOf(name.toUpperCase());
  const iWellId = idx('WELL ID');
  const iCompl = idx('COMPLETION NO');
  const iWellName = idx('WELL NAME');
  const iApi = idx('API');
  const iDate = idx('PRODDATE');
  const iOilProd = idx('OIL PROD');
  const iOilSales = idx('OIL SALES');
  const iGasProd = idx('GAS PROD');
  const iGasSales = idx('GAS SALES');
  const iWater = idx('WATER PROD');
  const iTub = idx('TUBING PRESSURE');
  const iCas = idx('CASING PRESSURE');
  const iBhp = idx('BOTTOMHOLE PRESSURE');

  const records: ProductionRecord[] = [];
  const skipped: Array<{ rowNum: number; reason: string }> = [];

  for (let r = 1; r < rawRows.length; r++) {
    const line = rawRows[r];
    if (line.trim() === '') continue;
    const cols = splitCsvLine(line);

    const apiRaw = (cols[iApi] ?? '').trim();
    const wellName = (cols[iWellName] ?? '').trim();
    const dateRaw = (cols[iDate] ?? '').trim();

    if (!apiRaw || !wellName || !dateRaw) {
      skipped.push({ rowNum: r + 1, reason: 'missing API/well name/date' });
      continue;
    }

    const prodDate = parseMdyToIso(dateRaw);
    if (!prodDate) {
      skipped.push({ rowNum: r + 1, reason: `unparseable date "${dateRaw}"` });
      continue;
    }

    const api10 = toApi10(apiRaw);
    const api14 = api10ToApi14(api10);

    const wellIdRaw = iWellId >= 0 ? (cols[iWellId] ?? '').trim() : '';
    const completionNoRaw = iCompl >= 0 ? (cols[iCompl] ?? '').trim() : '';

    records.push({
      api14,
      api10,
      wellName,
      combocurveWellId: null, // resolved later via ComboCurve lookup
      operatorWellId: parseSciInt(wellIdRaw), // best-effort (scientific-notation lossy)
      prodDate,
      oilProd: parseNum(cols[iOilProd]),
      gasProd: parseNum(cols[iGasProd]),
      waterProd: parseNum(cols[iWater]),
      gasSales: parseNum(cols[iGasSales]),
      oilSales: iOilSales >= 0 ? parseNum(cols[iOilSales]) : null, // always blank in samples → null
      waterInj: null,
      daysOn: null,
      choke: null,
      tubingPres: iTub >= 0 ? parseNum(cols[iTub]) : null,
      casingPres: iCas >= 0 ? parseNum(cols[iCas]) : null,
      hoursDown: null,
      downtimeReason: null,
      extraFields: {
        // Preserve the original operator identifiers even though they're lossy
        // in the source export — helpful for audit and debugging.
        aftermathWellIdRaw: wellIdRaw || null,
        aftermathCompletionNoRaw: completionNoRaw || null,
        aftermathCompletionNoParsed: parseSciInt(completionNoRaw),
        bhp: iBhp >= 0 ? parseNum(cols[iBhp]) : null,
      },
    });
  }

  if (records.length === 0) {
    throw new Error(
      `Aftermath CSV parsed but produced zero records. ${skipped.length} rows skipped. ` +
        `First skip reason: ${skipped[0]?.reason ?? 'unknown'}`
    );
  }

  return records;
}

/* ────────────────────────────────────────────────────────────────
 * FormatAdapter — wired into registry.ts.
 * ──────────────────────────────────────────────────────────────── */

export const aftermathDailiesCsvAdapter: FormatAdapter = {
  name: 'Aftermath Dailies CSV',
  operatorName: 'Aftermath (Concho/ConocoPhillips)',
  dataType: 'daily',
  fileKinds: ['csv'] as const,
  // Aftermath doesn't send from a stable @aftermath domain in our samples —
  // leave sender hints empty and rely on header-signature detect.

  detect(ctx: ParserContext): boolean {
    return isAftermathDailiesCsv(ctx);
  },

  async parse(ctx: ParserContext): Promise<ProductionRecord[]> {
    const text = ctx.buffer.toString('utf-8');
    return parseAftermathCsv(text);
  },
};
