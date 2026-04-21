/**
 * Parser: PDS Well Data Exchange — XTO Energy Monthly PDF  (Format 4)
 * -----------------------------------------------------------------------
 * Source format: PDSWDX-MP-XTO-MONTHLY.pdf
 * Operator:      XTO Energy, Inc. (ExxonMobil subsidiary) for
 *                WEST PECOS TRADING CO LLC
 * Data type:     MONTHLY production estimates
 *
 * Visual column layout (verified against sample — 15 columns):
 *   Well Num | Well Name | Prod Date | Producing Status | OilProd | OilSales |
 *   OilCum   | GasProd   | GasSales  | GasCum           | GasInj  | WaterProd|
 *   WaterInj | Pressure Base | Well Status
 *
 * Distinguishing signatures (vs Anadarko and EOG Monthly siblings):
 *   - Column set includes "OilCum", "GasCum" (cumulative totals)
 *   - Has "GasInj" column (gas injection volume)
 *   - Column header "Well Num" (not "Well ID")
 *   - Producer identity: "XTO Energy, Inc." at top of first page
 *   - API column holds a 10-digit number labeled "Well Num" (padded
 *     with trailing "0000" to derive API14)
 *
 * Why positional (x/y) extraction instead of flat text:
 *   pdf-parse's default text stream concatenates headers like
 *     "OilProdOilSalesOilCumGasProdGasSalesGasCumGasInjWaterProdWaterInjPressure"
 *   which is unrecoverable without positions. The body rows land in a more
 *   tractable order, but the column identity of each value can only be
 *   determined from the x-coordinate. Positional extraction by column center
 *   gives invariant, operator-independent mapping.
 *
 * Reuses the same pagerender-override pattern proven on BTA WIO and PDS EOG
 * Monthly. Detection still uses pdf-parse's default flat text because the
 * operator-identity strings and column-label substrings survive it even
 * though they're concatenated.
 *
 * Quirks the parser handles:
 *   1. OilCum and GasCum are cumulative running totals — NOT mapped to any
 *      ComboCurve template column. Preserved in extraFields for audit.
 *   2. GasInj is not in the 16-column template — preserved in extraFields.
 *   3. Pressure Base is a regulatory pressure (15.03 psi standard).
 *      Preserved in extraFields.pressureBase.
 *   4. Producing Status ("Active") and Well Status ("Producing Oil" /
 *      "Shut In Oil" / "Drilling") preserved in extraFields.
 *   5. Well Num arrives as 10 digits ("3002542063") — padded with "0000"
 *      to derive API14 per project convention. API10 stays as the 10-digit.
 *   6. Some sample months show anomalously large OilProd (488,042 BBL/month)
 *      — spec flagged these as data artifacts. We store as-is; downstream
 *      validation is a separate concern.
 *   7. Row y-spacing is ~10-12 pt. When the wellName drifts into a y-bucket
 *      2 pt off the data row (e.g. y=384 vs y=382), a 4-pt bucket splits
 *      them. We use a **6-pt** bucket which merges the pair without
 *      colliding adjacent data rows.
 *   8. Dates arrive as first-of-month "YYYY-MM-01" already — we still
 *      round-trip through normalizeMonthlyDate for defensive consistency,
 *      and preserve the raw date in extraFields.rawProdDate.
 */

import pdfParse from 'pdf-parse';
import type { FormatAdapter, ParserContext, ProductionRecord } from './types.js';

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

/** "YYYY-MM-DD" → "YYYY-MM-01" (project monthly convention). */
function normalizeMonthlyDate(isoDate: string): string {
  const [yyyy, mm] = isoDate.split('-');
  return `${yyyy}-${mm}-01`;
}

/**
 * XTO's "Well Num" column holds a 10-digit API-like number. We store it as
 * API10 and derive API14 by padding trailing "0000" (project convention when
 * the operator doesn't provide sidetrack/completion digits).
 */
function wellNumToApi(wellNum: string): { api10: string; api14: string } {
  const digits = wellNum.replace(/\D/g, '');
  if (digits === '') return { api10: '', api14: '' };
  const api10 = digits.slice(0, 10).padStart(10, '0');
  const api14 = (api10 + '0000').slice(0, 14);
  return { api10, api14 };
}

