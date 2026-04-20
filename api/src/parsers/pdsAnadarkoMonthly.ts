/**
 * Parser: PDS Well Data Exchange — Anadarko / Oxy Monthly PDF
 * ---------------------------------------------------------------
 * Source format: PDSWDX-MP-Anadarko-MONTHLY.pdf
 * Operator:      Anadarko (Oxy / Occidental Petroleum) via Frio Energy Holdings I LLC
 * Data type:     MONTHLY production estimates
 *
 * pdf-parse emits each production record as THREE lines, not one:
 *
 *   Line A: {API14}{YYYY-MM-DD} {OilProd} {GasProd} {WaterProd} {GasSales}
 *           (API14 and Date are concatenated with NO separator)
 *   Line B: ` {OilSales}`   (single indented number — may equal OilProd or differ slightly)
 *   Line C: {WellName}{OperatorWellID} {DaysOn} {WaterInj}
 *           (WellName and OperatorWellID concatenated — e.g. "FLEA FLICKER A 1BS392398"
 *            means name "FLEA FLICKER A 1BS" + operator well id 392398)
 *
 * The visual PDF header reads "Well Name | API | Prod Date | Oil Prod | Gas Prod | Water Prod |
 * Well ID | Gas Sales | Oil Sales | Water Inject | Days On", but the positional text stream
 * reorders columns into the A/B/C structure above.
 *
 * Verified by re-running pdf-parse against PDSWDX-MP-Anadarko-MONTHLY.pdf on 2026-04-20 after
 * initial parser returned zero rows on real Gmail-delivered attachment.
 */

import pdfParse from 'pdf-parse';
import type { FormatAdapter, ParserContext, ProductionRecord } from './types.js';

// Re-export so any existing callers (e.g. services/productionStorage.ts) that
// imported `ProductionRecord` from this file keep compiling.
export type { ProductionRecord } from './types.js';

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
 *
 * IMPORTANT: Anadarko and EOG PDFs both come from Frio Energy on the PDS
 * platform, so they share "Monthly Production Estimates", "FRIO ENERGY HOLDINGS",
 * and "PDS Well Data Exchange". The distinguishing markers live in the column
 * header row:
 *   Anadarko: "Water Inject" (with 't') and "Days On" (with space)
 *   EOG:      "Water Inj"    (no 't')    and "DaysOn"  (no space)
 * We check for the Anadarko-specific spellings here to avoid false positives.
 */
export function isPdsAnadarkoMonthly(rawText: string): boolean {
  const hasMonthlyHeader = /Monthly Production Estimates/i.test(rawText);
  const hasFrio = /FRIO ENERGY HOLDINGS/i.test(rawText);
  const hasPds = /PDS Well Data Exchange/i.test(rawText);
  // Anadarko-specific column labels (EOG uses "Water Inj" and "DaysOn" without space)
  const hasAnadarkoColumns =
    /Water\s*Inject/i.test(rawText) && /Days\s+On\b/i.test(rawText);
  return hasMonthlyHeader && hasFrio && hasPds && hasAnadarkoColumns;
}

/**
 * Parse the raw text stream of a PDS Anadarko Monthly PDF into production records.
 * Exposed separately for testing without needing a full PDF buffer.
 */
