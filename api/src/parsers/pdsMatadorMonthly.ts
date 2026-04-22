/**
 * Parser: PDS Well Data Exchange — Matador Resources Company Monthly PDF  (Format 1c)
 * -----------------------------------------------------------------------
 * Source format: PDSWDX-MP-MATADOR-*.pdf
 * Operator:      Matador Resources Company for Frio Energy Holdings I LLC
 * Data type:     MONTHLY production estimates
 *
 * Visual column layout (verified against 2026-04-21 sample — 10 columns):
 *   Well ID | Well Name | API | Prod Date | Gross Oil Production |
 *   Gross Oil Sales | Gross Gas Production | Gross Gas Sales |
 *   MMBTU Sales | Gross Water Production
 *
 * Distinguishing signatures (vs other PDS Monthly siblings):
 *   - Operator header "Matador Resources Company" + Dallas HQ address
 *   - "MMBTUSales" column — unique to Matador in our PDS registry
 *   - 14-digit API (zero-padded)
 *   - Dotted Well ID "500002.828.01" → extraFields.matadorWellId (not int)
 *
 * Why positional (x/y) extraction with LOOK-AHEAD MERGER:
 *   Each well in Matador's report emits values across 2-3 y-positions:
 *     - Primary row: identity (Well ID, Name, API, Date) + SOME volumes
 *     - 1-2 continuation rows: the remaining volumes, 6-12 pt below
 *     - Total row: "Total :" label + volume duplicates (skipped)
 *   The primary→continuation gap varies PER WELL in the same file (SILVER
 *   114H = 6 pt, SILVER 124H = 12 pt), so no single y-bucket size works.
 *   We keep standard 6-pt buckets and merge continuations with a forward
 *   walk through rows until we hit a Total or the next primary.
 *
 * Field mapping to ProductionRecord:
 *   Gross Oil Production → oilProd
 *   Gross Oil Sales      → oilSales
 *   Gross Gas Production → gasProd
 *   Gross Gas Sales      → gasSales
 *   Gross Water Production → waterProd
 *   MMBTUSales           → extraFields.mmbtuSales (heat content, NOT a volume)
 *   Well ID              → extraFields.matadorWellId
 *   API                  → api10 / api14
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

function normalizeMonthlyDate(isoDate: string): string {
  const [yyyy, mm] = isoDate.split('-');
  return `${yyyy}-${mm}-01`;
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

interface Row {
  page: number;
  y: number;
  items: TextItem[];
}

/** 6-pt y-buckets (matches sibling PDS parsers). Multi-row per well is
 *  handled downstream by look-ahead merging, not bucket tuning. */
function groupIntoRows(items: TextItem[]): Row[] {
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
  return entries.map((e) => ({ page: e.page, y: e.y, items: e.items.sort((a, b) => a.x - b.x) }));
}

/* ────────────────────────────────────────────────────────────────
 * Column plan — 10 columns
 * ──────────────────────────────────────────────────────────────── */

type ColumnRole =
  | 'wellId'
  | 'wellName'
  | 'api'
  | 'prodDate'
  | 'oilProd'
  | 'oilSales'
  | 'gasProd'
  | 'gasSales'
  | 'mmbtuSales'
  | 'waterProd';

const HARDCODED_COLUMN_PLAN: { role: ColumnRole; center: number }[] = [
  { role: 'wellId',     center: 18 },
  { role: 'wellName',   center: 88 },
  { role: 'api',        center: 206 },
  { role: 'prodDate',   center: 276 },
  { role: 'oilProd',    center: 370 },
  { role: 'oilSales',   center: 453 },
  { role: 'gasProd',    center: 530 },
  { role: 'gasSales',   center: 600 },
  { role: 'mmbtuSales', center: 678 },
  { role: 'waterProd',  center: 735 },
];

const REQUIRED_HEADER_TOKENS = ['well id', 'well name', 'api', 'mmbtusales'];

