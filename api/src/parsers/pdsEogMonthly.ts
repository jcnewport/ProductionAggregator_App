/**
 * Parser: PDS Well Data Exchange — EOG Resources Monthly PDF  (Format 2)
 * -----------------------------------------------------------------------
 * Source format: PDSWDX-MP-EOG-MONTHLY.pdf
 * Operator:      EOG Resources via Frio Energy Holdings I LLC
 * Data type:     MONTHLY production estimates
 *
 * Visual column layout (verified against sample — 11 columns):
 *   Well Name | Well ID | API | Prod Date | DaysOn | Oil Prod | Oil Sales |
 *   Gas Prod  | Gas Sales | Water Prod | Water Inj
 *
 * Distinguishing signatures from Anadarko (the sibling Frio/PDS monthly):
 *   - "Water Inj" (no 't')   vs Anadarko's "Water Inject"
 *   - "DaysOn"    (no space) vs Anadarko's "Days On"
 *
 * Why positional (x/y) extraction instead of flat text:
 *   pdf-parse's default text stream emits column values in PDF drawing order,
 *   not visual left-to-right order. For EOG, a single data row can appear in
 *   flat text as:
 *     "2026-03-31-27.39 47,390.48 51,066.32143263 0.00 47,362.07 0.00 30.29"
 *   The order is Date, OilProd, GasProd, WaterProd, WellID, WaterInj, GasSales,
 *   OilSales, DaysOn — unstable and format-specific. Positional extraction by
 *   x-coordinate produces clean, invariant column assignment.
 *
 * We reuse the same pagerender-override pattern already proven for
 * btaWioMailoutPdf.ts. Detection still uses pdf-parse's flat text because
 * the operator-identity strings and column-label substrings survive it.
 *
 * Quirks the parser handles:
 *   1. Negative Oil Prod values (BS&W corrections) — preserved as-is.
 *   2. "Water Inj" = 0.00 on most rows (non-injection wells) — stored.
 *   3. "DaysOn" values are decimal (23.13, 30.42) — decimals preserved.
 *   4. PDF spans 5 pages in the sample. We iterate all pages.
 *   5. Dates arrive as end-of-month YYYY-MM-DD (e.g. 2026-03-31).
 *      Normalized to first-of-month per project monthly convention;
 *      rawProdDate preserved in extraFields.
 *   6. Some pages include a pageNum in the stream; filtered out because
 *      a pageNum alone doesn't have the 11-column shape.
 *   7. Occasional rows lose a cell to a y-split (the API drifts to the
 *      line above). The column-center assignment absorbs that: we match
 *      any item within ±20 pt of a column's x-center into that column.
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

/** "YYYY-MM-DD" → "YYYY-MM-01" (project monthly convention). */
function normalizeMonthlyDate(isoDate: string): string {
  const [yyyy, mm] = isoDate.split('-');
  return `${yyyy}-${mm}-01`;
}

/** 14-digit API → first 10 chars (preserves leading zeros). */
function api14ToApi10(api14: string): string {
  return normalizeApi(api14).api10;
}

/* ────────────────────────────────────────────────────────────────
 * Positional extraction — share pattern with btaWioMailoutPdf.
 * pagerender override returns "x\ty\tstr\n" per text item.
 * ──────────────────────────────────────────────────────────────── */

type TextItem = { x: number; y: number; str: string; page: number };

