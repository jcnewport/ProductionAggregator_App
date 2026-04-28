/**
 * Parser: PDS Well Data Exchange — Matador Resources Daily PDF  (Format 5f)
 * --------------------------------------------------------------------------
 * Source format: PDSWDX-DP-MATADOR-*.pdf
 * Operator:      Matador Resources Company via Frio Energy Partners
 * Data type:     DAILY production estimates
 *
 * First seen:    2026-04-28 (file -187005). Until that date Matador only
 *                forwarded MONTHLY reports (parser: pdsMatadorMonthly).
 *
 * Visual column layout (verified against 2026-04-28 sample — 12 columns):
 *   Well ID | Well Name | API | Prod Date |
 *   Casing Pressure | Tubing Pressure | Choke |
 *   Gross Oil Prod. | Gross Oil Sales | Gross Gas Prod. | Gross Gas Sales |
 *   Gross Water Production
 *
 * Distinguishing signatures (vs other PDS dailies):
 *   - "Daily Production Estimates" + "Matador Resources Company"
 *   - Dallas HQ address ("5400 LBJ Freeway", "972-371-5200")
 *   - Hyphenated 10-digit API "30-025-51289" — different from MONTHLY's
 *     bare 14-digit format. Daily uses state(2)-county(3)-well(5)
 *   - Dotted Well ID "500002.828.01" — same as Matador Monthly
 *   - Per-day Choke value (numeric, e.g. "0.31") — Monthly does not
 *     report Choke
 *   - NO MMBTU column on the daily (Monthly's tell)
 *
 * Why positional (x/y) extraction with LOOK-AHEAD MERGER:
 *   Same row-split pattern as Matador Monthly: data for one well-day
 *   spans 2 y-buckets that drift between rows. Example (SILVER 114H,
 *   prod date 2026-04-27):
 *     y=410: [234]"30-025-51289" | [317]"2026-04-27" | [630]"481.53"
 *            | [739]"458.92"
 *     y=408: [21]"500002.828.01" | [90]"Silver Fed Com #114H"
 *            | [375]"105.00" | [419]"120.00" | [467]"2.00"
 *            | [522]"74.30" | [575]"117.37" | [687]"460.93"
 *   These two rows together form one record. We adopt the same look-
 *   ahead merger Matador Monthly uses, calibrated for daily (the
 *   primary→continuation gap is ~2 pt for daily, vs 6-12 pt monthly).
 *
 * Quirks the parser handles:
 *   1. Split rows (above).
 *   2. Hyphenated 10-digit API → strip dashes → normalizeApi pads to api14.
 *   3. Dotted Well ID "500002.828.01" → extraFields.matadorWellId
 *      (cannot fit in operatorWellId int).
 *   4. "Total:" rows (no space before colon, vs Monthly's "Total :")
 *      — must be skipped, would double-count if treated as data.
 *   5. Page-2 may continue the report; HARDCODED_COLUMN_PLAN applies
 *      globally (no per-page header re-emission).
 *   6. Negative values / zero-volume Shut-In days preserved as-is.
 *   7. Daily date YYYY-MM-DD preserved.
 *
 * Field mapping to ProductionRecord:
 *   Well ID                → extraFields.matadorWellId
 *   Well Name              → wellName
 *   API                    → api10 / api14 (dashes stripped)
 *   Prod Date              → prodDate (daily, no normalization)
 *   Casing Pressure        → casingPres
 *   Tubing Pressure        → tubingPres
 *   Choke                  → choke (string, preserves "0.31" form)
 *   Gross Oil Prod.        → oilProd
 *   Gross Oil Sales        → oilSales
 *   Gross Gas Prod.        → gasProd
 *   Gross Gas Sales        → gasSales
 *   Gross Water Production → waterProd
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

interface Row {
  page: number;
  y: number;
  items: TextItem[];
}

/** 2-pt y-buckets — the daily layout has split rows just 2 pt apart
 *  (e.g. y=410 + y=408). A 2-pt bucket keeps each "logical line"
 *  separate so the look-ahead merger can decide what pairs together. */
