/**
 * Parser: PDS Well Data Exchange — Mewbourne Oil Monthly PDF  (Format 3)
 * ----------------------------------------------------------------------
 * Source format: PDSWDX-MP-mewbourne-MONTHLY.pdf
 * Operator:      Mewbourne Oil Company (for West Pecos Trading Company LLC)
 * Data type:     MONTHLY production estimates
 *
 * Visual column layout (verified against sample — 14 columns):
 *   Well Num | Well Name | API | Compl.ID | Prod Date |
 *   BTU | Oil Begin | Oil Prod | OilSales | Oil End |
 *   Gas Prod | GasSales | Water Prod | DaysOn
 *
 * CRITICAL distinction vs. spec note about "8-digit API":
 *   Despite the project spec's Format 3 note, the actual PDF has a
 *   SEPARATE 8-digit "Well Num" column AND a 10-digit "API" column.
 *   The 8-digit is Mewbourne's internal Well ID (same as in the Daily
 *   format, Format 5c) and is stored in operatorWellId. The 10-digit
 *   API is the real state-assigned API, padded to 14 with trailing
 *   "0000" per project convention.
 *
 * Tank-gauge columns (DO NOT map to production volumes):
 *   - Oil Begin — tank-gauge inventory at start of month.
 *   - Oil End   — tank-gauge inventory at end of month.
 *   These are tank-inventory readings, NOT production. They are
 *   preserved in extraFields for audit but never reach Oil Prod / Sales.
 *
 * Other non-template columns preserved in extraFields:
 *   - BTU    — gas quality (heating value).
 *   - Compl.ID — Mewbourne internal completion identifier.
 *   - DaysOn  — days producing in the month (stored in daysOn field
 *     since it IS part of the ProductionRecord schema for monthlies).
 *
 * Layout quirks (handled below):
 *   1. Rows are split across two y-values ~2 pt apart, with additional
 *      10-12 pt continuations like "(H3OG)" lines beneath. Sequential-
 *      proximity clustering at 4 pt merges the 2-pt sub-row split while
 *      keeping (H3OG) / adjacent data rows in separate clusters.
 *   2. Some data rows are single-line; the same 4-pt threshold handles
 *      both patterns uniformly.
 *   3. Oil Begin on one row equals Oil End of the previous month — data
 *      carryover, not a parsing ambiguity. We just read each row on its
 *      own.
 *   4. Numbers have a leading space and may contain thousands commas
 *      ("103,162.47"); parseNum strips commas.
 *   5. Prod Date arrives as first-of-month "YYYY-MM-01" already, but we
 *      still round-trip through normalizeMonthlyDate defensively and
 *      preserve raw in extraFields.rawProdDate.
 *   6. Pages 2+: the header row repeats so findColumnPlan still works;
 *      we scan ALL pages, not just page 1.
 *
 * Distinguishing signatures (vs other PDS monthlies):
 *   - "Monthly Production Estimates" (not "Daily")
 *   - "MEWBOURNE" or "Mewbourne Oil Company"
 *   - Header labels include "Oil Begin" AND "Oil End" (tank gauges —
 *     unique to Mewbourne among PDS monthlies)
 *   - "* Gas at State Pressure Base" footnote (Mewbourne-specific)
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

/** "YYYY-MM-DD" → "YYYY-MM-01" (project monthly convention). */
function normalizeMonthlyDate(isoDate: string): string {
  const [yyyy, mm] = isoDate.split('-');
  return `${yyyy}-${mm}-01`;
}

