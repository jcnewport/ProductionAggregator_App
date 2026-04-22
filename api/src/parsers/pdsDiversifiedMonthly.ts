/**
 * Parser: PDS Well Data Exchange — Diversified Energy Monthly PDF  (Format 1d)
 * -----------------------------------------------------------------------
 * Source format: PDSWDX-MP-DIVERSIFIED-*.pdf
 * Operator:      Diversified Energy for WEST PECOS TRADING COMPANY, LLC
 * Data type:     MONTHLY production estimates
 *
 * Visual column layout (verified against 2026-04-21 sample — 10 columns):
 *   Well ID | API | Well Name | Prod Date | Oil Prod | Oil Sales |
 *   Gas Prod | Gas Sales | Water Prod | Well Status
 *
 * Distinguishing signatures (vs other PDS Monthly siblings):
 *   - "Diversified Energy" in the header block
 *   - Oklahoma City HQ address ("100 East Main Street Oklahoma City, OK 73104")
 *   - API format is HYPHENATED ("30-025-42711-00-00") — the only PDS
 *     operator in our registry that emits hyphenated API strings
 *   - "Well Status" column (Producing / Service Well / Shut-In /
 *     Temporarily Abandoned / Plugged & Abnd) — XTO also has this
 *     but XTO has OilCum/GasCum which Diversified lacks
 *   - Numeric Well ID format "1236430.01" (7-digit + 2-digit completion)
 *
 * Why positional (x/y) extraction instead of flat text:
 *   Same reasons as sibling PDS parsers — pdf-parse flat text concatenates
 *   and reorders columns. Diversified adds an additional complication:
 *   wellName wraps to a second y-line for most wells (the "EAST VACUUM
 *   GBSA UNIT" parent name on line 1, the unit/tract identifier like
 *   "3202 514" on line 2 a few pt below). Positional extraction with
 *   wellName carry-forward handles this cleanly.
 *
 * Quirks the parser handles:
 *   1. wellName spans 2 y-buckets — the main row has the parent name
 *      (e.g. "EAST VACUUM GBSA UNIT") and the following row has the
 *      subunit identifier ("3202 514"). We concatenate them into the
 *      full wellName on emit.
 *   2. Hyphenated API "30-025-42711-00-00" → strip dashes → api14 "30025427110000".
 *   3. Well Status column → extraFields.wellStatus. Rows with status
 *      "Service Well" / "Temporarily Abandoned" / "Plugged & Abnd" /
 *      "Shut-In" frequently have all-zero volumes — THESE ARE VALID,
 *      not parse errors. We emit them normally; downstream filters can
 *      decide whether to include non-producing wells in exports.
 *   4. File is multi-page (11 pages in sample) with the header only on
 *      page 1. Data rows continue without re-emitting headers on later
 *      pages. The HARDCODED_COLUMN_PLAN applies globally.
 *   5. Diversified dates are "YYYY-MM-28" (end-of-month) — normalized to
 *      first-of-month and raw preserved in extraFields.rawProdDate.
 *   6. Well Status sometimes gets truncated in the PDF text extraction
 *      (e.g. "Temporarily Abandone" instead of "Temporarily Abandoned").
 *      Preserved verbatim — downstream consumers should match by prefix.
 *   7. Well ID "1236430.01" kept verbatim in extraFields.diversifiedWellId
 *      (can't fit integer operatorWellId due to the dot).
 *   8. Grand TOTAL row at end of report (e.g. "60,059.44 746,163.74
 *      907,071.00 TOTAL :") — must be filtered. No Well ID, no Prod Date
 *      on that row, so our standard date-required gate handles it.
 *
 * Field mapping to ProductionRecord:
 *   Well ID     → extraFields.diversifiedWellId ("1236430.01")
 *   API         → api10 / api14 (dashes stripped)
 *   Well Name   → wellName (parent + subunit merged)
 *   Prod Date   → prodDate (normalized to first-of-month)
 *   Oil Prod    → oilProd
 *   Oil Sales   → oilSales
 *   Gas Prod    → gasProd
 *   Gas Sales   → gasSales
 *   Water Prod  → waterProd
 *   Well Status → extraFields.wellStatus
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

/** Strip dashes from hyphenated API ("30-025-42711-00-00" → "30025427110000"). */
function stripApiDashes(api: string): string {
  return api.replace(/-/g, '');
}