function groupIntoRows(items: TextItem[]): Row[] {
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
 * Column plan — 12 columns
 * ──────────────────────────────────────────────────────────────── */

type ColumnRole =
  | 'wellId'
  | 'wellName'
  | 'api'
  | 'prodDate'
  | 'casingPres'
  | 'tubingPres'
  | 'choke'
  | 'oilProd'
  | 'oilSales'
  | 'gasProd'
  | 'gasSales'
  | 'waterProd';

const HARDCODED_COLUMN_PLAN: { role: ColumnRole; center: number }[] = [
  { role: 'wellId',     center: 21  },
  { role: 'wellName',   center: 90  },
  { role: 'api',        center: 234 },
  { role: 'prodDate',   center: 317 },
  { role: 'casingPres', center: 376 },
  { role: 'tubingPres', center: 420 },
  { role: 'choke',      center: 467 },
  { role: 'oilProd',    center: 520 },
  { role: 'oilSales',   center: 577 },
  { role: 'gasProd',    center: 627 },
  { role: 'gasSales',   center: 685 },
  { role: 'waterProd',  center: 736 },
];

const REQUIRED_HEADER_TOKENS = [
  'wellid',
  'well name',
  'api',
  'prod date',
  'choke',
];

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
 * Row classification + merge
 * ──────────────────────────────────────────────────────────────── */

const WELL_ID_RE = /^\d{6}\.\d{3}\.\d{2}$/;
// Daily API is hyphenated 10-digit (state-county-well: 2-3-5).
// We accept either the hyphenated form OR a bare 10/14-digit API
// for forward compatibility.
const HYPH_API_RE = /^\d{2}-\d{3}-\d{5}$/;
const BARE_API_RE = /^\d{10,14}$/;
const PROD_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidApi(s: string): boolean {
  return HYPH_API_RE.test(s) || BARE_API_RE.test(s);
}

function assignRoles(items: TextItem[]): Partial<Record<ColumnRole, string>> {
  const out: Partial<Record<ColumnRole, string>> = {};
  for (const it of items) {
    let bestRole: ColumnRole | null = null;
    let bestDistance = Infinity;
    for (const col of HARDCODED_COLUMN_PLAN) {
      const d = Math.abs(it.x - col.center);
      if (d < bestDistance) {
        bestDistance = d;
        bestRole = col.role;
      }
    }
    // Tolerance ±20 pt — wider than other parsers because Matador's
    // numeric volumes drift up to ~7 pt as values get longer (e.g.
    // " 117.37" sits at x=575 but " 1,265.86" sits at x=624 vs
    // x=575 for " 246.17"). Keep first-write wins.
    if (bestRole && bestDistance <= 20) {
      if (out[bestRole] === undefined) {
        out[bestRole] = it.str.trim();
      }
    }
  }
  return out;
}

type RowKind = 'primary' | 'primaryPartial' | 'continuation' | 'total' | 'other';

function classifyRow(
  roles: Partial<Record<ColumnRole, string>>,
  rawText: string
): RowKind {
  // Daily uses "Total:" (no space). Monthly uses "Total :" (with space).
  if (/\bTotal\b\s*:/i.test(rawText)) return 'total';

  const hasValidWellId = !!roles.wellId && WELL_ID_RE.test(roles.wellId);
  const hasValidApi = !!roles.api && isValidApi(roles.api);
  const hasValidDate = !!roles.prodDate && PROD_DATE_RE.test(roles.prodDate);

  if (hasValidWellId && hasValidDate) return 'primary';
  if (hasValidWellId || (hasValidApi && hasValidDate)) return 'primaryPartial';

  const hasAnyVolume =
    roles.oilProd !== undefined ||
    roles.oilSales !== undefined ||
    roles.gasProd !== undefined ||
    roles.gasSales !== undefined ||
    roles.waterProd !== undefined ||
    roles.casingPres !== undefined ||
    roles.tubingPres !== undefined ||
    roles.choke !== undefined;
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

export async function parsePdsMatadorDailyPdf(buf: Buffer): Promise<ProductionRecord[]> {
  const items = await extractAllItems(buf);
  if (items.length === 0) {
    throw new Error('PDS Matador Daily: pdf-parse returned zero text items');
  }

  const rows = groupIntoRows(items);

  if (!verifyHeaderFingerprint(rows)) {
    throw new Error(
      'PDS Matador Daily: header fingerprint missing. ' +
        `Required labels (${REQUIRED_HEADER_TOKENS.join(', ')}) not all found. ` +
        'Layout may have changed.'
    );
  }

  const records: ProductionRecord[] = [];
  const skipped: string[] = [];

  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    const roles = assignRoles(row.items);
    const rowText = row.items.map((it) => it.str).join(' ');
    const kind = classifyRow(roles, rowText);

    if (kind !== 'primary' && kind !== 'primaryPartial') {
      i += 1;
      continue;
    }

    const acc: Partial<Record<ColumnRole, string>> = { ...roles };
    let j = i + 1;
    let sawTotalAfter = false;

    // Look-ahead window: 6 pt below primary (each well-day fits in a
    // 4 pt vertical band given 2 pt buckets). Beyond that we assume
    // the next row is a different well-day.
    while (j < rows.length) {
      const nextRow = rows[j];
      if (nextRow.page !== row.page) break;
      const verticalGap = row.y - nextRow.y;
      if (verticalGap > 6 || verticalGap < 0) break;

      const nextRoles = assignRoles(nextRow.items);
      const nextText = nextRow.items.map((it) => it.str).join(' ');
      const nextKind = classifyRow(nextRoles, nextText);

      if (nextKind === 'total') {
        sawTotalAfter = true;
        break;
      }
      if (nextKind === 'primary') break;

      if (nextKind === 'continuation' || nextKind === 'primaryPartial') {
        mergeInto(acc, nextRoles);
      }
      j += 1;
    }

    const mergedWellId = acc.wellId && WELL_ID_RE.test(acc.wellId) ? acc.wellId : null;
    const mergedProdDate =
      acc.prodDate && PROD_DATE_RE.test(acc.prodDate) ? acc.prodDate : null;
    if (!mergedWellId || !mergedProdDate) {
      i = j + (sawTotalAfter ? 1 : 0);
      continue;
    }

    const wellName = (acc.wellName ?? '').trim();
    if (!wellName) {
      skipped.push(`primary at y=${row.y}: missing wellName`);
      i = j + (sawTotalAfter ? 1 : 0);
      continue;
    }

    const apiRaw = acc.api && isValidApi(acc.api) ? acc.api : '';
    const apiBare = apiRaw ? stripApiDashes(apiRaw) : '';
    const { api10, api14 } = normalizeApi(apiBare);

    records.push({
      api14,
      api10,
      wellName,
      combocurveWellId: null,
      operatorWellId: null, // dotted format can't fit int
      prodDate: mergedProdDate, // daily — no monthly normalization
      oilProd: parseNum(acc.oilProd),
      gasProd: parseNum(acc.gasProd),
      waterProd: parseNum(acc.waterProd),
      oilSales: parseNum(acc.oilSales),
      gasSales: parseNum(acc.gasSales),
      waterInj: null, // not in Matador Daily layout
      daysOn: null,
      choke: acc.choke ? String(acc.choke).trim() : null,
      tubingPres: parseNum(acc.tubingPres),
      casingPres: parseNum(acc.casingPres),
      hoursDown: null,
      downtimeReason: null,
      extraFields: {
        source: 'pds-matador-daily-pdf',
        matadorWellId: mergedWellId,
        rawApi: apiRaw || null,
      },
    });

    i = j + (sawTotalAfter ? 1 : 0);
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
      `PDS Matador Daily: produced 0 records but ${dateCandidateCount} ` +
        `date-shaped tokens found — layout may have changed.${detail}`
    );
  }

  return records;
}