/* ────────────────────────────────────────────────────────────────
 * Positional extraction — pagerender override emits x/y per item.
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
 * Group items by (page, y-bucket). **Bucket size = 6 pt for XTO.**
 *
 * Rationale: XTO data rows are 10-12 pt apart, with occasional adjacent-row
 * drift where the wellName slips into a y-bucket 2 pt off the main data
 * row (e.g. y=384 data + y=382 name). A 4-pt bucket keeps them separate
 * and wellName falls off the row. A 6-pt bucket collapses the 2-pt pair
 * without colliding adjacent data rows (which differ by ≥10 pt).
 *
 * Implementation note: uses Math.round(y/6)*6 which — via JS's
 * half-to-even-except-not behavior — produces consistent 6-wide buckets.
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
 * Column plan — x-centers discovered from the header row.
 * All 15 columns are modeled so we can filter cumulative + status
 * columns out of the production fields while still preserving them
 * in extraFields.
 * ──────────────────────────────────────────────────────────────── */

type ColumnRole =
  | 'wellNum'         // 10-digit API → api10/api14
  | 'wellName'
  | 'prodDate'
  | 'producingStatus' // "Active" / regulatory → extraFields
  | 'oilProd'
  | 'oilSales'
  | 'oilCum'          // cumulative → extraFields (NOT a volume)
  | 'gasProd'
  | 'gasSales'
  | 'gasCum'          // cumulative → extraFields (NOT a volume)
  | 'gasInj'          // gas injection → extraFields (not in template)
  | 'waterProd'
  | 'waterInj'
  | 'pressureBase'    // regulatory PSI → extraFields
  | 'wellStatus';     // "Producing Oil" / "Shut In Oil" → extraFields

// Keys MUST be lowercase — normHeaderLabel() lowercases before lookup.
// XTO's literal header strings: "Well Num", "Well Name", "Prod Date",
// "Producing", "OilProd", "OilSales", "OilCum", "GasProd", "GasSales",
// "GasCum", "GasInj", "WaterProd", "WaterInj", "Pressure", "Well Status".
const HEADER_LABEL_TO_ROLE: Record<string, ColumnRole> = {
  'well num': 'wellNum',
  'well name': 'wellName',
  'prod date': 'prodDate',
  'producing': 'producingStatus',
  'oilprod': 'oilProd',
  'oilsales': 'oilSales',
  'oilcum': 'oilCum',
  'gasprod': 'gasProd',
  'gassales': 'gasSales',
  'gascum': 'gasCum',
  'gasinj': 'gasInj',
  'waterprod': 'waterProd',
  'waterinj': 'waterInj',
  'pressure': 'pressureBase',
  'well status': 'wellStatus',
};

