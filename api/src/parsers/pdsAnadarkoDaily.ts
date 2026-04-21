/**
 * Parser: PDS Well Data Exchange — Anadarko (Oxy) Daily PDF  (Format 5a)
 * ----------------------------------------------------------------------
 * Source format: PDSWDX-DP-Anadarko- DAILY.pdf  (note: stray space in filename)
 * Operator:      Anadarko Petroleum Corporation (Oxy / Occidental) via Frio
 * Data type:     DAILY production estimates
 *
 * Visual column layout (verified against sample — 15 columns):
 *   Well ID | Well Name | API | Prod Date |
 *   Oil Prod | Oil Sales | Gas Prod | Gas Sales | Water Prod | Water Inject |
 *   Casing Pres | Tubing Pres. | Choke | Downtime | Downtime Reason
 *
 * NOTE on column ORDER:
 *   - Casing Pres sits BEFORE Tubing Pres. — opposite of ConocoPhillips
 *   - Water Inject is INSIDE the main column band (not at the right) —
 *     different from the monthly sibling
 *   These are NOT spec violations; they're what the PDF actually emits.
 *   Verified via peek-anadarko-daily.ts.
 *
 * Header layout quirk: like Conoco Daily, each column label is stacked
 * across 3-5 text rows in the PDF header band. We use the same
 * **hardcoded column-center plan + runtime header-fingerprint
 * verification** pattern. If PDS ever reformats the layout, parsing
 * fails loudly instead of silently mis-mapping.
 *
 * Distinguishing signatures (vs other PDS dailies):
 *   - "Daily Production Estimates" + "PDS Well Data Exchange"
 *   - "Anadarko Petroleum Corporation" in first 5 lines of text
 *   - "Water Inject" (with 't' — EOG Daily uses "Water Inj")
 *   - "Downtime" single word (EOG uses "Hours Down")
 *   - NO "BHP" / NO "Completion No" (those flag Conoco)
 *
 * Quirks:
 *   1. 14-digit API — straightforward first-10 = API10, first-14 = API14.
 *   2. Each data row splits across two y-buckets: main data at y=Y
 *      and the well name on a sibling sub-row at y=Y-2. Row spacing
 *      between data rows is 18-20 pt. A 16-pt row bucket merges the
 *      two sub-rows into one logical row while keeping adjacent rows
 *      separate.
 *   3. Downtime Reason is wide TEXT at x≈637-645; it sits near the
 *      Downtime numeric column (x≈620). Items containing letters are
 *      force-assigned to downtimeReason regardless of x-distance;
 *      numeric items near x=620 go to hoursDown.
 *   4. Water Inject is almost always 0.00 in samples — captured per
 *      template column 15.
 *   5. Daily date preserved as YYYY-MM-DD (no monthly normalization).
 *   6. Negative values preserved as-is (allocation corrections).
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

// normalizeApi imported from apiNormalization.js (shared, correctness-validated).
// Anadarko supplies a 14-digit API, which is the simple passthrough case.

/* ────────────────────────────────────────────────────────────────
 * Positional extraction — same pattern as pdsConocoPhillipsDaily.
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
 * Group items by (page, y-bucket). Bucket size = 16 pt.
 *
 * In Anadarko Daily samples, adjacent sub-rows within one logical
 * record sit 2 pt apart (e.g. y=404 with the numbers, y=402 with
 * just the well name). Between records, y decreases by 18-20 pt.
 * A 16-pt bucket:
 *   - merges {404, 402} into the same bucket (both → 400)
 *   - keeps {404} and {386} in separate buckets (400 vs 384)
 * Verified with peek-anadarko-daily.ts on page 1.
 */
