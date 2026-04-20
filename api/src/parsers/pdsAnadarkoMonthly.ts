/**
 * Parser: PDS Well Data Exchange — Anadarko / Oxy Monthly PDF
 * ---------------------------------------------------------------
 * Source format: PDSWDX-MP-Anadarko-MONTHLY.pdf
 * Operator:      Anadarko (Oxy / Occidental Petroleum) via Frio Energy Holdings I LLC
 * Data type:     MONTHLY production estimates
 *
 * Extracted text layout (one row per well-month):
 *   [API14] [YYYY-MM-DD] [OilProd] [GasProd] [WaterProd] [GasSales] [OilSales] [WellName] [WellID] [DaysOn] [WaterInject]
 *
 * NOTE: The visual PDF header reads "Well Name | API | Prod Date | Oil Prod | Gas Prod | Water Prod |
 * Well ID | Gas Sales | Oil Sales | Water Inject | Days On", but pdf-parse's text extraction
 * reorders the positional stream. The order above is what we actually see in the extracted text.
 * Verified against PDSWDX-MP-Anadarko-MONTHLY.pdf on 2026-04-20.
 */

import pdfParse from 'pdf-parse';

/** A single well-month production record, normalized to our internal schema. */
export interface ProductionRecord {
  api14: string;
  api10: string;
  wellName: string;
  combocurveWellId: number | null;
  operatorWellId: number | null; // The operator's internal ID (e.g., 392398)
  prodDate: string;              // YYYY-MM-DD (first of month convention — see note below)
  oilProd: number | null;
  gasProd: number | null;
  waterProd: number | null;
  gasSales: number | null;
  oilSales: number | null;
  waterInj: number | null;
  daysOn: number | null;
  // Unused fields for this format but kept for schema consistency:
  choke: string | null;
  tubingPres: number | null;
  casingPres: number | null;
  hoursDown: number | null;
  downtimeReason: string | null;
  extraFields: Record<string, unknown>;
}

/**
 * Parse a number that may contain commas. Returns null for empty / non-numeric input.
 */
