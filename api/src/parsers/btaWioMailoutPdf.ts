/**
 * Parser: BTA WIO Mailout PDF  (Format 8)
 * ----------------------------------------
 * Source format:
 *   - February 2026 West Pecos Trading WIO Mailout.pdf
 *   - Any future BTA Oil Producers monthly WIO mailout (same layout)
 *
 * Operator:   BTA Oil Producers, LLC
 * Data type:  MONTHLY production
 *
 * PDF structure (verified against the Feb 2026 sample):
 *   One page. Header block (operator address + investor client + email).
 *   A 6-column table:
 *     Investor (= well name)  |  Date  |  Oil Prod  |  Oil Sold  |  Gas Prod  |  Gas Sold
 *   NO API number anywhere.  NO Water Prod.  NO pressure/choke/downtime.
 *   Footer: generation date + contact info.
 *
 * The tricky bit:
 *   pdf-parse's default text output concatenates the 4 numeric columns into a
 *   single string without separators, e.g.:
 *     "Box Elder 23-14-11 State Com #4H2/28/202611844118151401413361"
 *   That's unrecoverable by string-slicing (the column widths vary per file).
 *   So we override pdf-parse's `pagerender` option and extract text items
 *   with their x/y coordinates, then bucket items by y to form lines and
 *   pick columns by x.
 *
 * Quirks the parser handles:
 *   1. Columns identified positionally — well name is always the LEFTMOST
 *      item on a data row, followed in x-order by Date, OilProd, OilSold,
 *      GasProd, GasSold.
 *   2. Data rows have exactly 6 text items. Any y-bucket with fewer than 6
 *      items is metadata (address block, contact line, etc.) and is skipped.
 *   3. NO API → api10/api14 stay empty strings. Downstream well_name_aliases
 *      will resolve the well (per project spec).
 *   4. Monthly dates normalized to first-of-month (per our monthly convention):
 *      "2/28/2026" → "2026-02-01". Source dates are end-of-month in BTA's
 *      sample, but the project's monthly convention stores first-of-month;
 *      rawProdDate preserved in extraFields so nothing is lost.
 *
 * Separation of concerns:
 *   - exportable `parseBtaWioMailoutPdf(buffer)` for tests and reuse
 *   - registered `btaWioMailoutPdfAdapter` for the dispatcher
 */

import pdfParse from 'pdf-parse';
import type { FormatAdapter, ParserContext, ProductionRecord } from './types.js';

/* ────────────────────────────────────────────────────────────────
 * Local utilities
 * ──────────────────────────────────────────────────────────────── */

/** Parse a numeric cell (commas allowed, blanks → null). */
function parseNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (s === '') return null;
  const cleaned = s.replace(/,/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** M/D/YYYY → { iso first-of-month, rawIso end-of-month }. */
function toMonthlyDates(raw: string): {
  prodDate: string;
  rawProdDate: string;
} | null {
  const mdy = raw.trim().match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (!mdy) return null;
  let [, mm, dd, yyyy] = mdy;
  if (yyyy.length === 2) yyyy = (Number(yyyy) > 50 ? '19' : '20') + yyyy;
  const mi = Number(mm);
  const di = Number(dd);
  if (mi < 1 || mi > 12 || di < 1 || di > 31) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    prodDate: `${yyyy}-${pad(mi)}-01`, // monthly convention: first-of-month
    rawProdDate: `${yyyy}-${pad(mi)}-${pad(di)}`, // what the report actually said
  };
}

/* ────────────────────────────────────────────────────────────────
 * Positional extraction — override pdf-parse's pagerender to get
 * every text item with its x/y coordinates.
 * ──────────────────────────────────────────────────────────────── */

type TextItem = { x: number; y: number; str: string };

async function extractItems(buf: Buffer): Promise<TextItem[]> {
  async function pagerender(pageData: any): Promise<string> {
    const content = await pageData.getTextContent({
      normalizeWhitespace: false,
      disableCombineTextItems: false,
    });
    const lines: string[] = [];
    for (const it of content.items as any[]) {
      const x = it.transform[4];
      const y = it.transform[5];
      const s = String(it.str).replace(/[\t\n\r]/g, ' ');
      lines.push(`${x.toFixed(2)}\t${y.toFixed(2)}\t${s}`);
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
        x: Number(parts[0]),
        y: Number(parts[1]),
        str: parts.slice(2).join('\t'),
      };
    })
    .filter((it) => Number.isFinite(it.x) && Number.isFinite(it.y));
}

/** Bucket items by y-coordinate (rounded to nearest 2pt) and sort each bucket left-to-right. */
function groupByLine(items: TextItem[]): TextItem[][] {
  const byLine = new Map<number, TextItem[]>();
  for (const it of items) {
    const key = Math.round(it.y / 2) * 2;
    if (!byLine.has(key)) byLine.set(key, []);
    byLine.get(key)!.push(it);
  }
  return Array.from(byLine.entries())
    .sort((a, b) => b[0] - a[0]) // top-to-bottom (descending y)
    .map(([, arr]) => arr.sort((a, b) => a.x - b.x));
}

/* ────────────────────────────────────────────────────────────────
 * Core parser
 * ──────────────────────────────────────────────────────────────── */

