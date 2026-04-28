/**
 * Parser: PDS Well Data Exchange — Diversified Energy Daily PDF  (Format 5g)
 * --------------------------------------------------------------------------
 * Source format: PDSWDX-DP-DIVERSIFIED-*.pdf
 * Operator:      Diversified Energy for WEST PECOS TRADING COMPANY, LLC
 * Data type:     DAILY production estimates
 *
 * First seen:    2026-04-28 (file -187004). Until that date Diversified
 *                only forwarded MONTHLY reports (parser: pdsDiversifiedMonthly).
 *
 * Visual column layout (verified against 2026-04-28 sample — 15 columns):
 *   API | Well ID | Well Name | Prod Date |
 *   Oil Prod | Oil Sales | Gas Prod | Gas Sale | Water Prod |
 *   Well Status | Tubing Pres. | Casing Pres. | Choke | Hrs Down | Comments
 *
 * Distinguishing signatures (vs other PDS dailies AND vs Diversified Monthly):
 *   - "Daily Production Estimates" + "Diversified Energy"
 *   - Oklahoma City HQ ("100 East Main Street", "405-702-1600")
 *   - "Hrs Down" header (Monthly does not have this column)
 *   - "Comments" header (Monthly does not have this column)
 *   - 10-digit BARE API "3002526927" — Monthly emits HYPHENATED API
 *     "30-025-42711-00-00", so we use API format as a tell vs the
 *     monthly sibling
 *   - Dotted Well ID "1237430.01" — same format as Monthly
 *
 * Why positional (x/y) extraction with LOOK-BACK + LOOK-AHEAD merger:
 *   The same multi-row-per-record pattern as Diversified Monthly applies,
 *   plus an additional 2-pt split for the Prod Date column. Examples:
 *
 *     Service Well (no volumes):
 *       y=380: [23]"3002526927" | [77]"1237430.01"
 *       y=378: [122]"EAST VACUUM..." | [232]"2026-04-24" | [497]"Service "
 *       y=370: [122]"0449 001W" | [497]"Well"
 *
 *     Producing well (some volumes):
 *       y=238: [23]"3002524644" | [77]"1237685.01"
 *       y=236: [122]"EAST VACUUM..." | [232]"2026-04-24" | [294]" 0.00"
 *              | [497]"Producing"
 *       y=228: [122]"0449 128"
 *
 *   The ANCHOR row is the row containing the valid Prod Date. We then
 *   look back ONE row for a lone (API + Well ID) above, and look ahead
 *   up to TWO rows for the wellName subunit continuation and any
 *   straggling volume / status cells. Same algorithm as the monthly
 *   sibling — we only re-parameterize the column plan and date handling.
 *
 * Quirks the parser handles:
 *   1. 2-pt anchor / sub-anchor split (above).
 *   2. Multi-line wellName: parent name on anchor row, subunit identifier
 *      on the next row 8-10 pt below.
 *   3. Multi-line Well Status: "Service " + "Well" on consecutive rows,
 *      "Temporarily " + "Abandoned", etc. We concatenate on emit.
 *   4. 10-digit bare API → normalizeApi pads to api14 with "0000".
 *   5. Service Wells / Shut-In wells with all-blank volumes are EMITTED
 *      (downstream filters decide). They're real production records — they
 *      just report zero/no volume for that day.
 *   6. Multi-page (74 pages in 2026-04-28 sample). Headers only on page 1.
 *      HARDCODED_COLUMN_PLAN applies globally.
 *   7. Final "TOTAL :" row at end of report has no Well ID and no Prod Date
 *      → naturally excluded by the anchor gate.
 *   8. Daily date YYYY-MM-DD preserved.
 *   9. Negative production values preserved.
 *
 * Field mapping to ProductionRecord:
 *   API           → api10 / api14
 *   Well ID       → extraFields.diversifiedWellId
 *   Well Name     → wellName (parent + subunit concatenated)
 *   Prod Date     → prodDate
 *   Oil Prod      → oilProd
 *   Oil Sales     → oilSales
 *   Gas Prod      → gasProd
 *   Gas Sale      → gasSales
 *   Water Prod    → waterProd
 *   Well Status   → extraFields.wellStatus
 *   Tubing Pres.  → tubingPres
 *   Casing Pres.  → casingPres
 *   Choke         → choke (string)
 *   Hrs Down      → hoursDown
 *   Comments      → extraFields.comments
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
 * Group items by (page, y-bucket) at 2 pt — the daily layout has 2-pt
 * anchor / sub-anchor splits we want to keep separate so the look-back
 * / look-ahead merger can drive the merge logic explicitly.
 */
