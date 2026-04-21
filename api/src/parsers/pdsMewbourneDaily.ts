/**
 * Parser: PDS Well Data Exchange — Mewbourne Oil Daily PDF  (Format 5c)
 * ---------------------------------------------------------------------
 * Source format: PDSWDX-DP-mewbourne-DAILY.pdf
 * Operator:      Mewbourne Oil Company (for West Pecos Trading Company LLC)
 * Data type:     DAILY production estimates
 *
 * Visual column layout (verified against sample — 10 columns mapped):
 *
 *   Well ID (8-digit) | Well Name | API (10-digit) | [Comp.Id blank] |
 *   Prod Date | Gas Prod | Oil Prod | Water Prod |
 *   Tubing Pres. | Casing Pres. | Choke
 *
 * IMPORTANT differences from Mewbourne MONTHLY (Format 3):
 *   - No BTU column.
 *   - No Oil Begin / Oil End (tank-gauge) columns.
 *   - No OilSales / GasSales columns (daily only reports gross Prod).
 *   - No DaysOn column.
 *   - API is present as a 10-digit field (NOT 8-digit like the monthly).
 *     The 8-digit column is the Mewbourne internal "Well ID", stored
 *     separately in operatorWellId.
 *   - Pressure and Choke columns ARE present (monthly does not have them).
 *   - Comp.Id header exists but column is blank in the sample.
 *
 * Distinguishing signatures (vs other PDS dailies):
 *   - "Daily Production Estimates" + "Mewbourne Oil Company"
 *   - "PDS Well Data Exchange"
 *   - "* Gas at State Pressure Base" footnote (Mewbourne-specific)
 *   - Gas Prod column BEFORE Oil Prod (unusual among PDS formats,
 *     matching EOG Daily)
 *
 * Layout quirks (handled below):
 *   1. Some rows are single-line (all items at one y, e.g. y=328),
 *      others split across two y-values 2 pt apart (Well ID + Name
 *      on the lower line, everything else on the upper). Sequential
 *      proximity clustering at 4-pt handles both cases uniformly.
 *   2. Inter-row gap is ~18 pt, well above the 4-pt cluster threshold.
 *   3. Prod Date already in YYYY-MM-DD format — preserved.
 *   4. Numbers have a leading space and may contain thousands commas
 *      ("2,412.69"); parseNum strips commas.
 *   5. No downtime columns; no free-text columns — no letter-detection
 *      override needed.
 *   6. 10-digit API → api14 padded with "0000".
 */

import pdfParse from 'pdf-parse';
import type { FormatAdapter, ParserContext, ProductionRecord } from './types.js';
import { normalizeApi } from './apiNormalization.js';