function parseNum(token: string): number | null {
  if (!token || token.trim() === '') return null;
  const cleaned = token.replace(/,/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Given a string containing a 14-digit API at the start, truncate to 10 digits.
 * Always returned as a 10-character string (preserves leading zeros per domain rules).
 */
function toApi10(api14: string): string {
  return api14.slice(0, 10).padStart(10, '0');
}

/**
 * Normalize a YYYY-MM-DD month-end date (e.g. "2026-03-31") to first-of-month.
 * Project convention (Phase 1): monthly prod_date = first day of the reporting month.
 * This lets month-range queries be unambiguous.
 */
function normalizeMonthlyDate(isoDate: string): string {
  const [yyyy, mm] = isoDate.split('-');
  return `${yyyy}-${mm}-01`;
}

/**
 * Check that the PDF contains the PDS Anadarko header signature.
 * Called by the parser dispatcher to confirm format before parsing.
 */
export function isPdsAnadarkoMonthly(rawText: string): boolean {
  // Signature markers in this exact PDF:
  //   "Monthly Production Estimates"
  //   "FRIO ENERGY HOLDINGS I LLC" (Frio is Anadarko's distribution partner)
  //   "PDS Well Data Exchange"
  const hasMonthlyHeader = /Monthly Production Estimates/i.test(rawText);
  const hasFrio = /FRIO ENERGY HOLDINGS/i.test(rawText);
  const hasPds = /PDS Well Data Exchange/i.test(rawText);
  return hasMonthlyHeader && hasFrio && hasPds;
}

/**
 * Parse the raw text stream of a PDS Anadarko Monthly PDF into production records.
 * Exposed separately for testing without needing a full PDF buffer.
 */
export function parseAnadarkoText(rawText: string): ProductionRecord[] {
  const records: ProductionRecord[] = [];

  // Each valid data row starts with a 14-digit API number followed by a YYYY-MM-DD date.
  // We use this as our anchor to filter out headers, totals, page separators, and footer text.
  const rowAnchor = /^(\d{14})\s+(\d{4}-\d{2}-\d{2})\s+(.+)$/;

  // Split text into lines and strip tabs (pdf-parse inserts them in some column groups)
  const lines = rawText.split(/\r?\n/);

  for (const rawLine of lines) {
    // Collapse all whitespace (tabs and multiple spaces) into single spaces for tokenizing
    const line = rawLine.replace(/\s+/g, ' ').trim();
    if (!line) continue;

    const match = line.match(rowAnchor);
    if (!match) continue;

    const [, api14, isoDate, rest] = match;

    // After the API and date, the remaining tokens are:
    // [OilProd] [GasProd] [WaterProd] [GasSales] [OilSales] [WellName... possibly multiple words] [WellID] [DaysOn] [WaterInject]
    //
    // Strategy: the 5 volume numbers come first (numeric-only tokens),
    // then the well name (mixed tokens), then a 6-digit numeric well_id,
    // then days-on and water-inject (last two numerics).
    //
    // We reverse-tokenize from the end: last 2 tokens = DaysOn + WaterInject,
    // then next numeric token = WellID, and everything remaining is first 5 numerics + well name.
    const tokens = rest.split(' ').filter((t) => t.length > 0);
    if (tokens.length < 9) {
      // Not a well-formed row — skip defensively
      continue;
    }

    // Last two: Days On, Water Inject
    const waterInj = parseNum(tokens[tokens.length - 1]);
    const daysOn = parseNum(tokens[tokens.length - 2]);

    // Walk backwards to find the well_id — a purely numeric token (no commas, no decimal)
    // that sits just after the well name text. In this format it's a 5–7 digit integer.
    let wellIdIndex = -1;
    for (let i = tokens.length - 3; i >= 0; i--) {
      const t = tokens[i];
      if (/^\d{4,7}$/.test(t)) {
        wellIdIndex = i;
        break;
      }
    }
    if (wellIdIndex === -1) continue;

    const operatorWellId = parseInt(tokens[wellIdIndex], 10);

    // The first 5 tokens are the volume numbers
    const oilProd = parseNum(tokens[0]);
    const gasProd = parseNum(tokens[1]);
    const waterProd = parseNum(tokens[2]);
    const gasSales = parseNum(tokens[3]);
    const oilSales = parseNum(tokens[4]);

    // Everything between index 5 and wellIdIndex-1 is the well name
    const wellName = tokens.slice(5, wellIdIndex).join(' ').trim();
    if (!wellName) continue;

    records.push({
      api14,
      api10: toApi10(api14),
      wellName,
      combocurveWellId: null, // Will be resolved later via ComboCurve lookup table (Phase 3)
      operatorWellId,
      prodDate: normalizeMonthlyDate(isoDate),
      oilProd,
      gasProd,
      waterProd,
      gasSales,
      oilSales,
      waterInj,
      daysOn,
      // Not reported in this monthly format:
      choke: null,
      tubingPres: null,
      casingPres: null,
      hoursDown: null,
      downtimeReason: null,
      extraFields: {
        originalDate: isoDate, // Keep the month-end date in case we ever want to verify
        operatorProvidedWellId: operatorWellId,
      },
    });
  }

  return records;
}

/**
 * Main entry: take a PDF file buffer, return parsed production records.
 * Throws if the PDF doesn't match the Anadarko format signature.
 */
export async function parseAnadarkoMonthlyPdf(
  buffer: Buffer
): Promise<ProductionRecord[]> {
  const result = await pdfParse(buffer);
  const rawText: string = result.text;

  if (!isPdsAnadarkoMonthly(rawText)) {
    throw new Error(
      'File does not match PDS Anadarko Monthly format signature. ' +
        'Expected markers: "Monthly Production Estimates", "FRIO ENERGY HOLDINGS", "PDS Well Data Exchange".'
    );
  }

  const records = parseAnadarkoText(rawText);
  if (records.length === 0) {
    throw new Error('PDS Anadarko Monthly PDF parsed but yielded zero rows. Possible format drift.');
  }

  return records;
}
