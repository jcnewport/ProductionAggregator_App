/**
 * Parser: PDS Well Data Exchange — Diamondback Energy Daily PDF  (Format 5e)
 * --------------------------------------------------------------------------
 * Source format: PDSWDX-DP-DIAMONDBACK-*.pdf
 * Operator:      Diamondback Energy via Frio Energy Partners
 * Data type:     DAILY production estimates
 *
 * First seen:    2026-04-28 (file -187003).  Until that date Diamondback
 *                only forwarded MONTHLY reports (parser: pdsDiamondbackMonthly).
 *                The daily layout shares essentially nothing with the monthly
 *                — completely different column set, column order, and a
 *                free-text Downtime Reason column the monthly does not have.
 *                Treat as a separate format.
 *
 * Visual column layout (verified against 2026-04-28 sample — 12 columns):
 *   Well ID (10-digit) | API (10-digit) | Well Name | Prod Date |
 *   Gas Prod | Oil Prod | Water Prod |
 *   Tubing PSI | Casing PSI | Hours Flowed | Hours Down | Downtime Reason
 *
 * Distinguishing signatures (vs other PDS dailies):
 *   - "Daily Production Estimates" + "Diamondback Energy"
 *   - Contact line "production@diamondbackenergy.com"
 *   - "Hours Flowed" header (unique among PDS dailies — Diamondback
 *     reports BOTH Hours Flowed AND Hours Down; siblings only have Down)
 *   - NO Sales columns (daily reports gross production only)
 *   - Gas Prod comes BEFORE Oil Prod (matches EOG Daily / Mewbourne
 *     Daily; opposite of Anadarko/Conoco)
 *
 * Quirks the parser handles:
 *   1. Some rows split across two y-buckets that are 18-20 pt apart
 *      (e.g. y=408 has 11 fields including Casing PSI 100.00, but
 *      y=390 has Casing PSI on its OWN sub-row at y=388 with the
 *      other 11 fields at y=390). A 16-pt row bucket merges these
 *      cleanly while keeping adjacent rows in separate buckets.
 *   2. Downtime Reason is free text at x≈683 that wraps to the next
 *      line — e.g. "SHUT IN FOR OFFSET FRAC" emits as
 *      ["SHUT IN FOR OFFSET "] at y=408, ["FRAC"] alone at y=398.
 *      We use the same letter-content override pattern as Anadarko
 *      Daily: items containing letters at x >= 660 are force-routed
 *      to downtimeReason regardless of nearest-column distance, and
 *      multiple letter items in the same row are joined with a space.
 *      Per-row continuation (y=398 "FRAC") is captured by the
 *      16-pt bucket folding it onto the previous row.
 *   3. 10-digit Well ID ("1001777500") → operatorWellId (int).
 *   4. 10-digit API ("4232931211") → api10/api14 (pad with "0000").
 *   5. Hours Flowed is reported per-day. There's no template column for
 *      it (hoursDown is the inverse). Captured in extraFields.hoursFlowed.
 *   6. Negative production values preserved (parser-spec rule).
 *   7. Daily date preserved as YYYY-MM-DD.
 *
 * Field mapping to ProductionRecord:
 *   Well ID         → operatorWellId
 *   API             → api10 / api14
 *   Well Name       → wellName
 *   Prod Date       → prodDate
 *   Gas Prod        → gasProd
 *   Oil Prod        → oilProd
 *   Water Prod      → waterProd
 *   Tubing PSI      → tubingPres
 *   Casing PSI      → casingPres
 *   Hours Flowed    → extraFields.hoursFlowed
 *   Hours Down      → hoursDown
 *   Downtime Reason → downtimeReason
 *   (no oilSales/gasSales/waterInj/choke/daysOn — not in this format)
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
 * Positional extraction — same scaffold as other PDS daily parsers.
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
 * Group items into rows via TIGHT sequential-proximity clustering
 * (4 pt) + an orphan-text merge pass — same pattern as XTO Daily.
 *
 * Why TWO passes instead of one wider proximity threshold:
 *   In the 2026-04-28 sample, well "PENROSE OLDHAM 27 3" emits its 8
 *   data rows just 18 pt apart, with a "FRAC" downtime-reason
 *   continuation 10 pt below each data row. That continuation pattern
 *   means EVERY adjacent y-gap is ≤ 10 pt:
 *     y=408 (data 04-27) → y=398 (FRAC) → y=390 (data 04-26) → ...
 *   A single sequential proximity threshold of 12 pt collapses every
 *   row of well 1 into one cluster.
 *
 *   The two-pass solution is cleaner: cluster tightly at 4 pt (each
 *   "logical line" stays separate), then a second pass identifies
 *   orphan letter-only rows at x >= DOWNTIME_REASON_X_MIN and folds
 *   them into the preceding main row. The 2-pt Casing-alone sub-row
 *   split (e.g. y=390 + y=388) is handled because both are within
 *   the 4-pt threshold. This is the same algorithm pdsXtoDaily uses.
 */