/** 10-digit API → api10 + trailing-"0000" padded api14. */
function normalizeApi(rawApi: string): { api10: string; api14: string } {
  const digits = rawApi.replace(/\D/g, '');
  if (digits === '') return { api10: '', api14: '' };
  const api10 = digits.slice(0, 10).padStart(10, '0');
  const api14 =
    digits.length >= 14 ? digits.slice(0, 14) : (digits + '0000').slice(0, 14);
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
 * Sequential-proximity row clustering at 4 pt.
 * - Merges the 2-pt well-identity sub-row split (e.g. y=404/402).
 * - Keeps 10+-pt-apart adjacent rows AND "(H3OG)" continuation lines
 *   in separate clusters.
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
  | 'wellNum'    // 8-digit Mewbourne internal ID → operatorWellId
  | 'wellName'
  | 'api'        // 10-digit real API → api10/api14
  | 'complId'    // Mewbourne internal completion ID → extraFields
  | 'prodDate'
  | 'btu'        // gas quality → extraFields
  | 'oilBegin'   // tank gauge → extraFields (NOT production)
  | 'oilProd'
  | 'oilSales'
  | 'oilEnd'     // tank gauge → extraFields (NOT production)
  | 'gasProd'
  | 'gasSales'
  | 'waterProd'
  | 'daysOn';    // days producing → daysOn field

// Keys MUST be lowercase — normHeaderLabel lowercases before lookup.
const HEADER_LABEL_TO_ROLE: Record<string, ColumnRole> = {
  'well num': 'wellNum',
  'well name': 'wellName',
  'api': 'api',
  'compl.id': 'complId',
  'compl. id': 'complId',
  'complid': 'complId',
  'prod date': 'prodDate',
  'btu': 'btu',
  'oil begin': 'oilBegin',
  'oil prod': 'oilProd',
  'oilprod': 'oilProd',
  'oilsales': 'oilSales',
  'oil sales': 'oilSales',
  'oil end': 'oilEnd',
  'gas prod': 'gasProd',
  'gasprod': 'gasProd',
  'gassales': 'gasSales',
  'gas sales': 'gasSales',
  'water prod': 'waterProd',
  'waterprod': 'waterProd',
  'dayson': 'daysOn',
  'days on': 'daysOn',
};

function normHeaderLabel(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

interface ColumnPlan {
  role: ColumnRole;
  center: number;
}

/**
 * Find the header row — the row with ≥10 of our 14 expected labels.
 * (Floor of 10 handles pages where a label might be split across y.)
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
    if (plan.length >= 10) {
      plan.sort((a, b) => a.center - b.center);
      return plan;
    }
  }
  return null;
}

const WELL_NUM_RE = /^\d{8}$/;       // Mewbourne Well Num = 8-digit
const API_RE = /^\d{10}$/;            // Mewbourne real API = 10-digit
const PROD_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const COLUMN_TOLERANCE_PT = 25;

/**
 * Assign items to columns by nearest-center match within ±25 pt.
 * First-write wins per role (prevents a later sub-row item from
 * overwriting a main-row value in the merged cluster).
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
    if (bestRole && bestDistance <= COLUMN_TOLERANCE_PT) {
      if (out[bestRole] === undefined) {
        out[bestRole] = it.str.trim();
      }
    }
  }
  return out;
}

function isHeaderLabel(s: string): boolean {
  return HEADER_LABEL_TO_ROLE[normHeaderLabel(s)] !== undefined;
}

export async function parsePdsMewbourneMonthlyPdf(
  buf: Buffer
): Promise<ProductionRecord[]> {
  const items = await extractAllItems(buf);
  if (items.length === 0) {
    throw new Error('PDS Mewbourne Monthly: pdf-parse returned zero text items');
  }

  const rows = groupIntoRows(items);
  const plan = findColumnPlan(rows);
  if (!plan) {
    throw new Error(
      'PDS Mewbourne Monthly: could not locate a header row with ≥10 known column labels. ' +
        'Layout may have changed; re-verify via scripts/peek-mewbourne-monthly.ts.'
    );
  }

  let lastWellName: string | null = null;
  let lastWellNum: string | null = null;
  let lastApi: string | null = null;

  const records: ProductionRecord[] = [];
  const skipped: string[] = [];

  for (const row of rows) {
    const roles = assignRoles(row, plan);

    if (roles.wellName && !isHeaderLabel(roles.wellName)) {
      lastWellName = roles.wellName;
    }
    if (roles.wellNum && WELL_NUM_RE.test(roles.wellNum)) {
      lastWellNum = roles.wellNum;
    }
    if (roles.api && API_RE.test(roles.api)) {
      lastApi = roles.api;
    }

    const prodDateStr = roles.prodDate;
    if (!prodDateStr || !PROD_DATE_RE.test(prodDateStr)) continue;

    // Need at least 3 volume-ish columns to call this a data row. Count
    // Oil Prod + OilSales + Gas Prod + GasSales + Water Prod (but NOT
    // oilBegin/oilEnd — those are tank gauges).
    const volumeCount =
      (roles.oilProd !== undefined ? 1 : 0) +
      (roles.oilSales !== undefined ? 1 : 0) +
      (roles.gasProd !== undefined ? 1 : 0) +
      (roles.gasSales !== undefined ? 1 : 0) +
      (roles.waterProd !== undefined ? 1 : 0);
    if (volumeCount < 3) {
      skipped.push(
        `data row at y=${row[0].y.toFixed(0)}: date="${prodDateStr}" but only ${volumeCount} volume columns`
      );
      continue;
    }

    const wellName =
      roles.wellName && !isHeaderLabel(roles.wellName)
        ? roles.wellName
        : lastWellName ?? '';
    if (!wellName) {
      skipped.push(`data row at y=${row[0].y.toFixed(0)}: no wellName (nor recent)`);
      continue;
    }

    const wellNum =
      roles.wellNum && WELL_NUM_RE.test(roles.wellNum)
        ? roles.wellNum
        : lastWellNum ?? '';
    const rawApi =
      roles.api && API_RE.test(roles.api) ? roles.api : lastApi ?? '';
    const { api10, api14 } = normalizeApi(rawApi);

    records.push({
      api14,
      api10,
      wellName,
      combocurveWellId: null,
      operatorWellId: wellNum ? Number(wellNum) : null,
      prodDate: normalizeMonthlyDate(prodDateStr),
      oilProd: parseNum(roles.oilProd),
      gasProd: parseNum(roles.gasProd),
      waterProd: parseNum(roles.waterProd),
      oilSales: parseNum(roles.oilSales),
      gasSales: parseNum(roles.gasSales),
      waterInj: null, // Mewbourne Monthly has no water-injection column
      daysOn: parseNum(roles.daysOn),
      choke: null,
      tubingPres: null,
      casingPres: null,
      hoursDown: null,
      downtimeReason: null,
      extraFields: {
        source: 'pds-mewbourne-monthly-pdf',
        rawProdDate: prodDateStr,
        rawApi: rawApi || null,
        mewbourneWellNum: wellNum || null,
        complId: roles.complId ?? null,
        btu: parseNum(roles.btu),
        // Tank-gauge inventory — NOT production. Preserved for audit.
        oilBegin: parseNum(roles.oilBegin),
        oilEnd: parseNum(roles.oilEnd),
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
      `PDS Mewbourne Monthly: produced 0 records — layout may have changed.${detail}`
    );
  }

  return records;
}

export const pdsMewbourneMonthlyAdapter: FormatAdapter = {
  name: 'PDS Mewbourne Monthly',
  operatorName: 'Mewbourne Oil Company',
  dataType: 'monthly',
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
    const hasMonthlyHeader = /Monthly\s*Production\s*Estimates/i.test(text);
    const hasMewbourne = /Mewbourne/i.test(text);
    // Mewbourne-unique signature: both tank-gauge labels AND BTU AND the
    // footnote. No other PDS monthly has all three.
    const hasTankGauges =
      /Oil\s*Begin/i.test(text) && /Oil\s*End/i.test(text);
    const hasFootnote = /Gas\s*at\s*State\s*Pressure\s*Base/i.test(text);
    const otherOperator =
      /EOG\s*Resources/i.test(text) ||
      /Anadarko\s*Petroleum/i.test(text) ||
      /XTO\s*Energy/i.test(text) ||
      /ConocoPhillips/i.test(text);
    return (
      hasMonthlyHeader &&
      hasMewbourne &&
      (hasTankGauges || hasFootnote) &&
      !otherOperator
    );
  },

  async parse(ctx: ParserContext): Promise<ProductionRecord[]> {
    return parsePdsMewbourneMonthlyPdf(ctx.buffer);
  },
};