function groupIntoRows(items: TextItem[]): { page: number; y: number; items: TextItem[] }[] {
  const byKey = new Map<string, TextItem[]>();
  for (const it of items) {
    const yBucket = Math.round(it.y / 2) * 2;
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
 * Column plan — Diversified Daily 15-column layout.
 * ──────────────────────────────────────────────────────────────── */

type ColumnRole =
  | 'api'         // 10-digit bare
  | 'wellId'      // "1237430.01" → extraFields.diversifiedWellId
  | 'wellName'
  | 'prodDate'
  | 'oilProd'
  | 'oilSales'
  | 'gasProd'
  | 'gasSales'
  | 'waterProd'
  | 'wellStatus'
  | 'tubingPres'
  | 'casingPres'
  | 'choke'
  | 'hoursDown'
  | 'comments';

const HARDCODED_COLUMN_PLAN: { role: ColumnRole; center: number }[] = [
  { role: 'api',        center: 23  },
  { role: 'wellId',     center: 77  },
  { role: 'wellName',   center: 122 },
  { role: 'prodDate',   center: 232 },
  { role: 'oilProd',    center: 294 },
  { role: 'oilSales',   center: 341 },
  { role: 'gasProd',    center: 388 },
  { role: 'gasSales',   center: 428 },
  { role: 'waterProd',  center: 475 },
  { role: 'wellStatus', center: 500 },
  { role: 'tubingPres', center: 552 },
  { role: 'casingPres', center: 595 },
  { role: 'choke',      center: 631 },
  { role: 'hoursDown',  center: 685 },
  { role: 'comments',   center: 704 },
];

const REQUIRED_HEADER_TOKENS = [
  'api',
  'well id',
  'well name',
  'comments',
];

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

const WELL_ID_RE = /^\d{6,8}\.\d{2}$/;
const API_RE = /^\d{10}$/;
const PROD_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const HEADER_LABELS = new Set([
  'api',
  'well id',
  'well name',
  'oil',
  'gas',
  'water',
  'prod',
  'sales',
  'sale',
  'date',
  'well',
  'status',
  'tubing',
  'casing',
  'pres.',
  'pres',
  'choke',
  'hrs',
  'down',
  'comments',
]);

function isHeaderLabel(s: string): boolean {
  return HEADER_LABELS.has(normHeaderLabel(s));
}

/* ────────────────────────────────────────────────────────────────
 * Role assignment — identical pattern to other PDS dailies
 * ──────────────────────────────────────────────────────────────── */

function assignRoles(row: TextItem[]): Partial<Record<ColumnRole, string>> {
  const out: Partial<Record<ColumnRole, string>> = {};
  for (const it of row) {
    let bestRole: ColumnRole | null = null;
    let bestDistance = Infinity;
    for (const col of HARDCODED_COLUMN_PLAN) {
      const d = Math.abs(it.x - col.center);
      if (d < bestDistance) {
        bestDistance = d;
        bestRole = col.role;
      }
    }
    // ±20 pt tolerance — Diversified columns sit 30-50 pt apart so
    // 20 leaves comfortable margin on either side without colliding.
    if (bestRole && bestDistance <= 20) {
      if (out[bestRole] === undefined) {
        out[bestRole] = it.str.trim();
      }
    }
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────
 * Core parser — anchor-walk with look-back / look-ahead merge.
 * ──────────────────────────────────────────────────────────────── */

export async function parsePdsDiversifiedDailyPdf(
  buf: Buffer
): Promise<ProductionRecord[]> {
  const items = await extractAllItems(buf);
  if (items.length === 0) {
    throw new Error('PDS Diversified Daily: pdf-parse returned zero text items');
  }

  const rows = groupIntoRows(items);

  if (!verifyHeaderFingerprint(rows)) {
    throw new Error(
      'PDS Diversified Daily: header fingerprint missing. ' +
        `Required labels (${REQUIRED_HEADER_TOKENS.map((t) => `"${t}"`).join(', ')}) not all found. ` +
        'Layout may have changed.'
    );
  }

  const records: ProductionRecord[] = [];
  const skipped: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const roles = assignRoles(row.items);

    // ANCHOR: row containing valid Prod Date.
    const prodDateStr = roles.prodDate;
    if (!prodDateStr || !PROD_DATE_RE.test(prodDateStr)) continue;

    const acc: Partial<Record<ColumnRole, string>> = { ...roles };

    // LOOK BACK one row for a lone (API + Well ID) sitting above.
    // Gate: same page, ≤ 4 pt gap, prev row has NO prod date, NO header tokens.
    if (i > 0) {
      const prev = rows[i - 1];
      const gap = prev.y - row.y;
      if (prev.page === row.page && gap >= 0 && gap <= 4) {
        const prevRoles = assignRoles(prev.items);
        const prevHasDate =
          !!prevRoles.prodDate && PROD_DATE_RE.test(prevRoles.prodDate);
        const prevIsHeader = prev.items.some((it) => isHeaderLabel(it.str));
        if (!prevHasDate && !prevIsHeader) {
          if (!acc.api && prevRoles.api && API_RE.test(prevRoles.api)) {
            acc.api = prevRoles.api;
          }
          if (!acc.wellId && prevRoles.wellId && WELL_ID_RE.test(prevRoles.wellId)) {
            acc.wellId = prevRoles.wellId;
          }
          // Also absorb wellName if the anchor row didn't carry it
          if (!acc.wellName && prevRoles.wellName && !isHeaderLabel(prevRoles.wellName)) {
            acc.wellName = prevRoles.wellName;
          }
        }
      }
    }

    // Anchor must end up with valid API + WellId — otherwise it's noise
    // (header row, total row, footer text, etc).
    if (!acc.api || !API_RE.test(acc.api)) continue;
    if (!acc.wellId || !WELL_ID_RE.test(acc.wellId)) continue;

    // LOOK AHEAD up to 3 rows for:
    //   - wellName subunit continuation (e.g. "0449 001W")
    //   - status continuation ("Service " + "Well", "Temporarily " + "Abandoned")
    //   - straggling volume / pressure cells that drifted below
    //
    // Window is 10 pt: the subunit continuation typically sits 6-8 pt
    // below the anchor. Anything beyond 10 pt belongs to a different
    // row (the next record, OR the per-well "TOTAL :" sums row which
    // sits ~14-19 pt below the last data row of each well — the TOTAL
    // row contains aggregate values that would corrupt the last record
    // if absorbed; see also the explicit total-row skip below).
    let wellName = (acc.wellName ?? '').trim();
    let wellStatus = (acc.wellStatus ?? '').trim();

    for (let k = 1; k <= 3; k++) {
      if (i + k >= rows.length) break;
      const next = rows[i + k];
      if (next.page !== row.page) break;
      const gap = row.y - next.y;
      if (gap > 10 || gap < 0) break;

      const nextRoles = assignRoles(next.items);
      const nextHasOwnDate =
        !!nextRoles.prodDate && PROD_DATE_RE.test(nextRoles.prodDate);
      // The row IMMEDIATELY following the anchor's lookback partner is
      // the next record's anchor — stop when we see a fresh date or a
      // fresh API/WellID pairing that's not part of our continuation.
      if (nextHasOwnDate) break;
      const nextHasFreshApi = nextRoles.api && API_RE.test(nextRoles.api);
      const nextHasFreshWellId = nextRoles.wellId && WELL_ID_RE.test(nextRoles.wellId);
      if (nextHasFreshApi && nextHasFreshWellId) break;
      // Skip per-well "TOTAL :" sums rows. They sit below the last data
      // row of each well and contain aggregate values — absorbing those
      // into the last record would corrupt water_inj-shaped totals into
      // hours_down etc. PDS Diversified emits "TOTAL :" with a space
      // before the colon (matches both `Total :` and `TOTAL :` cases).
      const nextText = next.items.map((it) => it.str).join(' ');
      if (/\bTOTAL\b\s*:/i.test(nextText)) break;

      // Subunit-name continuation
      if (nextRoles.wellName && !isHeaderLabel(nextRoles.wellName)) {
        const sub = nextRoles.wellName.trim();
        if (sub) wellName = `${wellName} ${sub}`.replace(/\s+/g, ' ').trim();
      }
      // Status continuation
      if (nextRoles.wellStatus && !isHeaderLabel(nextRoles.wellStatus)) {
        const stat = nextRoles.wellStatus.trim();
        if (stat) wellStatus = `${wellStatus} ${stat}`.replace(/\s+/g, ' ').trim();
      }
      // Straggling volume / pressure / choke / comments
      for (const col of [
        'oilProd',
        'oilSales',
        'gasProd',
        'gasSales',
        'waterProd',
        'tubingPres',
        'casingPres',
        'choke',
        'hoursDown',
        'comments',
      ] as ColumnRole[]) {
        if (acc[col] === undefined && nextRoles[col] !== undefined) {
          acc[col] = nextRoles[col];
        }
      }
    }

    if (!wellName) {
      skipped.push(`row at page=${row.page} y=${row.y}: no wellName`);
      continue;
    }

    const { api10, api14 } = normalizeApi(acc.api);

    records.push({
      api14,
      api10,
      wellName,
      combocurveWellId: null,
      operatorWellId: null, // Diversified wellId is dotted (non-int)
      prodDate: prodDateStr,
      oilProd: parseNum(acc.oilProd),
      gasProd: parseNum(acc.gasProd),
      waterProd: parseNum(acc.waterProd),
      oilSales: parseNum(acc.oilSales),
      gasSales: parseNum(acc.gasSales),
      waterInj: null,
      daysOn: null,
      choke: acc.choke ? String(acc.choke).trim() : null,
      tubingPres: parseNum(acc.tubingPres),
      casingPres: parseNum(acc.casingPres),
      hoursDown: parseNum(acc.hoursDown),
      downtimeReason: acc.comments ? String(acc.comments).trim() : null,
      extraFields: {
        source: 'pds-diversified-daily-pdf',
        diversifiedWellId: acc.wellId,
        wellStatus: wellStatus || null,
        comments: acc.comments ?? null,
        rawApi: acc.api,
      },
    });
  }

  if (records.length === 0) {
    const dateCandidateCount = items.filter((it) =>
      PROD_DATE_RE.test(it.str.trim())
    ).length;
    if (dateCandidateCount === 0) {
      return [];
    }
    const detail =
      skipped.length > 0
        ? ` Skipped: ${skipped.slice(0, 3).join(' | ')}${skipped.length > 3 ? ` (+${skipped.length - 3} more)` : ''}`
        : '';
    throw new Error(
      `PDS Diversified Daily: produced 0 records but ${dateCandidateCount} ` +
        `date-shaped tokens found — layout may have changed.${detail}`
    );
  }

  return records;
}

/* ────────────────────────────────────────────────────────────────
 * Adapter registration
 * ──────────────────────────────────────────────────────────────── */

export const pdsDiversifiedDailyAdapter: FormatAdapter = {
  name: 'PDS Diversified Daily',
  operatorName: 'Diversified Energy',
  dataType: 'daily',
  fileKinds: ['pdf'],
  senderEmailPatterns: [
    /@pdswdx\.com$/i,
    /@frioenergy\.com$/i,
    /@frioenergypartners\.com$/i,
    /@dgoc\.com$/i,
    /@dgoperating\.com$/i,
  ],

  detect(ctx: ParserContext): boolean {
    if (!ctx.pdfText) return false;
    const text = ctx.pdfText;
    const hasDailyHeader = /Daily\s*Production\s*Estimates/i.test(text);
    const hasDiversified = /Diversified\s*Energy/i.test(text);
    const hasPds = /PDS\s*Well\s*Data\s*Exchange/i.test(text);
    // Hrs Down + Comments are unique to Diversified Daily (the Monthly
    // sibling has neither).
    const hasHrsDown = /Hrs\s*Down/i.test(text);
    const hasComments = /Comments/i.test(text);
    // Must NOT be Monthly (has Oil Sales but no Hrs Down/Comments).
    const looksLikeMonthly = /Monthly\s*Production\s*Estimates/i.test(text);
    // Must NOT be other operators with overlap.
    const otherOperator =
      /Diamondback\s*Energy/i.test(text) ||
      /Matador\s*Resources/i.test(text) ||
      /EOG\s*Resources/i.test(text) ||
      /Anadarko\s*Petroleum/i.test(text) ||
      /XTO\s*Energy/i.test(text) ||
      /Mewbourne\s*Oil/i.test(text);
    return (
      hasDailyHeader &&
      hasDiversified &&
      hasPds &&
      hasHrsDown &&
      hasComments &&
      !looksLikeMonthly &&
      !otherOperator
    );
  },

  async parse(ctx: ParserContext): Promise<ProductionRecord[]> {
    return parsePdsDiversifiedDailyPdf(ctx.buffer);
  },
};