const ROW_PROXIMITY_PT = 4;
const LETTER_RE = /[A-Za-z]/;
const DOWNTIME_REASON_X_MIN = 660;

function groupIntoRows(items: TextItem[]): TextItem[][] {
  const sorted = [...items].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    return b.y - a.y;
  });

  const rows: TextItem[][] = [];
  let current: TextItem[] = [];
  let lastY: number | null = null;
  let lastPage: number | null = null;

  for (const it of sorted) {
    const sameCluster =
      lastY !== null &&
      lastPage === it.page &&
      lastY - it.y <= ROW_PROXIMITY_PT &&
      lastY - it.y >= 0;
    if (!sameCluster) {
      if (current.length > 0) rows.push(current);
      current = [];
    }
    current.push(it);
    lastY = it.y;
    lastPage = it.page;
  }
  if (current.length > 0) rows.push(current);

  // Pass 2 — fold orphan downtime-reason continuations into preceding row.
  const merged: TextItem[][] = [];
  for (const row of rows) {
    const isOrphanText =
      row.length >= 1 &&
      row.every(
        (it) => it.x >= DOWNTIME_REASON_X_MIN && LETTER_RE.test(it.str)
      );
    if (isOrphanText && merged.length > 0) {
      const prev = merged[merged.length - 1];
      const sameContext = prev.length > 0 && prev[0].page === row[0].page;
      if (sameContext) {
        prev.push(...row);
        prev.sort((a, b) => a.x - b.x);
        continue;
      }
    }
    merged.push(row);
  }

  return merged.map((row) => row.sort((a, b) => a.x - b.x));
}

/* ────────────────────────────────────────────────────────────────
 * Hardcoded column plan — x-centers from positional peek of the
 * 2026-04-28 Diamondback DP sample. Tolerance ±20 pt.
 * ──────────────────────────────────────────────────────────────── */

type ColumnRole =
  | 'wellID'
  | 'api'
  | 'wellName'
  | 'prodDate'
  | 'gasProd'
  | 'oilProd'
  | 'waterProd'
  | 'tubingPres'
  | 'casingPres'
  | 'hoursFlowed'
  | 'hoursDown'
  | 'downtimeReason';

interface ColumnPlan {
  role: ColumnRole;
  center: number;
}

const DIAMONDBACK_DAILY_COLUMN_PLAN: readonly ColumnPlan[] = [
  { role: 'wellID',         center: 24  },
  { role: 'api',            center: 67  },
  { role: 'wellName',       center: 127 },
  { role: 'prodDate',       center: 307 },
  { role: 'gasProd',        center: 386 },
  { role: 'oilProd',        center: 437 },
  { role: 'waterProd',      center: 484 },
  { role: 'tubingPres',     center: 527 },
  { role: 'casingPres',     center: 574 },
  { role: 'hoursFlowed',    center: 622 },
  { role: 'hoursDown',      center: 658 },
  { role: 'downtimeReason', center: 683 },
];

const COLUMN_TOLERANCE_PT = 20;

// Diamondback's header band stacks multi-word labels across DIFFERENT
// y-lines (e.g. "Hours" at y=444 with "Flowed" at y=434, "DownTime" at
// y=446 with "Reason" at y=436). After we flatten the top band into a
// single string for a substring check, those phrases land non-adjacent
// in the resulting text, so a fingerprint like "Hours Flowed" would
// fail. Match on INDIVIDUAL tokens instead — the combination of these
// six is uniquely Diamondback Daily within our PDS registry.
const HEADER_FINGERPRINTS: readonly string[] = [
  'Well ID',
  'API',
  'Well Name',
  'Prod Date',
  'Tubing',
  'Casing',
  'Hours',
  'DownTime',
];