/* ────────────────────────────────────────────────────────────────
 * Adapter registration
 * ──────────────────────────────────────────────────────────────── */

export const pdsMatadorDailyAdapter: FormatAdapter = {
  name: 'PDS Matador Daily',
  operatorName: 'Matador Resources Company',
  dataType: 'daily',
  fileKinds: ['pdf'],
  senderEmailPatterns: [
    /@pdswdx\.com$/i,
    /@frioenergy\.com$/i,
    /@frioenergypartners\.com$/i,
    /@matadorresources\.com$/i,
  ],

  detect(ctx: ParserContext): boolean {
    if (!ctx.pdfText) return false;
    const text = ctx.pdfText;
    const hasDailyHeader = /Daily\s*Production\s*Estimates/i.test(text);
    const hasMatador = /Matador\s*Resources\s*Company/i.test(text);
    const hasPds = /PDS\s*Well\s*Data\s*Exchange/i.test(text);
    // Matador Daily has a Choke column header that the Monthly does not.
    const hasChoke = /\bChoke\b/i.test(text);
    // Monthly distinguishes itself with MMBTUSales — exclude that.
    const looksLikeMonthly =
      /Monthly\s*Production\s*Estimates/i.test(text) || /MMBTU/i.test(text);
    // Must NOT be other operators with overlapping strings.
    const otherOperator =
      /Diamondback\s*Energy/i.test(text) ||
      /Diversified\s*Energy/i.test(text) ||
      /EOG\s*Resources/i.test(text) ||
      /Anadarko\s*Petroleum/i.test(text) ||
      /XTO\s*Energy/i.test(text) ||
      /Mewbourne\s*Oil/i.test(text);
    return (
      hasDailyHeader &&
      hasMatador &&
      hasPds &&
      hasChoke &&
      !looksLikeMonthly &&
      !otherOperator
    );
  },

  async parse(ctx: ParserContext): Promise<ProductionRecord[]> {
    return parsePdsMatadorDailyPdf(ctx.buffer);
  },
};