function normHeaderLabel(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function verifyHeaderFingerprint(rows: Row[]): boolean {
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
 * Row classification
 * ──────────────────────────────────────────────────────────────── */

const WELL_ID_RE = /^\d{6}\.\d{3}\.\d{2}$/;
const API14_RE = /^\d{14}$/;
const PROD_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assignRoles(
  items: TextItem[],
  plan: typeof HARDCODED_COLUMN_PLAN
): Partial<Record<ColumnRole, string>> {
  const out: Partial<Record<ColumnRole, string>> = {};
  for (const it of items) {
    let bestRole: ColumnRole | null = null;
    let bestDistance = Infinity;
    for (const col of plan) {
      const d = Math.abs(it.x - col.center);
      if (d < bestDistance) {
        bestDistance = d;
        bestRole = col.role;
      }
    }
    if (bestRole && bestDistance <= 40) {
      if (out[bestRole] === undefined) {
        out[bestRole] = it.str.trim();
      }
    }
  }
  return out;
}

type RowKind = 'primary' | 'primaryPartial' | 'continuation' | 'total' | 'other';

function classifyRow(roles: Partial<Record<ColumnRole, string>>, rawText: string): RowKind {
  if (/\bTotal\b\s*:/i.test(rawText)) return 'total';

  const hasValidWellId = !!roles.wellId && WELL_ID_RE.test(roles.wellId);
  const hasValidApi = !!roles.api && API14_RE.test(roles.api);
  const hasValidDate = !!roles.prodDate && PROD_DATE_RE.test(roles.prodDate);

  // A FULL primary row has Well ID + Date (identity anchor + date column).
  if (hasValidWellId && hasValidDate) return 'primary';

  // A PARTIAL primary is a row that's clearly a new well's identity/data row
  // but split across buckets: it has either a Well ID OR (API + Date) but
  // not the full Well ID + Date pair. Look-ahead or look-back will pair it.
  if (hasValidWellId || (hasValidApi && hasValidDate)) return 'primaryPartial';

  const hasAnyVolume =
    roles.oilProd !== undefined ||
    roles.oilSales !== undefined ||
    roles.gasProd !== undefined ||
    roles.gasSales !== undefined ||
    roles.mmbtuSales !== undefined ||
    roles.waterProd !== undefined;
  if (!hasValidWellId && !hasValidDate && hasAnyVolume) return 'continuation';

  return 'other';
}

function mergeInto(
  acc: Partial<Record<ColumnRole, string>>,
  more: Partial<Record<ColumnRole, string>>
): void {
  for (const k of Object.keys(more) as ColumnRole[]) {
    if (acc[k] === undefined && more[k] !== undefined) {
      acc[k] = more[k];
    }
  }
}

/* ────────────────────────────────────────────────────────────────
 * Core parser
 * ──────────────────────────────────────────────────────────────── */

export async function parsePdsMatadorMonthlyPdf(buf: Buffer): Promise<ProductionRecord[]> {
  const items = await extractAllItems(buf);
  if (items.length === 0) {
    throw new Error('PDS Matador Monthly: pdf-parse returned zero text items');
  }

  const rows = groupIntoRows(items);

  if (!verifyHeaderFingerprint(rows)) {
    throw new Error(
      'PDS Matador Monthly: header fingerprint missing. ' +
        'Required labels ("Well ID", "Well Name", "API", "MMBTUSales") not found. ' +
        'Layout may have changed.'
    );
  }

  const records: ProductionRecord[] = [];
  const skipped: string[] = [];

  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    const roles = assignRoles(row.items, HARDCODED_COLUMN_PLAN);
    const rowText = row.items.map((it) => it.str).join(' ');
    const kind = classifyRow(roles, rowText);

    // A row starts a new well if it's either a full primary OR a partial
    // primary (which we'll complete by merging with an adjacent partial).
    if (kind !== 'primary' && kind !== 'primaryPartial') {
      i += 1;
      continue;
    }

    // Accumulator starts with this row's roles.
    const acc: Partial<Record<ColumnRole, string>> = { ...roles };
    let j = i + 1;
    let sawTotalAfter = false;

    // Look-ahead merge: absorb continuation + partial-primary rows until
    // we hit a Total, a full primary, or cross a 36-pt gap.
    while (j < rows.length) {
      const nextRow = rows[j];
      if (nextRow.page !== row.page) break;
      const verticalGap = row.y - nextRow.y;
      if (verticalGap > 36 || verticalGap < 0) break;

      const nextRoles = assignRoles(nextRow.items, HARDCODED_COLUMN_PLAN);
      const nextText = nextRow.items.map((it) => it.str).join(' ');
      const nextKind = classifyRow(nextRoles, nextText);

      if (nextKind === 'total') {
        sawTotalAfter = true;
        break;
      }
      if (nextKind === 'primary') break;
      // A full primary below ends this record. A PARTIAL primary below is a
      // pair-mate for the current partial — absorb it (merges the split
      // identity/date row with the split Well ID/volumes row).

      if (nextKind === 'continuation' || nextKind === 'primaryPartial') {
        mergeInto(acc, nextRoles);
      }
      j += 1;
    }

    // After merge, require the accumulator to have BOTH a valid Well ID
    // AND a valid Prod Date. Otherwise this was noise — skip.
    const mergedWellId = acc.wellId && WELL_ID_RE.test(acc.wellId) ? acc.wellId : null;
    const mergedProdDate = acc.prodDate && PROD_DATE_RE.test(acc.prodDate) ? acc.prodDate : null;
    if (!mergedWellId || !mergedProdDate) {
      i = j + (sawTotalAfter ? 1 : 0);
      continue;
    }

    const wellName = (acc.wellName ?? '').trim();
    const apiRaw = acc.api && API14_RE.test(acc.api) ? acc.api : '';

    if (!wellName) {
      skipped.push(`primary at y=${row.y}: missing wellName`);
      i = j + (sawTotalAfter ? 1 : 0);
      continue;
    }

    const { api10, api14 } = normalizeApi(apiRaw);

    records.push({
      api14,
      api10,
      wellName,
      combocurveWellId: null,
      operatorWellId: null,
      prodDate: normalizeMonthlyDate(mergedProdDate),
      oilProd: parseNum(acc.oilProd),
      gasProd: parseNum(acc.gasProd),
      waterProd: parseNum(acc.waterProd),
      oilSales: parseNum(acc.oilSales),
      gasSales: parseNum(acc.gasSales),
      waterInj: null,
      daysOn: null,
      choke: null,
      tubingPres: null,
      casingPres: null,
      hoursDown: null,
      downtimeReason: null,
      extraFields: {
        source: 'pds-matador-monthly-pdf',
        rawProdDate: mergedProdDate,
        matadorWellId: mergedWellId,
        mmbtuSales: parseNum(acc.mmbtuSales),
        rawApi: apiRaw || null,
      },
    });

    i = j + (sawTotalAfter ? 1 : 0);
  }

  if (records.length === 0) {
    const detail =
      skipped.length > 0
        ? ` Skipped: ${skipped.slice(0, 3).join(' | ')}${skipped.length > 3 ? ` (+${skipped.length - 3} more)` : ''}`
        : '';
    throw new Error(
      `PDS Matador Monthly: produced 0 records — layout may have changed.${detail}`
    );
  }

  return records;
}

/* ────────────────────────────────────────────────────────────────
 * Adapter registration
 * ──────────────────────────────────────────────────────────────── */

export const pdsMatadorMonthlyAdapter: FormatAdapter = {
  name: 'PDS Matador Monthly',
  operatorName: 'Matador Resources Company',
  dataType: 'monthly',
  fileKinds: ['pdf'],
  senderEmailPatterns: [/@frioenergypartners\.com$/i, /@matadorresources\.com$/i],

  detect(ctx: ParserContext): boolean {
    if (!ctx.pdfText) return false;
    const text = ctx.pdfText;
    const hasMonthlyHeader = /Monthly Production Estimates/i.test(text);
    const hasPds = /PDS Well Data Exchange/i.test(text);
    const hasMatador = /Matador Resources Company/i.test(text);
    const hasMmbtu = /MMBTU/i.test(text);
    return hasMonthlyHeader && hasPds && hasMatador && hasMmbtu;
  },

  async parse(ctx: ParserContext): Promise<ProductionRecord[]> {
    return parsePdsMatadorMonthlyPdf(ctx.buffer);
  },
};