/* ────────────────────────────────────────────────────────────────
 * Positional extraction
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
 * Group items by (page, y-bucket). **Bucket size = 6 pt for Diversified.**
 *
 * Rationale: Diversified's data rows sit ~18 pt apart (main row) with the
 * wellName-continuation sub-row 6 pt below the main. A 6-pt bucket keeps
 * them as separate rows (which is what we want — we handle wellName
 * continuation via LOOK-AHEAD in the main loop, not by merging buckets).
 */
function groupIntoRows(items: TextItem[]): { page: number; y: number; items: TextItem[] }[] {
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
  return entries.map((e) => ({
    page: e.page,
    y: e.y,
    items: e.items.sort((a, b) => a.x - b.x),
  }));
}

/* ────────────────────────────────────────────────────────────────
 * Column plan — Diversified 10-column hardcoded layout.
 * ──────────────────────────────────────────────────────────────── */

type ColumnRole =
  | 'wellId'      // "1236430.01" → extraFields.diversifiedWellId
  | 'api'         // Hyphenated — dashes stripped on emit
  | 'wellName'
  | 'prodDate'
  | 'oilProd'
  | 'oilSales'
  | 'gasProd'
  | 'gasSales'
  | 'waterProd'
  | 'wellStatus'; // "Producing" / "Service Well" / etc. → extraFields

/**
 * Hardcoded column-center plan from positional analysis of the
 * 2026-04-21 sample. Header-fingerprint check confirms layout.
 *
 * NOTE on wellStatus center: the Well Status header sits at x=735 but
 * status values like "Temporarily Abandone" are longer strings that
 * start at x=729 (left-aligned under the header). The 40-pt tolerance
 * routes them correctly either way.
 */
const HARDCODED_COLUMN_PLAN: { role: ColumnRole; center: number }[] = [
  { role: 'wellId',     center: 22 },
  { role: 'api',        center: 72 },
  { role: 'wellName',   center: 139 },
  { role: 'prodDate',   center: 262 },
  { role: 'oilProd',    center: 365 },
  { role: 'oilSales',   center: 453 },
  { role: 'gasProd',    center: 538 },
  { role: 'gasSales',   center: 614 },
  { role: 'waterProd',  center: 688 },
  { role: 'wellStatus', center: 732 },
];

// Diversified's header is split across THREE y-lines (y=426, y=420, y=414)
// because PDS vertical-stacks the header labels. The full label "Prod Date"
// lands as two separate text items ("Prod " at y=426 and "Date" at y=414);
// "Well Status" lands as "Well" at y=426 + "Status" at y=414. We relax the
// fingerprint check to match on INDIVIDUAL tokens that appear in the
// positional text stream — "well id", "api", "well name", "status", and
// the specific Diversified operator string serve as a strong enough
// combined signature to block false positives.
const REQUIRED_HEADER_TOKENS = ['well id', 'api', 'well name', 'status'];