function groupIntoRows(items: TextItem[]): TextItem[][] {
  const byKey = new Map<string, TextItem[]>();
  for (const it of items) {
    const yBucket = Math.round(it.y / 16) * 16;
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
 * Tolerance ±20 pt when assigning items to columns.
 * ──────────────────────────────────────────────────────────────── */

type ColumnRole =
  | 'wellID'
  | 'wellName'
  | 'api'
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

const ANADARKO_COLUMN_PLAN: readonly ColumnPlan[] = [
  { role: 'wellID',         center: 20  },
  { role: 'wellName',       center: 60  },
  { role: 'api',            center: 174 },
  { role: 'prodDate',       center: 222 },
  { role: 'oilProd',        center: 285 },
  { role: 'oilSales',       center: 325 },
  { role: 'gasProd',        center: 365 },
  { role: 'gasSales',       center: 405 },
  { role: 'waterProd',      center: 446 },
  { role: 'waterInj',       center: 486 },
  { role: 'casingPres',     center: 518 },
  { role: 'tubingPres',     center: 548 },
  { role: 'choke',          center: 585 },
  { role: 'hoursDown',      center: 620 },
  { role: 'downtimeReason', center: 670 },
];

// Known header fingerprints — if any fail to appear in page 1's top
// band we bail with an explicit error.
const HEADER_FINGERPRINTS: readonly string[] = [
  'Well ID',
  'Well Name',
  'API',
  // "Prod Date" is split into "Prod " and "Date"; match the individual
  // tokens instead of the phrase.
  'Date',
  'Water',
  'Inject',
  'Tubing',
  'Casing',
  'Choke',
  'Downtime Reason',
];

function verifyHeaderFingerprints(items: TextItem[]): string[] {
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

const LETTER_RE = /[A-Za-z]/;

/**
 * Assign each item in a row to its role. Special-case: Downtime Reason
 * is free text starting at x≈637 and can overlap the right edge of
 * the hoursDown column (≈620). Resolve by content type: if the item
 * contains letters AND its x >= 630, force it to downtimeReason;
 * otherwise use closest-center distance.
 */
function assignRoles(row: TextItem[]): Partial<Record<ColumnRole, string>> {
  const out: Partial<Record<ColumnRole, string>> = {};
  for (const it of row) {
    // Free-text downtime reason override.
    if (it.x >= 630 && LETTER_RE.test(it.str)) {
      const cur = out.downtimeReason;
      out.downtimeReason = cur ? `${cur} ${it.str.trim()}` : it.str.trim();
      continue;
    }
    let bestRole: ColumnRole | null = null;
    let bestDistance = Infinity;
    for (const col of ANADARKO_COLUMN_PLAN) {
      // Don't let downtimeReason win for non-text items.
      if (col.role === 'downtimeReason') continue;
      const d = Math.abs(it.x - col.center);
      if (d < bestDistance) {
        bestDistance = d;
        bestRole = col.role;
      }
    }
    if (bestRole && bestDistance <= 20) {
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
const API_RE = /^\d{10,14}$/;

function isHeaderLabel(s: string): boolean {
  const n = s.trim().toLowerCase();
  return (
    n === 'well name' ||
    n === 'well id' ||
    n === 'api' ||
    n === 'prod date' ||
    n === 'oil prod' ||
    n === 'oil sales' ||
    n === 'gas prod' ||
    n === 'gas sales' ||
    n === 'water prod' ||
    n === 'water inject' ||
    n === 'tubing pres.' ||
    n === 'casing pres' ||
    n === 'choke' ||
    n === 'downtime' ||
    n === 'downtime reason'
  );
}

/* ────────────────────────────────────────────────────────────────
 * Core parser
 * ──────────────────────────────────────────────────────────────── */

export async function parsePdsAnadarkoDailyPdf(
  buf: Buffer
): Promise<ProductionRecord[]> {
  const items = await extractAllItems(buf);
  if (items.length === 0) {
    throw new Error('PDS Anadarko Daily: pdf-parse returned zero text items');
  }

  const missing = verifyHeaderFingerprints(items);
  if (missing.length > 0) {
    throw new Error(
      `PDS Anadarko Daily: header fingerprint failed — missing labels [${missing.join(
        ', '
      )}]. Layout may have changed; column centers need re-verification ` +
        `via scripts/peek-anadarko-daily.ts.`
    );
  }

  const rows = groupIntoRows(items);

  // Carry-forward identity fields — defensive. In practice the 16-pt
  // bucket catches Anadarko's 2-pt sub-row split, but this absorbs any
  // edge case where the well name sits farther from the data line.
  let lastWellID: string | null = null;
  let lastWellName: string | null = null;
  let lastApiRaw: string | null = null;

  const records: ProductionRecord[] = [];
  const skipped: string[] = [];

  for (const row of rows) {
    const roles = assignRoles(row);

    if (roles.wellID && /^\d+$/.test(roles.wellID)) lastWellID = roles.wellID;
    if (roles.wellName && !isHeaderLabel(roles.wellName)) {
      lastWellName = roles.wellName;
    }
    if (roles.api && API_RE.test(roles.api)) lastApiRaw = roles.api;

    // Must have a prodDate + at least one volume.
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
    const wellID = roles.wellID ?? lastWellID ?? '';

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
      waterInj: parseNum(roles.waterInj),
      daysOn: null,
      // choke is string per ProductionRecord (operators sometimes emit "64/64").
      // Anadarko reports it as a plain number — preserve as-is string form.
      choke: roles.choke ? String(roles.choke).trim() : null,
      tubingPres: parseNum(roles.tubingPres),
      casingPres: parseNum(roles.casingPres),
      hoursDown: parseNum(roles.hoursDown),
      downtimeReason: roles.downtimeReason ?? null,
      extraFields: {
        source: 'pds-anadarko-daily-pdf',
        rawApi: rawApi || null,
      },
    });
  }

  if (records.length === 0) {
    const detail =
      skipped.length > 0
        ? ` Skipped: ${skipped.slice(0, 3).join(' | ')}${skipped.length > 3 ? ` (+${skipped.length - 3} more)` : ''}`
        : '';
    throw new Error(
      `PDS Anadarko Daily: produced 0 records — layout may have changed.${detail}`
    );
  }

  return records;
}

/* ────────────────────────────────────────────────────────────────
 * Adapter registration
 * ──────────────────────────────────────────────────────────────── */

export const pdsAnadarkoDailyAdapter: FormatAdapter = {
  name: 'PDS Anadarko Daily',
  operatorName: 'Anadarko Petroleum (Oxy)',
  dataType: 'daily',
  fileKinds: ['pdf'],
  senderEmailPatterns: [
    /@pdswdx\.com$/i,
    /@frioenergy\.com$/i,
    /@frioenergypartners\.com$/i,
    /@oxy\.com$/i,
    /@anadarko\.com$/i,
  ],

  detect(ctx: ParserContext): boolean {
    if (!ctx.pdfText) return false;
    const text = ctx.pdfText;
    const hasDailyHeader = /Daily Production Estimates/i.test(text);
    const hasPds = /PDS Well Data Exchange/i.test(text);
    const hasAnadarko = /Anadarko\s*Petroleum/i.test(text);
    // "Water Inject" (with 't') is Anadarko's tell versus EOG's "Water Inj".
    const hasWaterInject = /Water\s*Inject/i.test(text);
    // Must NOT be Conoco (those flag with Completion No + BHP).
    const looksLikeConoco = /Completion\s*No/i.test(text) && /\bBHP\b/.test(text);
    return (
      hasDailyHeader && hasPds && hasAnadarko && hasWaterInject && !looksLikeConoco
    );
  },

  async parse(ctx: ParserContext): Promise<ProductionRecord[]> {
    return parsePdsAnadarkoDailyPdf(ctx.buffer);
  },
};
