/**
 * Parser: PDS Well Data Exchange — Diamondback Energy Monthly PDF  (Format 1b)
 * -----------------------------------------------------------------------
 * Source format: PDSWDX-MP-DIAMONDBACK-*.pdf
 * Operator:      Diamondback Energy for WEST PECOS TRADING COMPANY LLC
 * Data type:     MONTHLY production estimates
 *
 * Visual column layout (verified against 2026-04-21 sample — 10 columns):
 *   Well Name | API | SSI | Prod Date | Gas Prod | Oil Prod | Water Prod |
 *   Gas Sales | Oil Sales | Days On
 *
 * Distinguishing signatures (vs other PDS Monthly siblings):
 *   - "production@diamondbackenergy.com" inquiry-contact line — unique.
 *   - SSI column header ("1001777500") — Diamondback's internal surrogate
 *     index between Well Name and Prod Date. Unique to Diamondback across
 *     our PDS registry.
 *   - 10-digit API ("4232931211") in compact form (no dashes).
 *   - No MMBTU / no Well Status / no cumulative columns → distinguishes
 *     cleanly from Matador, Diversified, XTO.
 *
 * Why positional (x/y) extraction instead of flat text:
 *   pdf-parse's flat text concatenates the trailing decimals and reorders
 *   columns, making flat-text regex high drift-risk. Positional extraction
 *   assigns each value to the nearest column center, which is stable even
 *   if Diamondback reshuffles column order in a future release.
 *
 * Quirks the parser handles:
 *   1. Gas/Oil columns appear in the order (Gas Prod | Oil Prod) vs. other
 *      PDS operators who use (Oil Prod | Gas Prod). Fixed x-centers capture
 *      this correctly — the HARDCODED_COLUMN_PLAN reflects Diamondback's
 *      specific ordering.
 *   2. API is 10-digit → padded to 14-digit via normalizeApi (trailing "0000").
 *   3. SSI (Diamondback surrogate key) is a 10-digit integer → stored as
 *      operatorWellId directly (the only PDS operator whose internal ID
 *      fits in our integer operatorWellId field).
 *   4. The 2-line header ("Gas" at y=444, "Prod"/"Sales" at y=432) is
 *      resolved by hardcoded column centers + header fingerprint check.
 *   5. Dates arrive as "YYYY-MM-01" already. Round-tripped through
 *      normalizeMonthlyDate for defensive consistency.
 *
 * Field mapping to ProductionRecord:
 *   Well Name   → wellName
 *   API         → api10 / api14 (padded)
 *   SSI         → operatorWellId (Diamondback's integer surrogate key)
 *   Prod Date   → prodDate (normalized)
 *   Gas Prod    → gasProd
 *   Oil Prod    → oilProd
 *   Water Prod  → waterProd
 *   Gas Sales   → gasSales
 *   Oil Sales   → oilSales
 *   Days On     → daysOn
 */

import pdfParse from 'pdf-parse';
import type { FormatAdapter, ParserContext, ProductionRecord } from './types.js';
import { normalizeApi } from './apiNormalization.js';

/* ────────────────────────────────────────────────────────────────
 * Local utilities
 * ──────────────────────────────────────────────────────────────── */