function normHeaderLabel(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function verifyHeaderFingerprint(
  rows: { page: number; y: number; items: TextItem[] }[]
): boolean {
  const seen = new Set<string>();
  for (const row of rows) {
    for (const it of row.items) {
      const k = normHeaderLabel(it.str);
      if (REQUIRED_HEADER_TOKENS.includes(k)) seen.add(k);
    }
  }
  return REQUIRED_HEADER_TOKENS.every((r) => seen.has(r));
}

/* ────────────────────────────────────────────────────────────────
 * Row-to-record translation
 * ──────────────────────────────────────────────────────────────── */

const WELL_ID_RE = /^\d{6,8}\.\d{2}$/;               // "1236430.01" or "1217182.01"
const API_HYPHENATED_RE = /^\d{2}-\d{3}-\d{5}-\d{2}-\d{2}$/;
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
    // ±40 pt tolerance — Diversified's tightest inter-column gap is
    // waterProd(688)→wellStatus(732) = 44 pt, so 40 pt just fits.
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

export async function parsePdsDiversifiedMonthlyPdf(
  buf: Buffer
): Promise<ProductionRecord[]> {
  const items = await extractAllItems(buf);
  if (items.length === 0) {
    throw new Error('PDS Diversified Monthly: pdf-parse returned zero text items');
  }

  const rows = groupIntoRows(items);

  if (!verifyHeaderFingerprint(rows)) {
    throw new Error(
      'PDS Diversified Monthly: header fingerprint missing. ' +
        `Required labels (${REQUIRED_HEADER_TOKENS.map((t) => `"${t}"`).join(', ')}) not all found. ` +
        'Layout may have changed.'
    );
  }

  const records: ProductionRecord[] = [];
  const skipped: string[] = [];

  /*
   * Diversified's layout has two known y-split patterns per well:
   *
   *   Pattern A (most wells): Well ID + API + Date + volumes + status all
   *     on one 6-pt y-bucket, followed by a subunit-name row 6 pt below
   *     that holds only the sub-identifier (e.g. "3202 514") in the
   *     wellName column.
   *
   *   Pattern B (~65 wells out of 277): Well ID alone on one bucket,
   *     API + Date + volumes + status 6 pt below, followed by the
   *     subunit-name row another 6 pt below that.
   *
   * To handle both, we merge each DATA ANCHOR row (defined as the row
   * containing a valid Prod Date) with up to 2 adjacent rows: one
   * IMMEDIATELY ABOVE (to pick up Pattern B's Well ID) and up to 2 BELOW
   * (to pick up the subunit-name continuation + any straggling volume cells).
   *
   * A "Well Status" header token on the merge row blocks absorption — we
   * never accidentally roll the header row into a record.
   */
  const DATE_ANCHOR_TEXTS = new Set(['api', 'well id', 'well name', 'status', 'prod', 'date']);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const roles = assignRoles(row.items, HARDCODED_COLUMN_PLAN);

    // ANCHOR rule: this row must have a valid Prod Date.
    const prodDateStr = roles.prodDate;
    if (!prodDateStr || !PROD_DATE_RE.test(prodDateStr)) continue;

    // Start accumulator with anchor row's roles.
    const acc: Partial<Record<ColumnRole, string>> = { ...roles };

    // LOOK BACK one row: absorb a lone Well ID sitting above this anchor.
    // Gate: same page, vertical gap ≤ 10 pt, the prev row has NO Prod Date
    // of its own (otherwise it's the previous record's anchor).
    if (i > 0) {
      const prev = rows[i - 1];
      if (prev.page === row.page && prev.y - row.y <= 10 && prev.y - row.y >= 0) {
        const prevRoles = assignRoles(prev.items, HARDCODED_COLUMN_PLAN);
        const prevHasDate = !!prevRoles.prodDate && PROD_DATE_RE.test(prevRoles.prodDate);
        const prevHasWellId = !!prevRoles.wellId && WELL_ID_RE.test(prevRoles.wellId);
        const prevIsHeader = prev.items.some((it) =>
          DATE_ANCHOR_TEXTS.has(normHeaderLabel(it.str))
        );
        if (!prevHasDate && prevHasWellId && !prevIsHeader && !acc.wellId) {
          acc.wellId = prevRoles.wellId;
        }
      }
    }

    // Well ID must be present (either on the anchor row or borrowed from above).
    const wellIdRaw = acc.wellId ?? '';
    if (!WELL_ID_RE.test(wellIdRaw)) {
      // Not a real data row — grand-total final row lands here too.
      continue;
    }

    // API must be hyphenated 14-segment form.
    const apiRaw = acc.api ?? '';
    if (!API_HYPHENATED_RE.test(apiRaw)) {
      skipped.push(
        `row at page=${row.page} y=${row.y}: wellId=${wellIdRaw} api="${apiRaw}" not hyphenated`
      );
      continue;
    }

    const apiCompact = stripApiDashes(apiRaw);
    const { api10, api14 } = normalizeApi(apiCompact);

    // LOOK AHEAD up to 2 rows for (a) subunit name continuation, and
    // (b) any straggling volume cells that drifted below the anchor.
    let wellName = (acc.wellName ?? '').trim();
    for (let k = 1; k <= 2; k++) {
      if (i + k >= rows.length) break;
      const next = rows[i + k];
      if (next.page !== row.page) break;
      const gap = row.y - next.y;
      if (gap > 12 || gap < 0) break;

      const nextRoles = assignRoles(next.items, HARDCODED_COLUMN_PLAN);
      const nextHasOwnDate = !!nextRoles.prodDate && PROD_DATE_RE.test(nextRoles.prodDate);
      const nextHasOwnWellId = !!nextRoles.wellId && WELL_ID_RE.test(nextRoles.wellId);
      // Stop if we've reached the next record's anchor or a lone-WellId row
      // that belongs to the next record.
      if (nextHasOwnDate || nextHasOwnWellId) break;

      // Subunit name continuation — append to wellName.
      if (nextRoles.wellName && !isHeaderLabel(nextRoles.wellName)) {
        const cleanedSub = nextRoles.wellName.trim();
        if (cleanedSub) {
          wellName = `${wellName} ${cleanedSub}`.replace(/\s+/g, ' ').trim();
        }
      }
      // Straggling volume cells — fill any unset volume roles from the next row.
      for (const k2 of [
        'oilProd',
        'oilSales',
        'gasProd',
        'gasSales',
        'waterProd',
        'wellStatus',
      ] as ColumnRole[]) {
        if (acc[k2] === undefined && nextRoles[k2] !== undefined) {
          acc[k2] = nextRoles[k2];
        }
      }
    }

    if (!wellName) {
      skipped.push(`row at page=${row.page} y=${row.y}: wellId=${wellIdRaw} but no wellName`);
      continue;
    }

    records.push({
      api14,
      api10,
      wellName,
      combocurveWellId: null,
      operatorWellId: null, // Diversified wellId is dotted (non-int) → extraFields
      prodDate: normalizeMonthlyDate(prodDateStr),
      oilProd: parseNum(acc.oilProd),
      gasProd: parseNum(acc.gasProd),
      waterProd: parseNum(acc.waterProd),
      oilSales: parseNum(acc.oilSales),
      gasSales: parseNum(acc.gasSales),
      waterInj: null,            // Not reported in Diversified Monthly
      daysOn: null,              // Not reported in Diversified Monthly
      choke: null,
      tubingPres: null,
      casingPres: null,
      hoursDown: null,
      downtimeReason: null,
      extraFields: {
        source: 'pds-diversified-monthly-pdf',
        rawProdDate: prodDateStr,
        diversifiedWellId: wellIdRaw,
        wellStatus: acc.wellStatus ?? null,
        rawApi: apiRaw,
      },
    });
  }

  if (records.length === 0) {
    const detail =
      skipped.length > 0
        ? ` Skipped: ${skipped.slice(0, 3).join(' | ')}${skipped.length > 3 ? ` (+${skipped.length - 3} more)` : ''}`
        : '';
    throw new Error(
      `PDS Diversified Monthly: produced 0 records — layout may have changed.${detail}`
    );
  }

  return records;
}

