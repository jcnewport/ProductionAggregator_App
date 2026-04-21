/**
 * Parser: PDS Well Data Exchange — XTO Energy Daily PDF  (Format 5d)
 * -------------------------------------------------------------------
 * Source format: PDSWDX-DP-XTO-DAILY.pdf
 * Operator:      XTO Energy, Inc. (ExxonMobil subsidiary)
 * Data type:     DAILY production estimates
 *
 * Visual column layout (verified against sample — 17 columns, of which
 * we map 14 to ComboCurve template; the other 3 are deliberately dropped):
 *
 *   Well Num | Well Name | Prod Date |
 *   Producing Status* |                         <-- METADATA, DROPPED
 *   Oil Prod | Oil Sales |
 *   Begin Oil* | End Oil* |                     <-- TANK GAUGES, DROPPED
 *   Gas Prod | Gas Sales |
 *   Water Prod | Water Inj |
 *   Casing | Tubing | Choke | Down Time |
 *   Down Time Reason (free text, wraps across multiple lines)
 *
 *   * = intentionally NOT in the column plan; items at those x-centers
 *       fall outside the ±15 tolerance of any mapped column and drop out
 *       silently (by design).
 *
 * Distinguishing signatures (vs other PDS dailies):
 *   - "Daily Production Estimates" + operator "XTO Energy, Inc."
 *   - "Fort Worth Texas - 76102" address block (XTO HQ) — unique
 *   - Concatenated header labels "WellNumWellName", "EndOilBeginOil",
 *     "WaterProdWaterInj" (pdf-parse collapses adjacent headers)
 *   - "BeginOil" + "EndOil" columns (unique among PDS dailies)
 *   - NO "EOG Resources", "Anadarko", "Conoco", "Completion No"
 *
 * Quirks (unique to XTO Daily, handled below):
 *   1. Rows are 22-24 pt apart (much more than EOG's 18-20 pt) because
 *      every row has room for a 2-line "Down Time Reason" text wrap
 *      (e.g. "Planned: S/I Long " + "Term/PP"). A fixed modular row
 *      bucket can't handle both the 2-pt split and the varying row gap,
 *      so we use sequential proximity clustering (items within 4 pt of
 *      the previous item's y join the same row). Continuations arrive
 *      as separate orphan clusters with ONLY letter-items at x >= 700 —
 *      a second pass merges each orphan into the preceding main row
 *      so the full downtime reason reassembles.
 *   2. Data x-positions are shifted ~6-15 pts right of the header labels
 *      (numbers have a leading space " 0.00"), so the column plan uses
 *      DATA centers, not header centers.
 *   3. Column "Producing Status" holds free text ("Active", "Shut In")
 *      at x≈247 — between prodDate (203) and oilProd (303). Both are
 *      >15 pt away, so Status is silently dropped.
 *   4. 10-digit API ("3002542063"), padded with "0000" to derive API14.
 *   5. Daily date preserved as YYYY-MM-DD.
 *   6. Negative values preserved (allocation corrections).
 */

import pdfParse from 'pdf-parse';
import type { FormatAdapter, ParserContext, ProductionRecord } from './types.js';

function parseNum(token: string | undefined | null): number | null {
  if (token === null || token === undefined) return null;
  const s = String(token).trim();
  if (s === '') return null;
  const cleaned = s.replace(/,/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function normalizeApi(rawApi: string): { api10: string; api14: string } {
  const digits = rawApi.replace(/\D/g, '');
  if (digits === '') return { api10: '', api14: '' };
  const api10 = digits.slice(0, 10).padStart(10, '0');
  const api14 = digits.length >= 14 ? digits.slice(0, 14) : (digits + '0000').slice(0, 14);
  return { api10, api14 };
}

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
 * Sequential-proximity row clustering.
 *
 * Unlike the modular-bucket approach used for Conoco/Anadarko/EOG (where
 * row gaps are regular multiples of the bucket size), XTO has
 * non-uniform row spacing (alternating 22/24 pt) AND a 2-pt main/split
 * AND 10-12 pt text continuations. No fixed bucket size handles all
 * three cleanly. Instead, sort items by descending y and walk them: an
 * item joins the current cluster iff its y is within PROXIMITY of the
 * previous item's y (not the cluster's anchor). The PROXIMITY value (4)
 * captures the 2-pt split but rejects the 10-pt continuation, which is
 * picked up by mergeContinuations() afterward.
 */
const ROW_PROXIMITY_PT = 4;

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

  return rows.map((row) => row.sort((a, b) => a.x - b.x));
}