export async function parseBtaWioMailoutPdf(buf: Buffer): Promise<ProductionRecord[]> {
  const items = await extractItems(buf);
  if (items.length === 0) {
    throw new Error('BTA WIO Mailout: pdf-parse returned zero text items');
  }

  const lines = groupByLine(items);

  // Locate an "Investor" column header to anchor our column x-positions.
  // Headers can straddle two y-buckets ("Oil" on top, "Prod/Sold" below);
  // we only need the Investor anchor to confirm the layout.
  const hasInvestor = lines.some((ln) =>
    ln.some((it) => /^\s*Investor\s*$/i.test(it.str))
  );
  if (!hasInvestor) {
    throw new Error(
      'BTA WIO Mailout: could not locate "Investor" column header — layout may have changed.'
    );
  }

  // A WIO data row = a line containing exactly:
  //   [well-name-text]  [M/D/YYYY date]  [4 numeric values]
  // In x-sorted order. We filter lines to those that start with a non-numeric
  // string, contain a date token, and have ≥ 6 items.
  const datePattern = /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/;

  const records: ProductionRecord[] = [];
  const skipReasons: string[] = [];

  for (const ln of lines) {
    // A data row has at LEAST 6 items (wellName, date, 4 volumes).
    if (ln.length < 6) continue;

    // Find the date item — MUST be present on a data row.
    const dateIdx = ln.findIndex((it) => datePattern.test(it.str.trim()));
    if (dateIdx < 1) continue; // need at least one item (well name) before the date

    // Everything before the date index is the well name (join with spaces in
    // case the name is split across multiple text items — pdfjs sometimes
    // chunks names into fragments).
    const wellName = ln
      .slice(0, dateIdx)
      .map((it) => it.str)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!wellName) {
      skipReasons.push(`line at y≈${ln[0].y.toFixed(0)}: empty well name`);
      continue;
    }

    // After the date index: 4 numeric columns in x order.
    const afterDate = ln.slice(dateIdx + 1);
    if (afterDate.length < 4) {
      skipReasons.push(
        `line at y≈${ln[0].y.toFixed(0)}: well="${wellName}" — only ${afterDate.length} post-date items (need 4)`
      );
      continue;
    }
    // Only keep items that parse to a number; ignore any trailing non-numeric
    // fragments (e.g. stray characters from pdfjs tokenization).
    const nums = afterDate
      .map((it) => ({ x: it.x, n: parseNum(it.str) }))
      .filter((v) => v.n !== null) as { x: number; n: number }[];
    if (nums.length < 4) {
      skipReasons.push(
        `line at y≈${ln[0].y.toFixed(0)}: well="${wellName}" — only ${nums.length} numeric post-date items`
      );
      continue;
    }

    // Sort by x (should already be sorted) and take the first 4 columns.
    nums.sort((a, b) => a.x - b.x);
    const [oilProd, oilSales, gasProd, gasSales] = [
      nums[0].n,
      nums[1].n,
      nums[2].n,
      nums[3].n,
    ];

    const dates = toMonthlyDates(ln[dateIdx].str);
    if (!dates) {
      skipReasons.push(
        `line at y≈${ln[0].y.toFixed(0)}: well="${wellName}" — unparseable date "${ln[dateIdx].str}"`
      );
      continue;
    }

    records.push({
      api14: '', // BTA WIO Mailout has NO API column — well_name_aliases resolves
      api10: '',
      wellName,
      combocurveWellId: null,
      operatorWellId: null,
      prodDate: dates.prodDate,
      oilProd,
      gasProd,
      waterProd: null, // not reported in this format
      oilSales,
      gasSales,
      waterInj: null,
      daysOn: null,
      choke: null,
      tubingPres: null,
      casingPres: null,
      hoursDown: null,
      downtimeReason: null,
      extraFields: {
        source: 'bta-wio-mailout-pdf',
        rawProdDate: dates.rawProdDate, // end-of-month as reported
      },
    });
  }

  if (records.length === 0) {
    const detail =
      skipReasons.length > 0
        ? ` Skipped lines: ${skipReasons.slice(0, 5).join(' | ')}${skipReasons.length > 5 ? ` (+${skipReasons.length - 5} more)` : ''}`
        : '';
    throw new Error(
      `BTA WIO Mailout: produced 0 records — layout may have changed.${detail}`
    );
  }

  return records;
}

/* ────────────────────────────────────────────────────────────────
 * Adapter registration
 * ──────────────────────────────────────────────────────────────── */

export const btaWioMailoutPdfAdapter: FormatAdapter = {
  name: 'BTA WIO Mailout Monthly',
  operatorName: 'BTA Oil Producers',
  dataType: 'monthly',
  fileKinds: ['pdf'],
  senderEmailPatterns: [/@btaoil\.com$/i, /@btaoilproducers\.com$/i],

  detect(ctx: ParserContext): boolean {
    // pdf-parse's default plain-text output carries the operator identity
    // strings reliably even though the column headers are fragmented.
    if (!ctx.pdfText) return false;
    const text = ctx.pdfText;
    const hasBta = /BTA\s*Oil\s*Producers/i.test(text);
    const hasInvestorHeader = /Investor/i.test(text);
    const hasWioContext =
      /WIO@btaoil\.com/i.test(text) ||
      /Midland,\s*TX/i.test(text) ||
      /West\s*Pecos/i.test(text);
    return hasBta && hasInvestorHeader && hasWioContext;
  },

  async parse(ctx: ParserContext): Promise<ProductionRecord[]> {
    return parseBtaWioMailoutPdf(ctx.buffer);
  },
};