export function parseAnadarkoText(rawText: string): ProductionRecord[] {
  const records: ProductionRecord[] = [];

  // Number token: optional minus, digits (with optional commas), optional decimal
  const NUM = String.raw`-?[\d,]+(?:\.\d+)?`;

  // Line A: {API14}{YYYY-MM-DD} {OilProd} {GasProd} {WaterProd} {GasSales}
  // API14 and Date are CONCATENATED with no separator.
  const lineARegex = new RegExp(
    `^(\\d{14})(\\d{4}-\\d{2}-\\d{2})\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})\\s*$`
  );

  // Line B: single number (usually indented with leading whitespace)
  const lineBRegex = new RegExp(`^\\s*(${NUM})\\s*$`);

  // Line C: {WellName (may contain spaces and digits)}{OperatorWellID} {DaysOn} {WaterInj}
  // OperatorWellID is 4–7 consecutive digits smushed onto the end of the last name-token.
  // We split by whitespace: last 2 tokens are DaysOn + WaterInj, remaining tokens joined
  // form the "{Name}{ID}" compound string, which we then split by trailing digits.
  const compoundNameIdSplit = /^(.+?)(\d{4,7})$/;

  const lines = rawText.split(/\r?\n/);

  for (let i = 0; i < lines.length - 2; i++) {
    const a = lines[i];
    const b = lines[i + 1];
    const c = lines[i + 2];

    const matchA = a.match(lineARegex);
    if (!matchA) continue;

    const matchB = b.match(lineBRegex);
    if (!matchB) continue;

    // Defensive: don't let line C itself look like another line A (would mean B was malformed)
    if (lineARegex.test(c)) continue;

    // Parse line C — split by whitespace, last 2 tokens are DaysOn + WaterInj
    const cTokens = c.trim().split(/\s+/).filter((t) => t.length > 0);
    if (cTokens.length < 3) continue;

    const waterInjTok = cTokens[cTokens.length - 1];
    const daysOnTok = cTokens[cTokens.length - 2];

    // Last two must parse as numbers (otherwise this isn't a valid Line C)
    if (!/^[\d.,\-]+$/.test(waterInjTok) || !/^[\d.,\-]+$/.test(daysOnTok)) continue;

    // Remaining tokens form the "{Name}{ID}" compound
    const compound = cTokens.slice(0, -2).join(' ');
    const nameIdMatch = compound.match(compoundNameIdSplit);
    if (!nameIdMatch) continue;

    const wellName = nameIdMatch[1].trim();
    const operatorWellId = parseInt(nameIdMatch[2], 10);
    if (!wellName) continue;

    const [, api14, isoDate, oilProdStr, gasProdStr, waterProdStr, gasSalesStr] = matchA;
    const oilSalesStr = matchB[1];

    records.push({
      api14,
      api10: toApi10(api14),
      wellName,
      combocurveWellId: null, // Resolved later via ComboCurve lookup table
      operatorWellId,
      prodDate: normalizeMonthlyDate(isoDate),
      oilProd: parseNum(oilProdStr),
      gasProd: parseNum(gasProdStr),
      waterProd: parseNum(waterProdStr),
      gasSales: parseNum(gasSalesStr),
      oilSales: parseNum(oilSalesStr),
      waterInj: parseNum(waterInjTok),
      daysOn: parseNum(daysOnTok),
      // Not reported in this monthly format:
      choke: null,
      tubingPres: null,
      casingPres: null,
      hoursDown: null,
      downtimeReason: null,
      extraFields: {
        originalDate: isoDate, // Month-end date from the PDF; we normalize to first-of-month above
        operatorProvidedWellId: operatorWellId,
      },
    });

    // Advance past this 3-line record — minus 1 because the loop's i++ takes us to i+3
    i += 2;
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

/**
 * FormatAdapter registration — exposed so parsers/registry.ts can plug this in.
 * The adapter relies on the dispatcher pre-populating ctx.pdfText so we don't
 * re-parse the PDF during detect().
 */
export const pdsAnadarkoMonthlyAdapter: FormatAdapter = {
  name: 'PDS Anadarko Monthly',
  operatorName: 'Anadarko (Oxy)',
  dataType: 'monthly',
  fileKinds: ['pdf'] as const,
  // Frio Energy distributes Anadarko data; any email from a @frioenergy.com or
  // explicit PDS sender is a strong hint but not definitive (we still confirm
  // via detect() to avoid false positives on unrelated files from the same sender).
  senderEmailPatterns: [/@frioenergy\.com$/i, /@pdswdx\.com$/i] as const,

  detect(ctx: ParserContext): boolean {
    if (!ctx.pdfText) return false;
    return isPdsAnadarkoMonthly(ctx.pdfText);
  },

  async parse(ctx: ParserContext): Promise<ProductionRecord[]> {
    // Use the pre-sniffed text when available — saves re-parsing the PDF.
    if (ctx.pdfText) {
      const records = parseAnadarkoText(ctx.pdfText);
      if (records.length === 0) {
        throw new Error(
          'PDS Anadarko Monthly PDF parsed but yielded zero rows. Possible format drift.'
        );
      }
      return records;
    }
    // Fallback — shouldn't happen in normal dispatcher flow.
    return parseAnadarkoMonthlyPdf(ctx.buffer);
  },
};