const LETTER_RE = /[A-Za-z]/;
const DOWNTIME_REASON_X_MIN = 700;

/**
 * Merge "orphan" text continuations into the preceding main row.
 *
 * After groupIntoRows, text wraps like "Term/PP" at y=412 (which is
 * 10 pt below row-1's main at y=424 — beyond PROXIMITY) form their own
 * single-item cluster. These orphans are identifiable: every item is at
 * x >= DOWNTIME_REASON_X_MIN and contains letters. Attach them to the
 * immediately-preceding main row so the full downtime reason
 * ("Planned: S/I Long Term/PP") reassembles.
 */
function mergeContinuations(rows: TextItem[][]): TextItem[][] {
  const out: TextItem[][] = [];
  for (const row of rows) {
    const isOrphanText =
      row.length >= 1 &&
      row.every(
        (it) => it.x >= DOWNTIME_REASON_X_MIN && LETTER_RE.test(it.str)
      );
    if (isOrphanText && out.length > 0) {
      const prev = out[out.length - 1];
      // Only merge if previous row is on same page and at higher y
      // (i.e. is the "parent" in reading order).
      const sameContext =
        prev.length > 0 && prev[0].page === row[0].page;
      if (sameContext) {
        prev.push(...row);
        prev.sort((a, b) => a.x - b.x);
        continue;
      }
    }
    out.push(row);
  }
  return out;
}

type ColumnRole =
  | 'wellID'
  | 'wellName'
  | 'prodDate'
  | 'oilProd'
  | 'oilSales'
  | 'gasProd'
  | 'gasSales'
  | 'waterProd'
  | 'waterInj'
  | 'casingPres'
  | 'tubingPres'
  | 'choke'
  | 'hoursDown'
  | 'downtimeReason';

interface ColumnPlan {
  role: ColumnRole;
  center: number;
}

// Centers reflect DATA positions (not header positions). Verified via
// scripts/peek-xto-daily.ts against PDSWDX-DP-XTO-DAILY.pdf.
const XTO_DAILY_COLUMN_PLAN: readonly ColumnPlan[] = [
  { role: 'wellID',         center: 15  },
  { role: 'wellName',       center: 61  },
  { role: 'prodDate',       center: 203 },
  // Producing Status (x≈247) — DROPPED via tolerance
  { role: 'oilProd',        center: 303 },
  { role: 'oilSales',       center: 334 },
  // BeginOil (x≈363), EndOil (x≈395) — DROPPED via tolerance (tank gauges)
  { role: 'gasProd',        center: 436 },
  { role: 'gasSales',       center: 472 },
  { role: 'waterProd',      center: 515 },
  { role: 'waterInj',       center: 556 },
  { role: 'casingPres',     center: 590 },
  { role: 'tubingPres',     center: 627 },
  { role: 'choke',          center: 661 },
  { role: 'hoursDown',      center: 693 },
  { role: 'downtimeReason', center: 705 },
];

const COLUMN_TOLERANCE_PT = 15;

const HEADER_FINGERPRINTS: readonly string[] = [
  'Daily Production Estimates',
  'XTO Energy',
  'BeginOil',
  'EndOil',
  'GasProd',
  'WaterProd',
];