function isHeaderLabel(s: string): boolean {
  return REQUIRED_HEADER_TOKENS.includes(normHeaderLabel(s));
}

/* ────────────────────────────────────────────────────────────────
 * Adapter registration
 * ──────────────────────────────────────────────────────────────── */

export const pdsDiversifiedMonthlyAdapter: FormatAdapter = {
  name: 'PDS Diversified Monthly',
  operatorName: 'Diversified Energy',
  dataType: 'monthly',
  fileKinds: ['pdf'],
  senderEmailPatterns: [/@frioenergypartners\.com$/i, /@div\.energy$/i],

  detect(ctx: ParserContext): boolean {
    if (!ctx.pdfText) return false;
    const text = ctx.pdfText;
    const hasMonthlyHeader = /Monthly Production Estimates/i.test(text);
    const hasPds = /PDS Well Data Exchange/i.test(text);
    const hasDiversified = /Diversified Energy/i.test(text);
    // Guard against future XTO collision: XTO has "Well Status" too but
    // also emits "OilCum"/"GasCum" — Diversified never has those.
    const hasNoCumulatives = !/OilCum/i.test(text) && !/GasCum/i.test(text);
    return hasMonthlyHeader && hasPds && hasDiversified && hasNoCumulatives;
  },

  async parse(ctx: ParserContext): Promise<ProductionRecord[]> {
    return parsePdsDiversifiedMonthlyPdf(ctx.buffer);
  },
};
