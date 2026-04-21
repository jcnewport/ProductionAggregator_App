/**
 * Parser Registry
 * ---------------
 * The single source of truth for which operator formats the system can recognize.
 *
 * Adding a new format = add one entry below.
 * Stub entries declare the format up-front so:
 *   (a) the inventory is explicit — we know exactly what's pending
 *   (b) the dispatcher can still match a stub format by signature and
 *       FLAG it for manual review instead of tagging it "unknown"
 *   (c) future UI can show "we recognized this as Mewbourne Monthly but
 *       haven't built that parser yet" instead of a generic error.
 *
 * When you implement a stub, flip status to 'implemented' and swap the
 * stub adapter for the real one.
 */

import type { FormatAdapter, ParserContext, ProductionRecord, RegisteredFormat } from './types.js';
import { pdsAnadarkoMonthlyAdapter } from './pdsAnadarkoMonthly.js';
import { aftermathDailiesCsvAdapter } from './aftermathDailiesCsv.js';
import { genericProductionCsvAdapter } from './genericProductionCsv.js';
import { arloPartnerReportXlsxAdapter } from './arloPartnerReportXlsx.js';
import { hierarchicalAllocatedXlsxAdapter } from './hierarchicalAllocatedXlsx.js';
import { btaDailyPerWellXlsxAdapter } from './btaDailyPerWellXlsx.js';
import { btaWioMailoutPdfAdapter } from './btaWioMailoutPdf.js';
import { pdsEogMonthlyAdapter } from './pdsEogMonthly.js';
import { pdsXtoMonthlyAdapter } from './pdsXtoMonthly.js';
import { pdsConocoPhillipsDailyAdapter } from './pdsConocoPhillipsDaily.js';

/* ────────────────────────────────────────────────────────────────
 * Stub factory — builds a placeholder adapter that can DETECT its
 * format (so the dispatcher won't misroute to something else) but
 * throws a clear "not yet implemented" error if parse() is called.
 * ──────────────────────────────────────────────────────────────── */
function stubAdapter(args: {
  name: string;
  operatorName: string;
  dataType: 'monthly' | 'daily' | 'weekly';
  fileKinds: FormatAdapter['fileKinds'];
  detect: (ctx: ParserContext) => boolean;
  senderEmailPatterns?: readonly RegExp[];
}): FormatAdapter {
  return {
    name: args.name,
    operatorName: args.operatorName,
    dataType: args.dataType,
    fileKinds: args.fileKinds,
    senderEmailPatterns: args.senderEmailPatterns,
    detect: args.detect,
    async parse(_ctx: ParserContext): Promise<ProductionRecord[]> {
      throw new Error(
        `Parser for "${args.name}" is not yet implemented. ` +
          `The dispatcher identified the format, but the full parser is still pending ` +
          `(stub registered in parsers/registry.ts). Attachment has been flagged for manual review.`
      );
    },
  };
}

/* ────────────────────────────────────────────────────────────────
 * Cheap text-signature helpers for PDF stubs — just substrings that
 * uniquely identify each operator's PDS report. Live parsers will use
 * richer detection; these are enough for the dispatcher to route.
 * ──────────────────────────────────────────────────────────────── */
const hasAll = (text: string, ...needles: (string | RegExp)[]) =>
  needles.every((n) => (typeof n === 'string' ? text.includes(n) : n.test(text)));

/* ────────────────────────────────────────────────────────────────
 * The full format inventory — all 10 operator formats from the
 * project spec. Order matters: more specific formats (with richer
 * signature checks) should sit BEFORE more generic ones so the
 * first-match-wins dispatcher picks the right adapter.
 * ──────────────────────────────────────────────────────────────── */