function parseNum(token: string | undefined | null): number | null {
  if (token === null || token === undefined) return null;
  const s = String(token).trim();
  if (s === '') return null;
  const cleaned = s.replace(/,/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
// API normalization moved to shared apiNormalization.ts — no more padStart bug.

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
 * Sequential-proximity row clustering at 4 pt.
 * - Merges the 2-pt well-identity sub-row split (y=382 with y=384).
 * - Keeps 18-pt-apart adjacent rows in separate clusters.
 * - No text continuations in Mewbourne Daily, so no second pass needed.
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

type ColumnRole =
  | 'wellID'
  | 'wellName'
  | 'api'
  | 'prodDate'
  | 'gasProd'
  | 'oilProd'
  | 'waterProd'
  | 'tubingPres'
  | 'casingPres'
  | 'choke';

interface ColumnPlan {
  role: ColumnRole;
  center: number;
}

// Centers reflect DATA positions (not header positions). Verified via
// scripts/peek-mewbourne-daily.ts against PDSWDX-DP-mewbourne-DAILY.pdf.
// Gas Prod comes BEFORE Oil Prod (matches EOG Daily, unusual among PDS).
const MEWBOURNE_DAILY_COLUMN_PLAN: readonly ColumnPlan[] = [
  { role: 'wellID',     center: 20  },
  { role: 'wellName',   center: 79  },
  { role: 'api',        center: 250 },
  { role: 'prodDate',   center: 389 },
  { role: 'gasProd',    center: 471 },
  { role: 'oilProd',    center: 545 },
  { role: 'waterProd',  center: 620 },
  { role: 'tubingPres', center: 670 },
  { role: 'casingPres', center: 710 },
  { role: 'choke',      center: 752 },
];

const COLUMN_TOLERANCE_PT = 15;

const HEADER_FINGERPRINTS: readonly string[] = [
  'Daily Production Estimates',
  'Mewbourne Oil Company',
  'Well ID',
  'Well Name',
  'API',
  'Prod',
  'Tubing',
  'Casing',
  'Choke',
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
 * Assign items to columns by nearest-center match within ±15 pt.
 * First-write wins per role (prevents later split-row items from
 * overwriting main-row values).
 */
function assignRoles(row: TextItem[]): Partial<Record<ColumnRole, string>> {
  const out: Partial<Record<ColumnRole, string>> = {};
  for (const it of row) {
    let bestRole: ColumnRole | null = null;
    let bestDistance = Infinity;
    for (const col of MEWBOURNE_DAILY_COLUMN_PLAN) {
      const d = Math.abs(it.x - col.center);
      if (d < bestDistance) {
        bestDistance = d;
        bestRole = col.role;
      }
    }
    if (bestRole && bestDistance <= COLUMN_TOLERANCE_PT) {
      if (out[bestRole] === undefined) {
        out[bestRole] = it.str.trim();
      }
    }
  }
  return out;
}

const PROD_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WELL_ID_RE = /^\d{8}$/; // Mewbourne Well ID is 8-digit
const API_RE = /^\d{10}$/;     // Mewbourne API is 10-digit

function isHeaderLabel(s: string): boolean {
  const n = s.trim().toLowerCase();
  return (
    n === 'well id' ||
    n === 'well name' ||
    n === 'api' ||
    n === 'comp.id' ||
    n === 'compl.id' ||
    n === 'comp id' ||
    n === 'prod date' ||
    n === 'prod' ||
    n === 'date' ||
    n === 'oil prod' ||
    n === 'gas prod' ||
    n === 'water prod' ||
    n === 'oil' ||
    n === 'gas' ||
    n === 'water' ||
    n === 'tubing' ||
    n === 'casing' ||
    n === 'press.' ||
    n === 'press' ||
    n === 'choke'
  );
}

export async function parsePdsMewbourneDailyPdf(buf: Buffer): Promise<ProductionRecord[]> {
  const items = await extractAllItems(buf);
  if (items.length === 0) {
    throw new Error('PDS Mewbourne Daily: pdf-parse returned zero text items');
  }

  const missing = verifyHeaderFingerprints(items);
  if (missing.length > 0) {
    throw new Error(
      `PDS Mewbourne Daily: header fingerprint failed — missing labels [${missing.join(
        ', '
      )}]. Layout may have changed; column centers need re-verification ` +
        `via scripts/peek-mewbourne-daily.ts.`
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

    if (roles.wellID && WELL_ID_RE.test(roles.wellID)) {
      lastWellID = roles.wellID;
    }
    if (roles.wellName && !isHeaderLabel(roles.wellName)) {
      lastWellName = roles.wellName;
    }
    if (roles.api && API_RE.test(roles.api)) {
      lastApiRaw = roles.api;
    }

    const prodDateStr = roles.prodDate;
    if (!prodDateStr || !PROD_DATE_RE.test(prodDateStr)) continue;

    const volumeCount =
      (roles.oilProd !== undefined ? 1 : 0) +
      (roles.gasProd !== undefined ? 1 : 0) +
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
      oilProd: parseNum(roles.oilProd),
      gasProd: parseNum(roles.gasProd),
      waterProd: parseNum(roles.waterProd),
      oilSales: null,   // Mewbourne Daily has no sales columns
      gasSales: null,   // Mewbourne Daily has no sales columns
      waterInj: null,   // Mewbourne Daily has no water injection column
      daysOn: null,
      choke: roles.choke ? String(roles.choke).trim() : null,
      tubingPres: parseNum(roles.tubingPres),
      casingPres: parseNum(roles.casingPres),
      hoursDown: null,      // Mewbourne Daily has no hoursDown column
      downtimeReason: null, // Mewbourne Daily has no downtime reason column
      extraFields: {
        source: 'pds-mewbourne-daily-pdf',
        rawApi: rawApi || null,
        mewbourneWellId: wellID || null,
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
      `PDS Mewbourne Daily: produced 0 records — layout may have changed.${detail}`
    );
  }

  return records;
}

export const pdsMewbourneDailyAdapter: FormatAdapter = {
  name: 'PDS Mewbourne Daily',
  operatorName: 'Mewbourne Oil Company',
  dataType: 'daily',
  fileKinds: ['pdf'],
  senderEmailPatterns: [
    /@pdswdx\.com$/i,
    /@frioenergy\.com$/i,
    /@frioenergypartners\.com$/i,
    /@mewbourne\.com$/i,
  ],

  detect(ctx: ParserContext): boolean {
    if (!ctx.pdfText) return false;
    const text = ctx.pdfText;
    const hasDailyHeader = /Daily\s*Production\s*Estimates/i.test(text);
    const hasMewbourne = /Mewbourne\s*Oil/i.test(text);
    // PDS boilerplate OR the Mewbourne-specific footnote anchor
    const hasPdsOrFootnote =
      /PDS\s*Well\s*Data\s*Exchange/i.test(text) ||
      /Gas\s*at\s*State\s*Pressure\s*Base/i.test(text);
    // Must NOT be another operator
    const otherOperator =
      /EOG\s*Resources/i.test(text) ||
      /Anadarko\s*Petroleum/i.test(text) ||
      /XTO\s*Energy/i.test(text) ||
      /Completion\s*No/i.test(text); // Conoco marker
    return hasDailyHeader && hasMewbourne && hasPdsOrFootnote && !otherOperator;
  },

  async parse(ctx: ParserContext): Promise<ProductionRecord[]> {
    return parsePdsMewbourneDailyPdf(ctx.buffer);
  },
};
