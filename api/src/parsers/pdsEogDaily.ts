/**
 * Parser: PDS Well Data Exchange — EOG Resources Daily PDF  (Format 5b)
 * ---------------------------------------------------------------------
 * Source format: PDSWDX-DP-EOG-DAILY.pdf
 * Operator:      EOG Resources, Inc. via Frio Energy Holdings
 * Data type:     DAILY production estimates
 *
 * Visual column layout (verified against sample — 14 columns):
 *   Well ID | Well Name | API | Prod Date |
 *   Gas Prod | Gas Sales | Oil Prod | Oil Sales | Water Prod |
 *   Choke | Tubing Pres. | Casing Pres | Hours Down | Water Inj |
 *   Downtime Reason
 *
 * IMPORTANT: EOG emits Gas columns BEFORE Oil columns — opposite of
 * every other PDS Daily in the project. Column-plan x-centers reflect
 * this. The header fingerprint check ensures the layout hasn't shifted.
 *
 * Distinguishing signatures (vs other PDS dailies):
 *   - "Daily Production Estimates" + "PDS Well Data Exchange"
 *   - "EOG Resources" operator name
 *   - "Water Inj" (NOT "Water Inject") — distinguishes from Anadarko
 *   - "Hours" + "Down" stacked header — distinguishes from Anadarko's "Downtime"
 *   - NO "Completion No" and NO "BHP" — rules out Conoco
 *
 * Quirks:
 *   1. Data rows sometimes split into left+right halves at 2-pt y-spacing
 *      (y=422 left / y=424 right). 8-pt row bucket merges both halves
 *      into one logical row without colliding adjacent rows (18-20 pt).
 *   2. Sometimes a data row is single-line (everything at y=404).
 *   3. Sometimes API floats alone on its own 2-pt sub-row.
 *   4. 14-digit API — direct.
 *   5. Daily date preserved as YYYY-MM-DD (no monthly normalization).
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
 * 8-pt row bucket.
 * - Merges the 2-pt left/right split (e.g. y=422 with y=424 → bucket 424).
 * - Merges the API sub-row split (e.g. y=368 with y=366 → bucket 368).
 * - Keeps adjacent records (18 pt apart) in separate buckets.
 * Verified via peek-eog-daily.ts.
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

type ColumnRole =
  | 'wellID'
  | 'wellName'
  | 'api'
  | 'prodDate'
  | 'gasProd'
  | 'gasSales'
  | 'oilProd'
  | 'oilSales'
  | 'waterProd'
  | 'choke'
  | 'tubingPres'
  | 'casingPres'
  | 'hoursDown'
  | 'waterInj'
  | 'downtimeReason';

interface ColumnPlan {
  role: ColumnRole;
  center: number;
}

const EOG_COLUMN_PLAN: readonly ColumnPlan[] = [
  { role: 'wellID',         center: 18  },
  { role: 'wellName',       center: 55  },
  { role: 'api',            center: 175 },
  { role: 'prodDate',       center: 240 },
  { role: 'gasProd',        center: 298 },
  { role: 'gasSales',       center: 335 },
  { role: 'oilProd',        center: 382 },
  { role: 'oilSales',       center: 420 },
  { role: 'waterProd',      center: 458 },
  { role: 'choke',          center: 490 },
  { role: 'tubingPres',     center: 518 },
  { role: 'casingPres',     center: 556 },
  { role: 'hoursDown',      center: 592 },
  { role: 'waterInj',       center: 632 },
  { role: 'downtimeReason', center: 680 },
];

const HEADER_FINGERPRINTS: readonly string[] = [
  'Well ID',
  'Well Name',
  'API',
  'Date',
  'Choke',
  'Tubing',
  'Casing',
  'Hours',        // distinguishing from Anadarko
  'Water',
  'Inj',          // "Water Inj" (distinguishing from Anadarko's "Water Inject")
  'Downtime',
  'Reason',
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
 * Assign items to columns. Downtime Reason (free text at x≈648+) can
 * overlap the right edge of Water Inj (x≈632); letter-containing items
 * at x >= 645 force-route to downtimeReason. Numbers near x=632 go to
 * waterInj as expected.
 */