/** Normalize a header label for lookup. */
function normHeaderLabel(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

interface ColumnPlan {
  role: ColumnRole;
  center: number;
}

/**
 * Scan rows top-to-bottom; the row that contains ≥8 of the 15 expected
 * header labels is the column-definition row. (8 is a deliberate floor:
 * even if PDS splits "Pressure" + "Base" onto separate lines, we still
 * have at least 8 labels on the primary header row.)
 */
function findColumnPlan(rows: TextItem[][]): ColumnPlan[] | null {
  for (const row of rows) {
    const plan: ColumnPlan[] = [];
    const seen = new Set<ColumnRole>();
    for (const it of row) {
      const role = HEADER_LABEL_TO_ROLE[normHeaderLabel(it.str)];
      if (role && !seen.has(role)) {
        plan.push({ role, center: it.x });
        seen.add(role);
      }
    }
    if (plan.length >= 8) {
      plan.sort((a, b) => a.center - b.center);
      return plan;
    }
  }
  return null;
}

/* ────────────────────────────────────────────────────────────────
 * Row-to-record translation
 * ──────────────────────────────────────────────────────────────── */

const WELL_NUM_RE = /^\d{10,14}$/;   // XTO uses 10-digit API-like numbers
const PROD_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assignRoles(
  row: TextItem[],
  plan: ColumnPlan[]
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
    // ±40 pt tolerance — XTO's widest inter-column gap is ~55 pt so this
    // cleanly routes items without stray text catching the wrong column.
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

export async function parsePdsXtoMonthlyPdf(buf: Buffer): Promise<ProductionRecord[]> {
  const items = await extractAllItems(buf);
  if (items.length === 0) {
    throw new Error('PDS XTO Monthly: pdf-parse returned zero text items');
  }

  const rows = groupIntoRows(items);
  const plan = findColumnPlan(rows);
  if (!plan) {
    throw new Error(
      'PDS XTO Monthly: could not locate a header row with ≥8 known column labels. ' +
        'Layout may have changed.'
    );
  }

  // Carry-forward for wellNum/wellName when a row's Well Num or Name drifts
  // into an adjacent y-bucket.
  let lastWellName: string | null = null;
  let lastWellNum: string | null = null;

  const records: ProductionRecord[] = [];
  const skipped: string[] = [];

  for (const row of rows) {
    const roles = assignRoles(row, plan);

    // Capture wellName/wellNum seen on this row (even if not a full data row).
    if (roles.wellName && !isHeaderLabel(roles.wellName)) {
      lastWellName = roles.wellName;
    }
    if (roles.wellNum && WELL_NUM_RE.test(roles.wellNum)) {
      lastWellNum = roles.wellNum;
    }

    // A "data row" = has Prod Date matching YYYY-MM-DD AND ≥3 production cols.
    const prodDateStr = roles.prodDate;
    if (!prodDateStr || !PROD_DATE_RE.test(prodDateStr)) continue;

    const volumeCount =
      (roles.oilProd !== undefined ? 1 : 0) +
      (roles.oilSales !== undefined ? 1 : 0) +
      (roles.gasProd !== undefined ? 1 : 0) +
      (roles.gasSales !== undefined ? 1 : 0) +
      (roles.waterProd !== undefined ? 1 : 0) +
      (roles.waterInj !== undefined ? 1 : 0);
    if (volumeCount < 3) {
      skipped.push(
        `data row at y=${row[0].y.toFixed(0)}: date="${prodDateStr}" but only ${volumeCount} volume columns`
      );
      continue;
    }

    const wellName = roles.wellName && !isHeaderLabel(roles.wellName)
      ? roles.wellName
      : lastWellName ?? '';
    const wellNum = roles.wellNum && WELL_NUM_RE.test(roles.wellNum)
      ? roles.wellNum
      : lastWellNum ?? '';

    if (!wellName) {
      skipped.push(`data row at y=${row[0].y.toFixed(0)}: no wellName found`);
      continue;
    }

    const { api10, api14 } = wellNumToApi(wellNum);

    records.push({
      api14,
      api10,
      wellName,
      combocurveWellId: null,
      operatorWellId: null, // XTO does not provide an operator well ID distinct from the API
      prodDate: normalizeMonthlyDate(prodDateStr),
      oilProd: parseNum(roles.oilProd),
      gasProd: parseNum(roles.gasProd),
      waterProd: parseNum(roles.waterProd),
      oilSales: parseNum(roles.oilSales),
      gasSales: parseNum(roles.gasSales),
      waterInj: parseNum(roles.waterInj),
      daysOn: null,            // XTO Monthly does not report days on
      choke: null,
      tubingPres: null,
      casingPres: null,
      hoursDown: null,
      downtimeReason: null,
      extraFields: {
        source: 'pds-xto-monthly-pdf',
        rawProdDate: prodDateStr,
        // Non-template columns preserved for audit / future use
        oilCum: parseNum(roles.oilCum),
        gasCum: parseNum(roles.gasCum),
        gasInj: parseNum(roles.gasInj),
        pressureBase: parseNum(roles.pressureBase),
        producingStatus: roles.producingStatus ?? null,
        wellStatus: roles.wellStatus ?? null,
        rawWellNum: wellNum || null,
      },
    });
  }

  if (records.length === 0) {
    const detail =
      skipped.length > 0
        ? ` Skipped: ${skipped.slice(0, 3).join(' | ')}${skipped.length > 3 ? ` (+${skipped.length - 3} more)` : ''}`
        : '';
    throw new Error(
      `PDS XTO Monthly: produced 0 records — layout may have changed.${detail}`
    );
  }

  return records;
}

function isHeaderLabel(s: string): boolean {
  return HEADER_LABEL_TO_ROLE[normHeaderLabel(s)] !== undefined;
}

/* ────────────────────────────────────────────────────────────────
 * Adapter registration
 * ──────────────────────────────────────────────────────────────── */

export const pdsXtoMonthlyAdapter: FormatAdapter = {
  name: 'PDS XTO Monthly',
  operatorName: 'XTO Energy (ExxonMobil)',
  dataType: 'monthly',
  fileKinds: ['pdf'],
  senderEmailPatterns: [/@pdswdx\.com$/i, /@xtoenergy\.com$/i, /@exxonmobil\.com$/i],

  detect(ctx: ParserContext): boolean {
    if (!ctx.pdfText) return false;
    const text = ctx.pdfText;
    const hasMonthlyHeader = /Monthly Production Estimates/i.test(text);
    const hasPds = /PDS Well Data Exchange/i.test(text);
    const hasXto = /XTO\s*Energy/i.test(text);
    // XTO-specific signature: the cumulative column labels "OilCum" and "GasCum"
    // are unique to the XTO layout among Frio/PDS monthly formats.
    const hasCumulativeCols = /OilCum/i.test(text) && /GasCum/i.test(text);
    return hasMonthlyHeader && hasPds && hasXto && hasCumulativeCols;
  },

  async parse(ctx: ParserContext): Promise<ProductionRecord[]> {
    return parsePdsXtoMonthlyPdf(ctx.buffer);
  },
};
