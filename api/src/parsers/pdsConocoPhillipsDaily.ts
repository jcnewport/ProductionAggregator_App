/**
 * Parser: PDS Well Data Exchange — ConocoPhillips (Concho) Daily PDF  (Format 5)
 * ------------------------------------------------------------------------------
 * Source format: PDSWDX-DP-conocophillips-DAILY.pdf
 * Operator:      Concho Resources (ConocoPhillips) via Frio Energy Holdings
 * Data type:     DAILY production estimates
 *
 * Visual column layout (verified against sample — 13 columns):
 *   Well ID | Well Name | Completion No | API | Prod Date |
 *   Oil Prod | Oil Sales | Gas Prod | Gas Sales | Water Prod |
 *   Tubing Pres. | Casing Pres. | BHP
 *
 * Header layout quirk: each column label is stacked in two or three
 * text rows in the PDF (e.g. "Oil" at y=444 above "Prod" at y=432).
 * Rather than programmatically re-assembling split labels, we use a
 * **hardcoded column-center plan** (x-coordinates discovered via
 * peek-conocophillips-daily.ts) and runtime-verify it by fingerprinting
 * known header strings in the expected header y-band. If the PDF
 * layout ever changes, verification fails loudly instead of silently
 * mis-mapping values.
 *
 * Distinguishing signatures (vs other PDS dailies):
 *   - "Daily Production Estimates" + "Concho Resources" in top-of-page text
 *   - Columns "Completion No" and "BHP" (no other PDS format has both)
 *   - 12-digit API column ("423013587000")
 *
 * Why positional (x/y) extraction instead of flat text:
 *   pdf-parse's default text stream splits a single data row across 5+
 *   lines (well id alone, well name alone, completion no alone, volumes
 *   concatenated without separators, BHP alone) and reorders them
 *   unpredictably. Positional extraction by column center produces clean,
 *   invariant column assignment.
 *
 * Quirks the parser handles:
 *   1. Oil Sales column is BLANK on nearly all rows in samples — stored
 *      as null (not 0 — "absent" and "zero" are semantically different).
 *   2. 12-digit API ("423013587000") — API10 derived by taking first 10
 *      digits; API14 by padding with trailing "00" to reach 14.
 *   3. BHP (bottomhole pressure) is NOT in the 16-column ComboCurve
 *      template — preserved in extraFields.bhp for audit.
 *   4. Each data row splits across TWO y-buckets in positional output —
 *      the main row has 11 items (well id, name, compl, api, date, 4
 *      volumes, 2 pressures) at y=Y and a sibling sub-row 2 pt below
 *      holds just the BHP value at y=Y-2. An 8-pt row bucket merges
 *      them without colliding adjacent rows (data rows are 18 pt apart).
 *   5. Daily dates arrive as "YYYY-MM-DD" — preserved as-is (no
 *      monthly normalization).
 *   6. Negative values (allocation corrections) preserved as-is.
 *   7. ComboCurve WellID and operator Completion No are 15-digit
 *      integers — stored as numbers; raw preserved in extraFields.
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

/**
 * 12-digit API (ConocoPhillips format) → API10 (first 10) + API14 (pad with "00").
 * Project convention: always store API10 as 10-char text with leading
 * zeros preserved; derive API14 by padding missing sidetrack+completion
 * digits with "0".
 */
function normalizeApi(
  rawApi: string
): { api10: string; api14: string } {
  const digits = rawApi.replace(/\D/g, '');
  if (digits === '') return { api10: '', api14: '' };
  const api10 = digits.slice(0, 10).padStart(10, '0');
  // Pad to 14 with trailing zeros — if the source gave us 12 digits,
  // that means state+county+well+sidetrack(2)+completion(2) minus 2
  // trailing completion digits. Conservative fill: zeros.
  const api14 = (digits + '0000').slice(0, 14);
  return { api10, api14 };
}

/* ────────────────────────────────────────────────────────────────
 * Positional extraction — shares pattern with pdsEogMonthly & btaWioMailoutPdf.
 * pagerender override emits "page\tx\ty\tstr" per text item.
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
 * Group items by (page, y-bucket). Bucket size = 8 pt.
 *
 * Rationale: in Conoco daily samples, each data row has 11 items at y=Y
 * and one orphan BHP value at y=Y-2 (a consistent 2-pt split done by the
 * PDF producer). Adjacent data rows are ~18 pt apart. An 8-pt bucket:
 *   - merges Y and Y-2 into one logical row (they round to the same
 *     multiple-of-8)
 *   - does not merge Y and Y-18 (different multiples).
 * Verified with peek-conocophillips-daily.ts on page 1.
 */