function verifyHeaderFingerprints(items: TextItem[]): string[] {
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
 * Assign items to columns.
 * - Letter-containing items at x >= 700 force-route to downtimeReason
 *   (so "Planned: S/I Long" and "Term/PP" concat regardless of their
 *   exact x jitter).
 * - All other items match by nearest column center within ±15 pt.
 * - downtimeReason is skipped in the distance match (only accepts
 *   items via the letter-override above), so stray numeric items near
 *   x=705 correctly route to hoursDown instead.
 */
function assignRoles(row: TextItem[]): Partial<Record<ColumnRole, string>> {
  const out: Partial<Record<ColumnRole, string>> = {};
  for (const it of row) {
    if (it.x >= DOWNTIME_REASON_X_MIN && LETTER_RE.test(it.str)) {
      const cur = out.downtimeReason;
      const piece = it.str.trim();
      if (piece.length > 0) {
        out.downtimeReason = cur ? `${cur} ${piece}` : piece;
      }
      continue;
    }
    let bestRole: ColumnRole | null = null;
    let bestDistance = Infinity;
    for (const col of XTO_DAILY_COLUMN_PLAN) {
      if (col.role === 'downtimeReason') continue;
      const d = Math.abs(it.x - col.center);
      if (d < bestDistance) {
        bestDistance = d;
        bestRole = col.role;
      }
    }
    if (bestRole && bestDistance <= COLUMN_TOLERANCE_PT) {
      // First-write wins: if column already filled, keep the first value
      // (prevents later split-row items from overwriting main-row values).
      if (out[bestRole] === undefined) {
        out[bestRole] = it.str.trim();
      }
    }
  }
  return out;
}

const PROD_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const API_OR_WELLNUM_RE = /^\d{10}$/; // XTO Well Num column is 10-digit

function isHeaderLabel(s: string): boolean {
  const n = s.trim().toLowerCase();
  return (
    n === 'well num' ||
    n === 'well name' ||
    n === 'well id' ||
    n === 'prod date' ||
    n === 'producing status' ||
    n === 'producing' ||
    n === 'status' ||
    n === 'oil prod' ||
    n === 'oil sales' ||
    n === 'oilprod' ||
    n === 'oilsales' ||
    n === 'begin oil' ||
    n === 'end oil' ||
    n === 'beginoil' ||
    n === 'endoil' ||
    n === 'gas prod' ||
    n === 'gas sales' ||
    n === 'gasprod' ||
    n === 'gassales' ||
    n === 'water prod' ||
    n === 'water inj' ||
    n === 'waterprod' ||
    n === 'waterinj' ||
    n === 'casing' ||
    n === 'tubing' ||
    n === 'choke' ||
    n === 'down time' ||
    n === 'downtime' ||
    n === 'down' ||
    n === 'time' ||
    n === 'reason' ||
    n === 'down time reason' ||
    n === 'downtime reason'
  );
}

// Producing Status values ("Active", "Shut In", etc.) may occasionally
// slip through tolerance if data drifts. Guard against them being
// recorded as well names.
function isStatusValue(s: string): boolean {
  const n = s.trim().toLowerCase();
  return (
    n === 'active' ||
    n === 'inactive' ||
    n === 'shut in' ||
    n === 'shut-in' ||
    n === 'producing' ||
    n === 'temporarily abandoned' ||
    n === 'temp abandoned'
  );
}

export async function parsePdsXtoDailyPdf(buf: Buffer): Promise<ProductionRecord[]> {
  const items = await extractAllItems(buf);
  if (items.length === 0) {
    throw new Error('PDS XTO Daily: pdf-parse returned zero text items');
  }

  const missing = verifyHeaderFingerprints(items);
  if (missing.length > 0) {
    throw new Error(
      `PDS XTO Daily: header fingerprint failed — missing labels [${missing.join(
        ', '
      )}]. Layout may have changed; column centers need re-verification ` +
        `via scripts/peek-xto-daily.ts.`
    );
  }

  const rawRows = groupIntoRows(items);
  const rows = mergeContinuations(rawRows);

  let lastWellID: string | null = null;
  let lastWellName: string | null = null;

  const records: ProductionRecord[] = [];
  const skipped: string[] = [];

  for (const row of rows) {
    const roles = assignRoles(row);

    // Track the most recent well identity across rows, since on the
    // "main" row of each record XTO always repeats wellNum + wellName.
    // (Defensive: if a row ever skipped them we'd carry them forward.)
    if (roles.wellID && API_OR_WELLNUM_RE.test(roles.wellID)) {
      lastWellID = roles.wellID;
    }
    if (
      roles.wellName &&
      !isHeaderLabel(roles.wellName) &&
      !isStatusValue(roles.wellName)
    ) {
      lastWellName = roles.wellName;
    }

    const prodDateStr = roles.prodDate;
    if (!prodDateStr || !PROD_DATE_RE.test(prodDateStr)) continue;

    const volumeCount =
      (roles.oilProd !== undefined ? 1 : 0) +
      (roles.gasProd !== undefined ? 1 : 0) +
      (roles.waterProd !== undefined ? 1 : 0) +
      (roles.oilSales !== undefined ? 1 : 0) +
      (roles.gasSales !== undefined ? 1 : 0);
    if (volumeCount < 1) {
      skipped.push(
        `data row at y=${row[0].y.toFixed(0)}: date="${prodDateStr}" but no volume columns`
      );
      continue;
    }

    const wellName =
      roles.wellName && !isHeaderLabel(roles.wellName) && !isStatusValue(roles.wellName)
        ? roles.wellName
        : lastWellName ?? '';
    if (!wellName) {
      skipped.push(
        `data row at y=${row[0].y.toFixed(0)}: no wellName (nor recent)`
      );
      continue;
    }

    const rawApi =
      roles.wellID && API_OR_WELLNUM_RE.test(roles.wellID)
        ? roles.wellID
        : lastWellID ?? '';
    const { api10, api14 } = normalizeApi(rawApi);
    const wellID = rawApi;

    records.push({
      api14,
      api10,
      wellName,
      combocurveWellId: null,
      operatorWellId: wellID ? Number(wellID) : null,
      prodDate: prodDateStr,
      oilProd: parseNum(roles.oilProd),
      gasProd: parseNum(roles.gasProd),
      waterProd: parseNum(roles.waterProd),
      oilSales: parseNum(roles.oilSales),
      gasSales: parseNum(roles.gasSales),
      waterInj: parseNum(roles.waterInj),
      daysOn: null,
      choke: roles.choke ? String(roles.choke).trim() : null,
      tubingPres: parseNum(roles.tubingPres),
      casingPres: parseNum(roles.casingPres),
      hoursDown: parseNum(roles.hoursDown),
      downtimeReason: roles.downtimeReason ?? null,
      extraFields: {
        source: 'pds-xto-daily-pdf',
        rawApi: rawApi || null,
      },
    });
  }

  if (records.length === 0) {
    const detail =
      skipped.length > 0
        ? ` Skipped: ${skipped.slice(0, 3).join(' | ')}${
            skipped.length > 3 ? ` (+${skipped.length - 3} more)` : ''
          }`
        : '';
    throw new Error(
      `PDS XTO Daily: produced 0 records — layout may have changed.${detail}`
    );
  }

  return records;
}

export const pdsXtoDailyAdapter: FormatAdapter = {
  name: 'PDS XTO Daily',
  operatorName: 'XTO Energy (ExxonMobil)',
  dataType: 'daily',
  fileKinds: ['pdf'],
  senderEmailPatterns: [
    /@pdswdx\.com$/i,
    /@frioenergy\.com$/i,
    /@frioenergypartners\.com$/i,
    /@xtoenergy\.com$/i,
    /@exxonmobil\.com$/i,
  ],

  detect(ctx: ParserContext): boolean {
    if (!ctx.pdfText) return false;
    const text = ctx.pdfText;
    const hasDailyHeader = /Daily\s*Production\s*Estimates/i.test(text);
    const hasXto = /XTO\s*Energy/i.test(text);
    // "BeginOil" and "EndOil" (tank gauge columns) are unique to XTO
    // among PDS dailies — decisive distinguisher vs any other PDS format.
    const hasBeginEnd =
      /Begin\s*Oil/i.test(text) && /End\s*Oil/i.test(text);
    // Must NOT be any other operator
    const otherOperator =
      /EOG\s*Resources/i.test(text) ||
      /Anadarko\s*Petroleum/i.test(text) ||
      /Mewbourne\s*Oil/i.test(text) ||
      /Completion\s*No/i.test(text); // Conoco marker
    return hasDailyHeader && hasXto && hasBeginEnd && !otherOperator;
  },

  async parse(ctx: ParserContext): Promise<ProductionRecord[]> {
    return parsePdsXtoDailyPdf(ctx.buffer);
  },
};