async function extractAllItems(buf: Buffer): Promise<TextItem[]> {
  // We need page number for each item; pdf-parse doesn't expose it in the
  // default pagerender, so we stash it in the text itself via a page marker.
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
 * Group items by (page, y-bucket). Bucket size = 4 pt.
 *
 * Rationale: the header row in the EOG sample is split across y=464 ("Well Name"
 * alone) and y=462 (the other 10 labels) — a 2-pt spread that a narrower bucket
 * would keep separate. A 4-pt bucket collapses them into a single row so the
 * column plan captures all 11 labels. Data rows are separated by ~16 pt so
 * 4-pt bucketing does not collide adjacent rows. A further benefit: rows where
 * the API "drifts" up by 2 pt (e.g. y=372 "API alone" immediately above y=370
 * "name + ID + date + vols") also get collapsed, eliminating the need for the
 * lastApi14 fallback in those cases.
 */
function groupIntoRows(items: TextItem[]): TextItem[][] {
  const byKey = new Map<string, TextItem[]>();
  for (const it of items) {
    const yBucket = Math.round(it.y / 4) * 4;
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
 * Canonical order matches the visual layout L-to-R:
 *   wellName, wellID, api, prodDate, daysOn, oilProd, oilSales,
 *   gasProd, gasSales, waterProd, waterInj
 * ──────────────────────────────────────────────────────────────── */

type ColumnRole =
  | 'wellName'
  | 'wellID'
  | 'api'
  | 'prodDate'
  | 'daysOn'
  | 'oilProd'
  | 'oilSales'
  | 'gasProd'
  | 'gasSales'
  | 'waterProd'
  | 'waterInj';

// Keys here must be LOWERCASE — `normHeaderLabel()` lowercases before lookup.
// EOG's literal header strings are: "Well Name", "Well ID", "API", "Prod Date",
// "DaysOn" (no space — distinguishes from Anadarko's "Days On"), "Oil Prod",
// "Oil Sales", "Gas Prod", "Gas Sales", "Water Prod", "Water Inj".
const HEADER_LABEL_TO_ROLE: Record<string, ColumnRole> = {
  'well name': 'wellName',
  'well id': 'wellID',
  'api': 'api',
  'prod date': 'prodDate',
  'dayson': 'daysOn',
  'oil prod': 'oilProd',
  'oil sales': 'oilSales',
  'gas prod': 'gasProd',
  'gas sales': 'gasSales',
  'water prod': 'waterProd',
  'water inj': 'waterInj',
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
 * Scan rows top-to-bottom; the row that contains at least 6 of the 11
 * expected header labels is the column-definition row. Returns the role
 * → x-center map, or null if not found.
 */
function findColumnPlan(rows: TextItem[][]): ColumnPlan[] | null {
  for (const row of rows) {
    const plan: ColumnPlan[] = [];
    for (const it of row) {
      const role = HEADER_LABEL_TO_ROLE[normHeaderLabel(it.str)];
      if (role) plan.push({ role, center: it.x });
    }
    // Need at least 6 labels identified for a reliable column plan.
    if (plan.length >= 6) {
      // Sort by x so downstream iteration is left-to-right.
      plan.sort((a, b) => a.center - b.center);
      return plan;
    }
  }
  return null;
}

/* ────────────────────────────────────────────────────────────────
 * Row-to-record translation
 * ──────────────────────────────────────────────────────────────── */

const API14_RE = /^\d{14}$/;
const PROD_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Assign each item in a data row to its role by picking the column whose
 * x-center is closest (within ±30 pt — EOG's column widths exceed 30).
 * Returns a { role → string } map. Unmatched items are ignored.
 */
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
    // Only accept an assignment if within 40 pt of a column center —
    // otherwise this is a stray text item (page number, etc.)
    if (bestRole && bestDistance <= 40) {
      // First-occurrence-wins per role — if two items hit the same role,
      // keep the leftmost (closer to the column center usually wins anyway).
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

export async function parsePdsEogMonthlyPdf(buf: Buffer): Promise<ProductionRecord[]> {
  const items = await extractAllItems(buf);
  if (items.length === 0) {
    throw new Error('PDS EOG Monthly: pdf-parse returned zero text items');
  }

  const rows = groupIntoRows(items);
  const plan = findColumnPlan(rows);
  if (!plan) {
    throw new Error(
      'PDS EOG Monthly: could not locate a header row with ≥6 known column labels. ' +
        'Layout may have changed.'
    );
  }

  // Also need to know: some EOG data rows end up with the wellName on the
  // row above (by a y-unit), because pdfjs sometimes splits a row's text items
  // into two y-buckets when fonts shift. We track the most recent wellName
  // seen and reuse it when a row is missing one.
  let lastWellName: string | null = null;
  let lastWellID: string | null = null;
  let lastApi14: string | null = null;

  const records: ProductionRecord[] = [];
  const skipped: string[] = [];

  for (const row of rows) {
    const roles = assignRoles(row, plan);

    // Capture any wellName/wellID/API seen on this row (even if it's not a full data row).
    if (roles.wellName && !isHeaderLabel(roles.wellName)) {
      lastWellName = roles.wellName;
    }
    if (roles.wellID && /^\d+$/.test(roles.wellID)) lastWellID = roles.wellID;
    if (roles.api && API14_RE.test(roles.api)) lastApi14 = roles.api;

    // A "data row" = one with a Prod Date AND at least 3 of the 6 volume columns.
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
      skipped.push(`data row at y=${row[0].y.toFixed(0)}: date="${prodDateStr}" but only ${volumeCount} volume columns`);
      continue;
    }

    // Prefer this row's own wellName/ID/API; fall back to the last seen if
    // pdfjs split them into adjacent y-buckets.
    const wellName = roles.wellName && !isHeaderLabel(roles.wellName)
      ? roles.wellName
      : lastWellName ?? '';
    const wellID = roles.wellID ?? lastWellID ?? '';
    const api14 = roles.api && API14_RE.test(roles.api) ? roles.api : lastApi14 ?? '';

    if (!wellName) {
      skipped.push(`data row at y=${row[0].y.toFixed(0)}: no wellName found (not in row, no recent one)`);
      continue;
    }

    records.push({
      api14: api14 || '',
      api10: api14 ? api14ToApi10(api14) : '',
      wellName,
      combocurveWellId: null,
      operatorWellId: wellID ? Number(wellID) : null,
      prodDate: normalizeMonthlyDate(prodDateStr),
      oilProd: parseNum(roles.oilProd),
      gasProd: parseNum(roles.gasProd),
      waterProd: parseNum(roles.waterProd),
      oilSales: parseNum(roles.oilSales),
      gasSales: parseNum(roles.gasSales),
      waterInj: parseNum(roles.waterInj),
      daysOn: parseNum(roles.daysOn),
      choke: null,
      tubingPres: null,
      casingPres: null,
      hoursDown: null,
      downtimeReason: null,
      extraFields: {
        source: 'pds-eog-monthly-pdf',
        rawProdDate: prodDateStr, // end-of-month date as reported
      },
    });
  }

  if (records.length === 0) {
    const detail =
      skipped.length > 0
        ? ` Skipped: ${skipped.slice(0, 3).join(' | ')}${skipped.length > 3 ? ` (+${skipped.length - 3} more)` : ''}`
        : '';
    throw new Error(
      `PDS EOG Monthly: produced 0 records — layout may have changed.${detail}`
    );
  }

  return records;
}

/** Is this string actually a header label (not a real well name)? */
function isHeaderLabel(s: string): boolean {
  return HEADER_LABEL_TO_ROLE[normHeaderLabel(s)] !== undefined;
}

/* ────────────────────────────────────────────────────────────────
 * Adapter registration
 * ──────────────────────────────────────────────────────────────── */

export const pdsEogMonthlyAdapter: FormatAdapter = {
  name: 'PDS EOG Monthly',
  operatorName: 'EOG Resources',
  dataType: 'monthly',
  fileKinds: ['pdf'],
  senderEmailPatterns: [/@frioenergy\.com$/i, /@pdswdx\.com$/i, /@eogresources\.com$/i],

  detect(ctx: ParserContext): boolean {
    if (!ctx.pdfText) return false;
    const text = ctx.pdfText;
    // Same rails as the prior stub but now backed by a live parser.
    const hasMonthlyHeader = /Monthly Production Estimates/i.test(text);
    const hasPds = /PDS Well Data Exchange/i.test(text);
    // EOG's distinguishing markers: "Water Inj" (no 't') AND "DaysOn" (no space).
    const hasWaterInjNoT = /Water\s*Inj(?!ect)/i.test(text);
    const hasDaysOnNoSpace = /DaysOn/i.test(text);
    return hasMonthlyHeader && hasPds && hasWaterInjNoT && hasDaysOnNoSpace;
  },

  async parse(ctx: ParserContext): Promise<ProductionRecord[]> {
    return parsePdsEogMonthlyPdf(ctx.buffer);
  },
};