function parseNum(token: string | undefined | null): number | null {
  if (token === null || token === undefined) return null;
  const s = String(token).trim();
  if (s === '') return null;
  const cleaned = s.replace(/,/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseInt32(token: string | undefined | null): number | null {
  const n = parseNum(token);
  if (n === null) return null;
  if (!Number.isInteger(n)) return null;
  if (n < -2147483648 || n > 2147483647) return null;
  return n;
}

/** "YYYY-MM-DD" → "YYYY-MM-01" (project monthly convention). */
function normalizeMonthlyDate(isoDate: string): string {
  const [yyyy, mm] = isoDate.split('-');
  return `${yyyy}-${mm}-01`;
}

/* ────────────────────────────────────────────────────────────────
 * Positional extraction — identical pattern to sibling PDS parsers.
 * ──────────────────────────────────────────────────────────────── */

type TextItem = { x: number; y: number; str: string; page: number };

async function extractAllItems(buf: Buffer): Promise<TextItem[]> {
  let currentPage = 0;
  async function pagerender(pageData: any): Promise<string> {
    currentPage += 1;
    const content = await pageData.getTextContent({
      normalizeWhitespace: false,
      disableCombineTextItems: false,
    });
    const lines: string[] = [];
    for (const it of content.items as any[]) {
      const x = it.transform[4];
      const y = it.transform[5];
      const s = String(it.str).replace(/[\t\n\r]/g, ' ');
      lines.push(`${currentPage}\t${x.toFixed(2)}\t${y.toFixed(2)}\t${s}`);
    }
    return lines.join('\n');
  }

  const parsed = await pdfParse(buf, { pagerender });
  return parsed.text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => {
      const parts = l.split('\t');
      return {
        page: Number(parts[0]),
        x: Number(parts[1]),
        y: Number(parts[2]),
        str: parts.slice(3).join('\t'),
      };
    })
    .filter((it) => Number.isFinite(it.x) && Number.isFinite(it.y));
}

/**
 * Group items by (page, y-bucket). **Bucket size = 6 pt for Diamondback.**
 *
 * Rationale: Diamondback data rows sit ~12 pt apart with clean y-alignment
 * (all values on one row land within 0-1 pt of each other). 6-pt bucket
 * is safe and matches the XTO/Matador convention for consistency.
 */
function groupIntoRows(items: TextItem[]): TextItem[][] {
  const byKey = new Map<string, TextItem[]>();
  for (const it of items) {
    const yBucket = Math.round(it.y / 6) * 6;
    const key = `${it.page}:${yBucket}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(it);
  }
  const entries = Array.from(byKey.entries()).map(([key, arr]) => {
    const [pageStr, yStr] = key.split(':');
    return { page: Number(pageStr), y: Number(yStr), items: arr };
  });
  entries.sort((a, b) => (a.page !== b.page ? a.page - b.page : b.y - a.y));
  return entries.map((e) => e.items.sort((a, b) => a.x - b.x));
}

/* ────────────────────────────────────────────────────────────────
 * Column plan — Diamondback 10-column hardcoded layout.
 * ──────────────────────────────────────────────────────────────── */

type ColumnRole =
  | 'wellName'
  | 'api'
  | 'ssi'         // Diamondback's surrogate key → operatorWellId
  | 'prodDate'
  | 'gasProd'
  | 'oilProd'
  | 'waterProd'
  | 'gasSales'
  | 'oilSales'
  | 'daysOn';

/**
 * Hardcoded column-center plan derived from positional analysis of the
 * 2026-04-21 sample PDF. Header-fingerprint check below confirms the
 * layout is still Diamondback before parse() trusts these centers.
 */
const HARDCODED_COLUMN_PLAN: { role: ColumnRole; center: number }[] = [
  { role: 'wellName',  center: 22 },
  { role: 'api',       center: 178 },
  { role: 'ssi',       center: 235 },
  { role: 'prodDate',  center: 291 },
  { role: 'gasProd',   center: 406 },
  { role: 'oilProd',   center: 477 },
  { role: 'waterProd', center: 552 },
  { role: 'gasSales',  center: 617 },
  { role: 'oilSales',  center: 690 },
  { role: 'daysOn',    center: 752 },
];

// Keys MUST be lowercase. Header tokens we match on.
const REQUIRED_HEADER_TOKENS = ['well name', 'api', 'ssi', 'prod date', 'days'];

function normHeaderLabel(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function verifyHeaderFingerprint(rows: TextItem[][]): boolean {
  const seen = new Set<string>();
  for (const row of rows) {
    for (const it of row) {
      const k = normHeaderLabel(it.str);
      if (REQUIRED_HEADER_TOKENS.includes(k)) seen.add(k);
    }
  }
  return REQUIRED_HEADER_TOKENS.every((r) => seen.has(r));
}

/* ────────────────────────────────────────────────────────────────
 * Row-to-record translation
 * ──────────────────────────────────────────────────────────────── */

const API10_RE = /^\d{10}$/;
const SSI_RE = /^\d{6,12}$/;             // Diamondback SSI is 10-digit in sample
const PROD_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assignRoles(
  row: TextItem[],
  plan: typeof HARDCODED_COLUMN_PLAN
): Partial<Record<ColumnRole, string>> {
  const out: Partial<Record<ColumnRole, string>> = {};
  for (const it of row) {
    let bestRole: ColumnRole | null = null;
    let bestDistance = Infinity;
    for (const col of plan) {
      const d = Math.abs(it.x - col.center);
      if (d < bestDistance) {
        bestDistance = d;
        bestRole = col.role;
      }
    }
    // ±40 pt tolerance — Diamondback's tightest gap is waterProd(552)→gasSales(617) = 65 pt.
    if (bestRole && bestDistance <= 40) {
      if (out[bestRole] === undefined) {
        out[bestRole] = it.str.trim();
      }
    }
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────
 * Core parser
 * ──────────────────────────────────────────────────────────────── */

export async function parsePdsDiamondbackMonthlyPdf(buf: Buffer): Promise<ProductionRecord[]> {
  const items = await extractAllItems(buf);
  if (items.length === 0) {
    throw new Error('PDS Diamondback Monthly: pdf-parse returned zero text items');
  }

  const rows = groupIntoRows(items);

  if (!verifyHeaderFingerprint(rows)) {
    throw new Error(
      'PDS Diamondback Monthly: header fingerprint missing. ' +
        `Required labels (${REQUIRED_HEADER_TOKENS.map((t) => `"${t}"`).join(', ')}) not all found. ` +
        'Layout may have changed.'
    );
  }

  const records: ProductionRecord[] = [];
  const skipped: string[] = [];

  for (const row of rows) {
    const roles = assignRoles(row, HARDCODED_COLUMN_PLAN);

    const prodDateStr = roles.prodDate;
    if (!prodDateStr || !PROD_DATE_RE.test(prodDateStr)) continue;

    // Skip "Total :" rollup rows — they have a date-like appearance if buckets
    // collide, but no wellName + no api.
    const rowText = row.map((it) => it.str).join(' ');
    if (/\bTotal\b/i.test(rowText)) continue;

    const wellName = roles.wellName?.trim() ?? '';
    const apiRaw = roles.api && API10_RE.test(roles.api) ? roles.api : '';
    if (!wellName || !apiRaw) {
      skipped.push(
        `row at y=${row[0].y.toFixed(0)}: missing wellName ("${wellName}") or api ("${apiRaw}")`
      );
      continue;
    }

    const { api10, api14 } = normalizeApi(apiRaw);
    const ssi = roles.ssi && SSI_RE.test(roles.ssi) ? roles.ssi : null;

    records.push({
      api14,
      api10,
      wellName,
      combocurveWellId: null,
      operatorWellId: parseInt32(ssi), // Diamondback's SSI fits int32 cleanly
      prodDate: normalizeMonthlyDate(prodDateStr),
      oilProd: parseNum(roles.oilProd),
      gasProd: parseNum(roles.gasProd),
      waterProd: parseNum(roles.waterProd),
      oilSales: parseNum(roles.oilSales),
      gasSales: parseNum(roles.gasSales),
      waterInj: null,
      daysOn: parseNum(roles.daysOn),
      choke: null,
      tubingPres: null,
      casingPres: null,
      hoursDown: null,
      downtimeReason: null,
      extraFields: {
        source: 'pds-diamondback-monthly-pdf',
        rawProdDate: prodDateStr,
        rawApi: apiRaw,
        ssi: ssi,                      // also in extraFields for audit
      },
    });
  }

  if (records.length === 0) {
    const detail =
      skipped.length > 0
        ? ` Skipped: ${skipped.slice(0, 3).join(' | ')}${skipped.length > 3 ? ` (+${skipped.length - 3} more)` : ''}`
        : '';
    throw new Error(
      `PDS Diamondback Monthly: produced 0 records — layout may have changed.${detail}`
    );
  }

  return records;
}

/* ────────────────────────────────────────────────────────────────
 * Adapter registration
 * ──────────────────────────────────────────────────────────────── */

export const pdsDiamondbackMonthlyAdapter: FormatAdapter = {
  name: 'PDS Diamondback Monthly',
  operatorName: 'Diamondback Energy',
  dataType: 'monthly',
  fileKinds: ['pdf'],
  senderEmailPatterns: [/@frioenergypartners\.com$/i, /@diamondbackenergy\.com$/i],

  detect(ctx: ParserContext): boolean {
    if (!ctx.pdfText) return false;
    const text = ctx.pdfText;
    const hasMonthlyHeader = /Monthly Production Estimates/i.test(text);
    const hasPds = /PDS Well Data Exchange/i.test(text);
    // Diamondback-unique: inquiry-contact line.
    const hasDiamondbackContact = /production@diamondbackenergy\.com/i.test(text);
    return hasMonthlyHeader && hasPds && hasDiamondbackContact;
  },

  async parse(ctx: ParserContext): Promise<ProductionRecord[]> {
    return parsePdsDiamondbackMonthlyPdf(ctx.buffer);
  },
};