function verifyHeaderFingerprints(items: TextItem[]): string[] {
  // Diamondback's PDF places a "Production Related Inquiries:" contact
  // line at y≈562 — far above the column-header band at y≈434-446.
  // A maxY-100 top-band slice would exclude the actual headers. Just
  // scan the entire page 1.
  const page1 = items.filter((it) => it.page === 1);
  if (page1.length === 0) return ['no items on page 1'];
  const allText = page1.map((i) => i.str.trim()).join(' | ');
  const missing: string[] = [];
  for (const label of HEADER_FINGERPRINTS) {
    if (!allText.toLowerCase().includes(label.toLowerCase())) {
      missing.push(label);
    }
  }
  return missing;
}

/**
 * Assign each item to a role. Free-text downtime reason starts at
 * x≈683 and continuation rows can drift left ("FRAC" alone). Force
 * any letter-only item with x >= 660 into downtimeReason regardless
 * of nearest-column distance.
 */
function assignRoles(row: TextItem[]): Partial<Record<ColumnRole, string>> {
  const out: Partial<Record<ColumnRole, string>> = {};
  for (const it of row) {
    const trimmed = it.str.trim();
    if (it.x >= 660 && LETTER_RE.test(trimmed) && !/^\d/.test(trimmed)) {
      const cur = out.downtimeReason;
      out.downtimeReason = cur ? `${cur} ${trimmed}` : trimmed;
      continue;
    }
    let bestRole: ColumnRole | null = null;
    let bestDistance = Infinity;
    for (const col of DIAMONDBACK_DAILY_COLUMN_PLAN) {
      if (col.role === 'downtimeReason') continue;
      const d = Math.abs(it.x - col.center);
      if (d < bestDistance) {
        bestDistance = d;
        bestRole = col.role;
      }
    }
    if (bestRole && bestDistance <= COLUMN_TOLERANCE_PT) {
      if (out[bestRole] === undefined) {
        out[bestRole] = trimmed;
      }
    }
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────
 * Row → record translation
 * ──────────────────────────────────────────────────────────────── */

const PROD_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WELL_ID_RE = /^\d{10}$/;
const API_RE = /^\d{10}$/;

function isHeaderLabel(s: string): boolean {
  const n = s.trim().toLowerCase();
  return (
    n === 'well id' ||
    n === 'api' ||
    n === 'well name' ||
    n === 'prod date' ||
    n === 'prod' ||
    n === 'date' ||
    n === 'gas prod' ||
    n === 'oil prod' ||
    n === 'water prod' ||
    n === 'gas' ||
    n === 'oil' ||
    n === 'water' ||
    n === 'tubing' ||
    n === 'casing' ||
    n === 'hours' ||
    n === 'flowed' ||
    n === 'down' ||
    n === 'hours flowed' ||
    n === 'hours down' ||
    n === 'downtime' ||
    n === 'downtime reason' ||
    n === 'reason'
  );
}

/* ────────────────────────────────────────────────────────────────
 * Core parser
 * ──────────────────────────────────────────────────────────────── */

export async function parsePdsDiamondbackDailyPdf(
  buf: Buffer
): Promise<ProductionRecord[]> {
  const items = await extractAllItems(buf);
  if (items.length === 0) {
    throw new Error('PDS Diamondback Daily: pdf-parse returned zero text items');
  }

  const missing = verifyHeaderFingerprints(items);
  if (missing.length > 0) {
    throw new Error(
      `PDS Diamondback Daily: header fingerprint failed — missing labels [${missing.join(
        ', '
      )}]. Layout may have changed; column centers need re-verification.`
    );
  }

  const rows = groupIntoRows(items);

  // Carry-forward identity fields. The 16-pt bucket usually pulls all
  // identity items into the data row, but some samples drift the
  // Casing PSI value to its own sub-bucket — defensive guard.
  let lastWellID: string | null = null;
  let lastApiRaw: string | null = null;
  let lastWellName: string | null = null;

  const records: ProductionRecord[] = [];
  const skipped: string[] = [];

  for (const row of rows) {
    const roles = assignRoles(row);

    if (roles.wellID && WELL_ID_RE.test(roles.wellID)) {
      lastWellID = roles.wellID;
    }
    if (roles.api && API_RE.test(roles.api)) {
      lastApiRaw = roles.api;
    }
    if (roles.wellName && !isHeaderLabel(roles.wellName)) {
      lastWellName = roles.wellName;
    }

    const prodDateStr = roles.prodDate;
    if (!prodDateStr || !PROD_DATE_RE.test(prodDateStr)) continue;

    // For Diamondback every dated row carries volumes (often all 0.00 for
    // SHUT IN wells, but they're still present). Require at least one
    // numeric volume column to confirm we got the data row.
    const volumeCount =
      (roles.gasProd !== undefined ? 1 : 0) +
      (roles.oilProd !== undefined ? 1 : 0) +
      (roles.waterProd !== undefined ? 1 : 0);
    if (volumeCount < 1) {
      skipped.push(
        `data row at y=${row[0].y.toFixed(0)}: date="${prodDateStr}" but no volume columns`
      );
      continue;
    }

    const wellName =
      roles.wellName && !isHeaderLabel(roles.wellName)
        ? roles.wellName
        : lastWellName ?? '';
    if (!wellName) {
      skipped.push(
        `data row at y=${row[0].y.toFixed(0)}: no wellName (nor recent)`
      );
      continue;
    }

    const rawApi = roles.api && API_RE.test(roles.api) ? roles.api : lastApiRaw ?? '';
    const { api10, api14 } = normalizeApi(rawApi);
    const wellID =
      roles.wellID && WELL_ID_RE.test(roles.wellID) ? roles.wellID : lastWellID ?? '';

    records.push({
      api14,
      api10,
      wellName,
      combocurveWellId: null,
      operatorWellId: wellID ? Number(wellID) : null,
      prodDate: prodDateStr,
      gasProd: parseNum(roles.gasProd),
      oilProd: parseNum(roles.oilProd),
      waterProd: parseNum(roles.waterProd),
      gasSales: null, // Diamondback Daily does not report sales
      oilSales: null,
      waterInj: null,
      daysOn: null,
      choke: null, // not in Diamondback Daily layout
      tubingPres: parseNum(roles.tubingPres),
      casingPres: parseNum(roles.casingPres),
      hoursDown: parseNum(roles.hoursDown),
      downtimeReason: roles.downtimeReason ?? null,
      extraFields: {
        source: 'pds-diamondback-daily-pdf',
        rawApi: rawApi || null,
        diamondbackWellId: wellID || null,
        hoursFlowed: parseNum(roles.hoursFlowed),
      },
    });
  }

  if (records.length === 0) {
    // Same empty-report tolerance as Mewbourne Daily — if zero
    // date-shaped tokens were even seen in the PDF, it's a header-only
    // empty report (no production this period). Don't flag as failure.
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
      `PDS Diamondback Daily: produced 0 records but ${dateCandidateCount} ` +
        `date-shaped tokens found — layout may have changed.${detail}`
    );
  }

  return records;
}

/* ────────────────────────────────────────────────────────────────
 * Adapter registration
 * ──────────────────────────────────────────────────────────────── */

export const pdsDiamondbackDailyAdapter: FormatAdapter = {
  name: 'PDS Diamondback Daily',
  operatorName: 'Diamondback Energy',
  dataType: 'daily',
  fileKinds: ['pdf'],
  senderEmailPatterns: [
    /@pdswdx\.com$/i,
    /@frioenergy\.com$/i,
    /@frioenergypartners\.com$/i,
    /@diamondbackenergy\.com$/i,
  ],

  detect(ctx: ParserContext): boolean {
    if (!ctx.pdfText) return false;
    const text = ctx.pdfText;
    const hasDailyHeader = /Daily\s*Production\s*Estimates/i.test(text);
    const hasDiamondback =
      /Diamondback\s*Energy/i.test(text) ||
      /production@diamondbackenergy\.com/i.test(text);
    const hasPds = /PDS\s*Well\s*Data\s*Exchange/i.test(text);
    // Hours Flowed is the strongest distinguishing column — no other PDS
    // daily we ingest reports it.
    const hasHoursFlowed = /Hours\s*Flowed/i.test(text);
    // Must NOT be other operators with overlapping layouts.
    const otherOperator =
      /EOG\s*Resources/i.test(text) ||
      /Anadarko\s*Petroleum/i.test(text) ||
      /XTO\s*Energy/i.test(text) ||
      /Matador\s*Resources/i.test(text) ||
      /Diversified\s*Energy/i.test(text) ||
      /Mewbourne\s*Oil/i.test(text) ||
      /Completion\s*No/i.test(text); // Conoco marker
    return (
      hasDailyHeader && hasDiamondback && hasPds && hasHoursFlowed && !otherOperator
    );
  },

  async parse(ctx: ParserContext): Promise<ProductionRecord[]> {
    return parsePdsDiamondbackDailyPdf(ctx.buffer);
  },
};