export const FORMAT_REGISTRY: readonly RegisteredFormat[] = [
  // ─── Format 1 — PDS Anadarko Monthly (IMPLEMENTED) ───
  {
    adapter: pdsAnadarkoMonthlyAdapter,
    sampleFile: 'PDSWDX-MP-Anadarko-MONTHLY.pdf',
    status: 'implemented',
    notes: 'Near 1:1 with template. 3-line-per-record PDF text structure.',
  },

  // ─── Format 2 — PDS EOG Monthly (IMPLEMENTED) ───
  //
  // Positional (x/y) extraction via the same pagerender-override pattern used
  // for the BTA WIO adapter. We had to switch away from flat text because
  // pdf-parse's default text stream reorders EOG's 11 data columns in an
  // unstable, non-visual sequence (date → vols → wellID → wellName mixed).
  // Header row is located by scanning for ≥6 known labels and each data-row
  // item is bucketed into the closest column center within ±40 pt. Distinguishing
  // signatures from the Anadarko sibling: "Water Inj" (no 't') and "DaysOn"
  // (no space).
  {
    adapter: pdsEogMonthlyAdapter,
    sampleFile: 'PDSWDX-MP-EOG-MONTHLY.pdf',
    status: 'implemented',
    notes:
      'Positional x/y extraction (pagerender override). 11 columns: Well Name | Well ID | API | Prod Date | DaysOn | Oil Prod | Oil Sales | Gas Prod | Gas Sales | Water Prod | Water Inj. Monthly end-of-month dates normalized to first-of-month; raw date preserved. Negative Oil Prod (BS&W corrections) preserved. Distinguishing signatures vs Anadarko: "Water Inj" (no t) and "DaysOn" (no space).',
  },

  // ─── Format 3 — PDS Mewbourne Monthly (STUB) ───
  {
    adapter: stubAdapter({
      name: 'PDS Mewbourne Monthly',
      operatorName: 'Mewbourne Oil Company',
      dataType: 'monthly',
      fileKinds: ['pdf'] as const,
      senderEmailPatterns: [/@pdswdx\.com$/i, /@mewbourne\.com$/i],
      detect: (ctx) =>
        !!ctx.pdfText &&
        hasAll(ctx.pdfText, 'Monthly Production Estimates', 'PDS Well Data Exchange') &&
        /MEWBOURNE/i.test(ctx.pdfText),
    }),
    sampleFile: 'PDSWDX-MP-mewbourne-MONTHLY.pdf',
    status: 'stub',
    notes:
      'HIGH complexity. Extra columns (BTU, Oil Begin/End, Compl.ID). API is 8-digit — needs padding/lookup. Oil Begin/End are tank gauge, do NOT map to Oil Prod/Sales.',
  },

  // ─── Format 4 — PDS XTO Monthly (IMPLEMENTED) ───
  //
  // XTO is the most column-rich PDS monthly — 15 columns vs. EOG's 11. The
  // extra columns are all things we must NOT map to the ComboCurve template:
  //   - OilCum, GasCum (cumulative running totals)
  //   - GasInj (gas injection)
  //   - Pressure Base (regulatory 15.03 psi)
  //   - Producing Status ("Active") and Well Status ("Producing Oil")
  // All are preserved in extraFields for audit but never miscoded as
  // production volumes. Positional (x/y) extraction same as EOG/BTA WIO.
  // Row-bucket size = 6 pt (vs EOG's 4) because XTO rows sit ~10-12 pt
  // apart with 2-pt drift, which a 4-pt bucket can't absorb without
  // splitting the wellName off the data row.
  {
    adapter: pdsXtoMonthlyAdapter,
    sampleFile: 'PDSWDX-MP-XTO-MONTHLY.pdf',
    status: 'implemented',
    notes:
      'Positional x/y extraction (pagerender override). 15 columns. Cumulative OilCum/GasCum preserved in extraFields — NOT mapped to volumes. GasInj, Pressure Base, Producing Status, Well Status all in extraFields. "Well Num" column holds 10-digit API → padded with "0000" to derive API14. 6-pt row bucket.',
  },

  // ─── Format 5 — PDS ConocoPhillips Daily (IMPLEMENTED) ───
  //
  // Positional (x/y) extraction via pagerender override, same pattern as
  // EOG/XTO Monthly. 13 columns: Well ID | Well Name | Completion No | API |
  // Prod Date | Oil Prod | Oil Sales | Gas Prod | Gas Sales | Water Prod |
  // Tubing Pres. | Casing Pres. | BHP. Header labels are stacked across
  // 5 y-lines in this format (e.g. "Oil" above "Prod") so instead of
  // rebuilding split labels programmatically we use a **hardcoded
  // column-center plan** (runtime-verified by a header-fingerprint check:
  // the PDF must contain "Well ID", "Well Name", "Completion No", "API",
  // "Prod Date", and "BHP" or parse fails loudly). 12-digit API → api10
  // first 10 digits, api14 padded with trailing "00". Oil Sales is
  // typically blank in samples → stored as null. BHP kept in
  // extraFields.bhp (not in ComboCurve template).
  {
    adapter: pdsConocoPhillipsDailyAdapter,
    sampleFile: 'PDSWDX-DP-conocophillips-DAILY.pdf',
    status: 'implemented',
    notes:
      'Positional x/y extraction. 13 columns. Hardcoded column-center plan verified at runtime by header-fingerprint check. 12-digit API normalized: api10 = first 10 digits, api14 = pad with "00" to 14. Oil Sales typically blank → null (not 0). BHP in extraFields. 8-pt row bucket (merges the 2-pt-split BHP sub-row without colliding adjacent data rows at 18-pt spacing). Daily date preserved as YYYY-MM-DD.',
  },

  // ─── Format 5a — PDS Anadarko Daily (STUB) ───
  //
  // Daily variant of Format 1. Same PDS boilerplate ("Daily Production
  // Estimates" + "PDS Well Data Exchange") but identified by operator name
  // "Anadarko Petroleum Corporation". Column set: Oil Prod, Oil Sales, Gas
  // Prod, Gas Sales, Water Prod, Water Inject, Tubing Pres., Casing Pres,
  // Choke, Downtime, Downtime Reason. 14-digit API. Mirrors the monthly
  // layout but with daily granularity.
  {
    adapter: stubAdapter({
      name: 'PDS Anadarko Daily',
      operatorName: 'Anadarko Petroleum (Oxy)',
      dataType: 'daily',
      fileKinds: ['pdf'] as const,
      senderEmailPatterns: [/@pdswdx\.com$/i, /@frioenergy\.com$/i, /@oxy\.com$/i],
      detect: (ctx) =>
        !!ctx.pdfText &&
        hasAll(ctx.pdfText, 'Daily Production Estimates', 'PDS Well Data Exchange') &&
        /Anadarko\s*Petroleum/i.test(ctx.pdfText),
    }),
    sampleFile: 'PDSWDX-DP-Anadarko- DAILY.pdf',
    status: 'stub',
    notes:
      'Mirror of Format 1 Anadarko Monthly but daily granularity. 14-digit API. Has full pressure/choke/downtime columns. "Water Inject" (with t) and "Downtime" (single word) distinguish from EOG Daily.',
  },

  // ─── Format 5b — PDS EOG Daily (STUB) ───
  //
  // Daily variant of Format 2. Column header differences from Anadarko
  // Daily: "Water Inj" (no 't'), "Hours Down" (vs "Downtime"). Detect on
  // operator name "EOG Resources" plus the "Water Inj" signature.
  {
    adapter: stubAdapter({
      name: 'PDS EOG Daily',
      operatorName: 'EOG Resources',
      dataType: 'daily',
      fileKinds: ['pdf'] as const,
      senderEmailPatterns: [/@pdswdx\.com$/i, /@frioenergy\.com$/i, /@eogresources\.com$/i],
      detect: (ctx) =>
        !!ctx.pdfText &&
        hasAll(ctx.pdfText, 'Daily Production Estimates', 'PDS Well Data Exchange') &&
        /EOG\s*Resources/i.test(ctx.pdfText) &&
        /Water\s*Inj(?!ect)/i.test(ctx.pdfText), // "Water Inj" but NOT "Water Inject"
    }),
    sampleFile: 'PDSWDX-DP-EOG-DAILY.pdf',
    status: 'stub',
    notes:
      'Mirror of Format 2 EOG Monthly but daily granularity. "Water Inj" (no t) and "Hours Down" column headers. 14-digit API. LINK VJ RANCH pad seen in samples.',
  },

  // ─── Format 5c — PDS Mewbourne Daily (STUB) ───
  //
  // Daily variant of Format 3. Inherits all the Mewbourne-Monthly complexity:
  // 8-digit API (needs padding), extra columns (BTU, Oil Begin/End, Compl.ID
  // — tank gauges, NOT production). Detect on operator name.
  {
    adapter: stubAdapter({
      name: 'PDS Mewbourne Daily',
      operatorName: 'Mewbourne Oil Company',
      dataType: 'daily',
      fileKinds: ['pdf'] as const,
      senderEmailPatterns: [/@pdswdx\.com$/i, /@mewbourne\.com$/i],
      detect: (ctx) =>
        !!ctx.pdfText &&
        hasAll(ctx.pdfText, 'Daily Production Estimates', 'PDS Well Data Exchange') &&
        /Mewbourne\s*Oil/i.test(ctx.pdfText),
    }),
    sampleFile: 'PDSWDX-DP-mewbourne-DAILY.pdf',
    status: 'stub',
    notes:
      'HIGH complexity — mirror of Format 3 Mewbourne Monthly with daily granularity. 8-digit API (pad to 14). BTU, Oil Begin/End are tank inventory, do NOT map to Oil Prod/Sales. Footer: "Mewbourne only provides Daily production for first 2 years of well life."',
  },

  // ─── Format 5d — PDS XTO Daily (STUB) ───
  //
  // Daily variant of Format 4. XTO reports lead with "XTO Energy, Inc." and
  // the Fort Worth address block instead of the standard PDS boilerplate.
  // Column headers use concatenated forms: "WellNumWellName", "OilProdOilSales",
  // "WaterProdWaterInj". Has cumulative columns to exclude.
  {
    adapter: stubAdapter({
      name: 'PDS XTO Daily',
      operatorName: 'XTO Energy (ExxonMobil)',
      dataType: 'daily',
      fileKinds: ['pdf'] as const,
      senderEmailPatterns: [/@pdswdx\.com$/i, /@xtoenergy\.com$/i, /@exxonmobil\.com$/i],
      detect: (ctx) =>
        !!ctx.pdfText &&
        /XTO\s*Energy/i.test(ctx.pdfText) &&
        /Daily\s*Production\s*Estimates/i.test(ctx.pdfText),
    }),
    sampleFile: 'PDSWDX-DP-XTO-DAILY.pdf',
    status: 'stub',
    notes:
      'HIGH complexity — mirror of Format 4 XTO Monthly with daily granularity. Cumulative cols (not in daily but watch for them), GasInj, Producing/Well Status, Oil Begin/End tank gauges. Concatenated header labels ("WellNumWellName", "OilProdOilSales") need custom tokenization.',
  },

  // ─── Format 6 — Aftermath Dailies CSV (IMPLEMENTED) ───
  {
    adapter: aftermathDailiesCsvAdapter,
    sampleFile: '2026_04_07_Aftermath_Dailies.csv',
    status: 'implemented',
    notes:
      'WELL ID and COMPLETION NO arrive as scientific notation (e.g. "1.00E+14") — parsed as integers, raw preserved in extraFields. 10-digit API is padded with trailing zeros to derive API14. Oil Sales column is always blank → stored as null (not 0). Bottomhole pressure kept in extraFields.bhp.',
  },

  // ─── Format 6b — Generic Production CSV (IMPLEMENTED, catches 25+ Frio-family variants) ───
  //
  // Must sit AFTER Aftermath so the strict Aftermath detector wins on its
  // exact header signature. Generic adapter's detect() is deliberately loose:
  // it accepts any CSV with at least one date column, one identity column
  // (API or well name), and one production-volume column. Covers the 26
  // distinct CSV header signatures found in Caleb's first real-email batch.
  //
  // Handles:
  //   - Column-order variations (26 different orders observed)
  //   - Label variants via big alias dictionary ("Oil Prod", "OIL PROD",
  //     "OilProd", "Oil", "Oil (BBL)", "Alloc Oil (bbl)", etc.)
  //   - Row-drift repair (global shift ±2 with API/date anchors)
  //   - Auto-classify daily vs monthly from date cadence + filename hint
  //   - Metadata columns (BTU, Oil Begin/End, Cumulative, etc.) preserved
  //     in extraFields rather than miscoded as production
  //
  // The adapter overrides the registry's `dataType` by returning the
  // classified value at parse time (see parsers/index.ts dispatcher).
  {
    adapter: genericProductionCsvAdapter,
    sampleFile:
      '2026.04.07 Flea Flicker Daily Prod All.csv (plus 25+ other signatures)',
    status: 'implemented',
    notes:
      'Alias-driven. Catches Frio-family and partner-report CSVs that each have unique column layouts. Drift-tolerant: tries ±1/±2 row shifts if API/date don\'t type-check. Classifies daily vs monthly from date cadence + filename. Skip list explicitly excludes tank-gauge (Oil Begin/End), cumulative (OilCum/GasCum), and gas-injection columns so they never miscode as production.',
  },

  // ─── Format 7 — Arlo / Pinon Partner Report XLSX (IMPLEMENTED) ───
  //
  // Covers BOTH the Arlo export and the Pinon export because they share
  // an identical "partner-report" sheet shape (Date | Well Name | API # |
  // Oil/Gas/Water Production | Tubing | Casing | PIP | HZ | Comments).
  //
  // Quirks the adapter handles:
  //   - Excel serial-number dates (46081 → 2026-03-20)
  //   - API variants: numeric (Arlo: 4211534077) vs hyphenated (pinon: "42-115-34077")
  //   - No Oil/Gas Sales → stored as null (not 0)
  //   - PIP, HZ, Comments kept in extraFields
  //   - First-occurrence-wins for duplicate header → canonical mappings
  {
    adapter: arloPartnerReportXlsxAdapter,
    sampleFile: '2026.03.30 Arlo Production.xlsx',
    status: 'implemented',
    notes:
      'Flat "partner-report" sheet. Handles Arlo (numeric API) and Pinon (hyphenated API). Excel serial dates converted via XLSX.SSF.parse_date_code. PIP/HZ/Comments preserved in extraFields. No Oil/Gas Sales in this format — stored as null.',
  },

  // ─── Format 8 — BTA WIO Mailout PDF (IMPLEMENTED) ───
  //
  // pdf-parse's default text output concatenates the 4 numeric columns with
  // no separator (e.g. "11844118151401413361"), which is unrecoverable by
  // string-slicing. Our parser overrides pdf-parse's `pagerender` option so
  // it can read each text item with its x/y coordinate and bucket items
  // into columns by x. Detect still uses the plain-text output since the
  // operator identity strings ("BTA Oil Producers", "Investor", "WIO@btaoil.com")
  // survive the default rendering intact.
  {
    adapter: btaWioMailoutPdfAdapter,
    sampleFile: 'February 2026 West Pecos Trading WIO Mailout.pdf',
    status: 'implemented',
    notes:
      'MEDIUM complexity. No API, no Water Prod, no pressure/choke. Positional (x/y coord) extraction required because pdf-parse concatenates numeric columns without separators. 4 columns by x: Oil Prod | Oil Sold | Gas Prod | Gas Sold. Dates normalized to first-of-month; raw end-of-month date preserved in extraFields.rawProdDate. Needs well_name_aliases for API resolution.',
  },

  // ─── Format 9 — BTA Daily Per-Well Sheets XLSX (IMPLEMENTED) ───
  //
  // Detects on header-row shape ("Well Site | Date | Oil | Gas | Water | Tubing
  // Pressure | ...") PLUS the first-data-row "Well Site" cell matching BTA's
  // compound pattern ("<name> (<code>) - <wellNum>"). This signature is strong
  // enough to match future BTA workbooks even if sheet names change away from
  // the sample's "Hideout 1H" / "Box Elder 3H" pattern.
  //
  // The parser walks EVERY sheet, which is important because BTA's per-well
  // convention means each sheet = one well. "Grand Total" summary rows at the
  // bottom of each sheet are filtered by the well-site string check.
  {
    adapter: btaDailyPerWellXlsxAdapter,
    sampleFile: 'March 2026 Daily Production.xlsx',
    status: 'implemented',
    notes:
      'Multi-sheet (one sheet per well). Well Site cell parsed into wellName + site code + operatorWellId. Choke preserved as string "64/64". No API column → api10/api14 empty, downstream well_name_aliases resolves. Down Time Reason + Down Time Notes merged into downtimeReason.',
  },

  // ─── Format 10 + 35 — Hierarchical Allocated-Production XLSX (IMPLEMENTED) ───
  //
  // ONE adapter covers THREE distinct file sources because they share the
  // hierarchical "well-name row → indented date rows" layout:
  //   - Tap Rock Partner Report             (2026.03.03/04.03 Tap Rock Partner Report *.xlsx)
  //   - West Pecos Partner Report           (PARTNER REPORT - WEST PECOS.xlsx)
  //   - Gretchen / EFG STATE Monthly Report (Monthly Report.xlsx)
  //
  // Differences the adapter absorbs:
  //   - Tap Rock / West Pecos have a 14-column header row with API, pressures,
  //     choke, OpTm, DT (down time). Monthly Report has only 7 columns: name,
  //     Alloc Oil, Alloc Wat, New Prod Gas — and NO API column at all.
  //   - When API is missing, the parser leaves api10/api14 empty and relies
  //     on downstream well_name_aliases lookup (never drops the record).
  //   - The well-identity row's monthly totals are preserved in
  //     extraFields.wellTotalBlock of the FIRST daily record for each well
  //     so nothing is lost if Caleb later wants to spot-check.
  //
  // Detector: row 1 must have "Completion (Well )Name/Date" AND an
  // "Alloc Oil/Gas/Wat" column OR "New Prod Gas". That's specific enough
  // to avoid false matches against other Sheet1 workbooks.
  {
    adapter: hierarchicalAllocatedXlsxAdapter,
    sampleFile: '2026.03.03 Tap Rock Partner Report Feb 2026.xlsx',
    status: 'implemented',
    notes:
      'Covers Tap Rock, West Pecos, and Gretchen/EFG Monthly Report — all share the hierarchical "well-identity row + indented date rows" layout. Handles missing-API case (Monthly Report). Negative values preserved. Well-total rows captured in extraFields.wellTotalBlock. OpTm in extraFields.opTmHr; DT (hr) → hoursDown.',
  },
];

/**
 * Convenience: return a flat list of all adapters.
 */
export function allAdapters(): readonly FormatAdapter[] {
  return FORMAT_REGISTRY.map((r) => r.adapter);
}

/**
 * Convenience for diagnostics / future admin UI — which formats are live?
 */
export function formatInventory(): Array<{
  name: string;
  operator: string;
  dataType: string;
  status: string;
}> {
  return FORMAT_REGISTRY.map((r) => ({
    name: r.adapter.name,
    operator: r.adapter.operatorName,
    dataType: r.adapter.dataType,
    status: r.status,
  }));
}