function assignRoles(row: TextItem[]): Partial<Record<ColumnRole, string>> {
  const out: Partial<Record<ColumnRole, string>> = {};
  for (const it of row) {
    if (it.x >= 645 && LETTER_RE.test(it.str)) {
      const cur = out.downtimeReason;
      out.downtimeReason = cur ? `${cur} ${it.str.trim()}` : it.str.trim();
      continue;
    }
    let bestRole: ColumnRole | null = null;
    let bestDistance = Infinity;
    for (const col of EOG_COLUMN_PLAN) {
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

const PROD_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const API_RE = /^\d{10,14}$/;

function isHeaderLabel(s: string): boolean {
  const n = s.trim().toLowerCase();
  return (
    n === 'well name' ||
    n === 'well id' ||
    n === 'api' ||
    n === 'prod date' ||
    n === 'gas prod' ||
    n === 'gas sales' ||
    n === 'oil prod' ||
    n === 'oil sales' ||
    n === 'water prod' ||
    n === 'water inj' ||
    n === 'tubing pres.' ||
    n === 'casing pres' ||
    n === 'hours down' ||
    n === 'choke' ||
    n === 'downtime reason'
  );
}

export async function parsePdsEogDailyPdf(buf: Buffer): Promise<ProductionRecord[]> {
  const items = await extractAllItems(buf);
  if (items.length === 0) {
    throw new Error('PDS EOG Daily: pdf-parse returned zero text items');
  }

  const missing = verifyHeaderFingerprints(items);
  if (missing.length > 0) {
    throw new Error(
      `PDS EOG Daily: header fingerprint failed — missing labels [${missing.join(
        ', '
      )}]. Layout may have changed; column centers need re-verification ` +
        `via scripts/peek-eog-daily.ts.`
    );
  }

  const rows = groupIntoRows(items);

  let lastWellID: string | null = null;
  let lastWellName: string | null = null;
  let lastApiRaw: string | null = null;

  const records: ProductionRecord[] = [];
  const skipped: string[] = [];

  for (const row of rows) {
    const roles = assignRoles(row);

    if (roles.wellID && /^\d+$/.test(roles.wellID)) lastWellID = roles.wellID;
    if (roles.wellName && !isHeaderLabel(roles.wellName)) lastWellName = roles.wellName;
    if (roles.api && API_RE.test(roles.api)) lastApiRaw = roles.api;

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
        source: 'pds-eog-daily-pdf',
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
      `PDS EOG Daily: produced 0 records — layout may have changed.${detail}`
    );
  }

  return records;
}

export const pdsEogDailyAdapter: FormatAdapter = {
  name: 'PDS EOG Daily',
  operatorName: 'EOG Resources',
  dataType: 'daily',
  fileKinds: ['pdf'],
  senderEmailPatterns: [
    /@pdswdx\.com$/i,
    /@frioenergy\.com$/i,
    /@frioenergypartners\.com$/i,
    /@eogresources\.com$/i,
  ],

  detect(ctx: ParserContext): boolean {
    if (!ctx.pdfText) return false;
    const text = ctx.pdfText;
    const hasDailyHeader = /Daily Production Estimates/i.test(text);
    const hasPds = /PDS Well Data Exchange/i.test(text);
    const hasEog = /EOG\s*Resources/i.test(text);
    // "Water Inj" (not "Water Inject") distinguishes from Anadarko Daily.
    const hasWaterInj = /Water\s*Inj(?!ect)/i.test(text);
    // Must NOT be Conoco (Completion No + BHP).
    const looksLikeConoco = /Completion\s*No/i.test(text) && /\bBHP\b/.test(text);
    return (
      hasDailyHeader && hasPds && hasEog && hasWaterInj && !looksLikeConoco
    );
  },

  async parse(ctx: ParserContext): Promise<ProductionRecord[]> {
    return parsePdsEogDailyPdf(ctx.buffer);
  },
};