function groupIntoRows(items: TextItem[]): TextItem[][] {
  const byKey = new Map<string, TextItem[]>();
  for (const it of items) {
    const yBucket = Math.round(it.y / 8) * 8;
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
 * Hardcoded column plan — x-centers discovered via peek.
 * Tolerance ±22 pt when assigning items to columns.
 * ──────────────────────────────────────────────────────────────── */

type ColumnRole =
  | 'wellID'
  | 'wellName'
  | 'completionNo'
  | 'api'
  | 'prodDate'
  | 'oilProd'
  | 'oilSales'
  | 'gasProd'
  | 'gasSales'
  | 'waterProd'
  | 'tubingPres'
  | 'casingPres'
  | 'bhp';

interface ColumnPlan {
  role: ColumnRole;
  center: number;
}

const CONOCO_COLUMN_PLAN: readonly ColumnPlan[] = [
  { role: 'wellID',       center: 19  },
  { role: 'wellName',     center: 102 },
  { role: 'completionNo', center: 242 },
  { role: 'api',          center: 311 },
  { role: 'prodDate',     center: 368 },
  { role: 'oilProd',      center: 440 },
  { role: 'oilSales',     center: 486 },
  { role: 'gasProd',      center: 527 },
  { role: 'gasSales',     center: 569 },
  { role: 'waterProd',    center: 612 },
  { role: 'tubingPres',   center: 650 },
  { role: 'casingPres',   center: 690 },
  { role: 'bhp',          center: 740 },
];

// Known header fingerprints — if any fail to appear in the top 20% of
// page 1's items, we bail with an explicit error rather than silently
// mis-map columns.
const HEADER_FINGERPRINTS: readonly string[] = [
  'Well ID',
  'Well Name',
  'Completion No',
  'API',
  'Prod Date',
  'BHP',
];

function verifyHeaderFingerprints(items: TextItem[]): string[] {
  // Scan only page 1 items at high y (top of page).
  const page1 = items.filter((it) => it.page === 1);
  if (page1.length === 0) return ['no items on page 1'];
  const maxY = Math.max(...page1.map((i) => i.y));
  const topBand = page1.filter((i) => i.y >= maxY - 100);
  const topText = topBand.map((i) => i.str.trim()).join(' | ');
  const missing: string[] = [];
  for (const label of HEADER_FINGERPRINTS) {
    if (!topText.toLowerCase().includes(label.toLowerCase())) {
      missing.push(label);
    }
  }
  return missing;
}

/**
 * Assign each item in a row to its role by picking the column whose
 * x-center is closest (within ±22 pt — right-aligned numbers drift
 * a few pt as magnitudes change).
 */
function assignRoles(row: TextItem[]): Partial<Record<ColumnRole, string>> {
  const out: Partial<Record<ColumnRole, string>> = {};
  for (const it of row) {
    let bestRole: ColumnRole | null = null;
    let bestDistance = Infinity;
    for (const col of CONOCO_COLUMN_PLAN) {
      const d = Math.abs(it.x - col.center);
      if (d < bestDistance) {
        bestDistance = d;
        bestRole = col.role;
      }
    }
    if (bestRole && bestDistance <= 22) {
      // First-occurrence-wins per role. If two items hit the same role
      // (rare — would mean overlap), keep the leftmost (nearer column).
      if (out[bestRole] === undefined) {
        out[bestRole] = it.str.trim();
      }
    }
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────
 * Row-to-record translation
 * ──────────────────────────────────────────────────────────────── */

const PROD_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Conoco's API column holds 12 digits in samples, but accept 10-14
// just in case a reformat ever changes width.
const API_RE = /^\d{10,14}$/;

/* ────────────────────────────────────────────────────────────────
 * Core parser
 * ──────────────────────────────────────────────────────────────── */

export async function parsePdsConocoPhillipsDailyPdf(
  buf: Buffer
): Promise<ProductionRecord[]> {
  const items = await extractAllItems(buf);
  if (items.length === 0) {
    throw new Error(
      'PDS ConocoPhillips Daily: pdf-parse returned zero text items'
    );
  }

  // Guard against silent mis-map if PDS ever reformats the template.
  const missing = verifyHeaderFingerprints(items);
  if (missing.length > 0) {
    throw new Error(
      `PDS ConocoPhillips Daily: header fingerprint failed — missing labels [${missing.join(
        ', '
      )}]. Layout may have changed; column centers need re-verification ` +
        `via scripts/peek-conocophillips-daily.ts.`
    );
  }

  const rows = groupIntoRows(items);

  // Like EOG, we carry forward the last-seen well identity in case pdfjs
  // splits identity from volumes across adjacent y-buckets. In practice
  // for Conoco this isn't needed (8-pt bucket catches the split), but it's
  // cheap insurance.
  let lastWellID: string | null = null;
  let lastWellName: string | null = null;
  let lastCompletionNo: string | null = null;
  let lastApiRaw: string | null = null;

  const records: ProductionRecord[] = [];
  const skipped: string[] = [];

  for (const row of rows) {
    const roles = assignRoles(row);

    // Carry-forward identity fields from any row that has them.
    if (roles.wellID && /^\d+$/.test(roles.wellID)) lastWellID = roles.wellID;
    if (roles.wellName && !isHeaderLabel(roles.wellName)) {
      lastWellName = roles.wellName;
    }
    if (roles.completionNo && /^\d+$/.test(roles.completionNo)) {
      lastCompletionNo = roles.completionNo;
    }
    if (roles.api && API_RE.test(roles.api)) lastApiRaw = roles.api;

    // A data row must have a Prod Date at minimum and at least 1 volume
    // column. (Some rows have only oil+tubing+casing if all gas/water are
    // zero and hidden.) Prod Date alone isn't enough — could be a
    // stray page.
    const prodDateStr = roles.prodDate;
    if (!prodDateStr || !PROD_DATE_RE.test(prodDateStr)) continue;
    const volumeCount =
      (roles.oilProd !== undefined ? 1 : 0) +
      (roles.oilSales !== undefined ? 1 : 0) +
      (roles.gasProd !== undefined ? 1 : 0) +
      (roles.gasSales !== undefined ? 1 : 0) +
      (roles.waterProd !== undefined ? 1 : 0);
    if (volumeCount < 1) {
      skipped.push(
        `data row at y=${row[0].y.toFixed(0)}: date="${prodDateStr}" but no volume columns matched`
      );
      continue;
    }

    const wellName =
      roles.wellName && !isHeaderLabel(roles.wellName)
        ? roles.wellName
        : lastWellName ?? '';
    if (!wellName) {
      skipped.push(
        `data row at y=${row[0].y.toFixed(0)}: no wellName (nor recent one)`
      );
      continue;
    }

    const rawApi = roles.api && API_RE.test(roles.api) ? roles.api : lastApiRaw ?? '';
    const { api10, api14 } = normalizeApi(rawApi);

    const wellID = roles.wellID ?? lastWellID ?? '';
    const completionNo = roles.completionNo ?? lastCompletionNo ?? '';

    records.push({
      api14,
      api10,
      wellName,
      combocurveWellId: null,
      operatorWellId: wellID ? Number(wellID) : null,
      prodDate: prodDateStr, // daily — no normalization
      oilProd: parseNum(roles.oilProd),
      gasProd: parseNum(roles.gasProd),
      waterProd: parseNum(roles.waterProd),
      oilSales: parseNum(roles.oilSales),
      gasSales: parseNum(roles.gasSales),
      waterInj: null, // not in Conoco daily
      daysOn: null, // not in Conoco daily
      choke: null,
      tubingPres: parseNum(roles.tubingPres),
      casingPres: parseNum(roles.casingPres),
      hoursDown: null,
      downtimeReason: null,
      extraFields: {
        source: 'pds-conocophillips-daily-pdf',
        rawApi: rawApi || null,
        completionNo: completionNo || null,
        bhp: parseNum(roles.bhp),
      },
    });
  }

  if (records.length === 0) {
    const detail =
      skipped.length > 0
        ? ` Skipped: ${skipped.slice(0, 3).join(' | ')}${skipped.length > 3 ? ` (+${skipped.length - 3} more)` : ''}`
        : '';
    throw new Error(
      `PDS ConocoPhillips Daily: produced 0 records — layout may have changed.${detail}`
    );
  }

  return records;
}

/** Is this string actually a header label (not a real well name)? */
function isHeaderLabel(s: string): boolean {
  const n = s.trim().toLowerCase();
  return (
    n === 'well name' ||
    n === 'well id' ||
    n === 'completion no' ||
    n === 'api' ||
    n === 'prod date' ||
    n === 'oil prod' ||
    n === 'oil sales' ||
    n === 'gas prod' ||
    n === 'gas sales' ||
    n === 'water prod' ||
    n === 'tubing pres.' ||
    n === 'casing pres.' ||
    n === 'bhp'
  );
}

/* ────────────────────────────────────────────────────────────────
 * Adapter registration
 * ──────────────────────────────────────────────────────────────── */

export const pdsConocoPhillipsDailyAdapter: FormatAdapter = {
  name: 'PDS ConocoPhillips Daily',
  operatorName: 'ConocoPhillips (Concho)',
  dataType: 'daily',
  fileKinds: ['pdf'],
  senderEmailPatterns: [
    /@pdswdx\.com$/i,
    /@frioenergy\.com$/i,
    /@frioenergypartners\.com$/i,
    /@conocophillips\.com$/i,
  ],

  detect(ctx: ParserContext): boolean {
    if (!ctx.pdfText) return false;
    const text = ctx.pdfText;
    const hasDailyHeader = /Daily Production Estimates/i.test(text);
    const hasPds = /PDS Well Data Exchange/i.test(text);
    // Concho / ConocoPhillips operator identity — either token is sufficient.
    const hasConcho = /CONCHO|CONOCO/i.test(text);
    // "Completion No" + "BHP" = the pair unique to Conoco daily in the
    // PDS family (EOG Daily / Anadarko Daily have different columns).
    const hasCompletionNo = /Completion\s*No/i.test(text);
    const hasBhp = /\bBHP\b/.test(text);
    return hasDailyHeader && hasPds && hasConcho && hasCompletionNo && hasBhp;
  },

  async parse(ctx: ParserContext): Promise<ProductionRecord[]> {
    return parsePdsConocoPhillipsDailyPdf(ctx.buffer);
  },
};
