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

  // ─── Format 2 — PDS EOG Monthly (STUB) ───
  //
  // EOG PDFs from Frio Energy share the top-of-document boilerplate with Anadarko
  // PDFs. Distinguishing markers live in the column header row:
  //   EOG uses "Water Inj" (no 't') and "DaysOn" (no space)
  //   Anadarko uses "Water Inject" and "Days On" (handled in its own detect)
  // We rely on those column-header spellings rather than an operator name,
  // because the operator name "EOG RESOURCES" is not always present in the
  // extracted text stream in a reliable spot.
  {
    adapter: stubAdapter({
      name: 'PDS EOG Monthly',
      operatorName: 'EOG Resources',
      dataType: 'monthly',
      fileKinds: ['pdf'] as const,
      senderEmailPatterns: [/@frioenergy\.com$/i, /@pdswdx\.com$/i],
      detect: (ctx) =>
        !!ctx.pdfText &&
        hasAll(ctx.pdfText, 'Monthly Production Estimates', 'PDS Well Data Exchange') &&
        /Water\s*Inj(?!ect)/i.test(ctx.pdfText) && // "Water Inj" but NOT "Water Inject"
        /DaysOn/i.test(ctx.pdfText),               // no space between Days and On
    }),
    sampleFile: 'PDSWDX-MP-EOG-MONTHLY.pdf',
    status: 'stub',
    notes:
      'Column order differs from Anadarko: Well Name before Well ID. Distinguishing signature: "Water Inj" (no t) and "DaysOn" (no space) in column headers.',
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

  // ─── Format 4 — PDS XTO Monthly (STUB) ───
  {
    adapter: stubAdapter({
      name: 'PDS XTO Monthly',
      operatorName: 'XTO Energy (ExxonMobil)',
      dataType: 'monthly',
      fileKinds: ['pdf'] as const,
      senderEmailPatterns: [/@pdswdx\.com$/i, /@xtoenergy\.com$/i],
      detect: (ctx) =>
        !!ctx.pdfText &&
        hasAll(ctx.pdfText, 'Monthly Production Estimates', 'PDS Well Data Exchange') &&
        /XTO ENERGY/i.test(ctx.pdfText),
    }),
    sampleFile: 'PDSWDX-MP-XTO-MONTHLY.pdf',
    status: 'stub',
    notes:
      'HIGH complexity. Cumulative cols (OilCum, GasCum) must NOT map to template. Has GasInj, Producing/Well Status. Some historical OilProd values appear to be data artifacts.',
  },

  // ─── Format 5 — PDS ConocoPhillips Daily (STUB) ───
  {
    adapter: stubAdapter({
      name: 'PDS ConocoPhillips Daily',
      operatorName: 'ConocoPhillips (Concho)',
      dataType: 'daily',
      fileKinds: ['pdf'] as const,
      senderEmailPatterns: [/@pdswdx\.com$/i, /@conocophillips\.com$/i],
      detect: (ctx) =>
        !!ctx.pdfText &&
        hasAll(ctx.pdfText, 'Daily Production Estimates', 'PDS Well Data Exchange') &&
        /CONCHO|CONOCO/i.test(ctx.pdfText),
    }),
    sampleFile: 'PDSWDX-DP-conocophillips-DAILY.pdf',
    status: 'stub',
    notes:
      'Has pressure data (Tubing, Casing, BHP). API is 12-digit. Oil Sales column appears blank in samples. BHP stored as extra metadata.',
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

  // ─── Format 7 — Arlo Production XLSX (STUB) ───
  {
    adapter: stubAdapter({
      name: 'Arlo Partner Report XLSX',
      operatorName: 'Arlo',
      dataType: 'daily',
      fileKinds: ['xlsx'] as const,
      detect: (ctx) => {
        if (!ctx.sheetNames) return false;
        return ctx.sheetNames.some((n) => /partner.?report/i.test(n));
      },
    }),
    sampleFile: '2026_03_30_Arlo_Production.xlsx',
    status: 'stub',
    notes:
      'Single sheet "partner-report". Only Prod columns, no Sales. PIP and HZ are extra metadata. No Choke, no Hours Down.',
  },

  // ─── Format 8 — BTA WIO Mailout PDF (STUB) ───
  //
  // The BTA WIO Mailout has a very different structure than PDS reports. The
  // first page shows column headers that pdf-parse emits as split lines:
  //   "InvestorDateOil"
  //   "Prod"
  //   "Oil"
  //   "Sold"     ← cannot rely on "Oil Sold" as a contiguous substring
  // The reliable unique markers are the operator identity block:
  //   "BTA Oil Producers, LLC"
  //   "WIO@btaoil.com"
  // plus the "Investor" column label.
  {
    adapter: stubAdapter({
      name: 'BTA WIO Mailout Monthly',
      operatorName: 'BTA Oil Producers',
      dataType: 'monthly',
      fileKinds: ['pdf'] as const,
      senderEmailPatterns: [/@btaoil\.com$/i, /@btaoilproducers\.com$/i],
      detect: (ctx) =>
        !!ctx.pdfText &&
        /BTA\s*Oil\s*Producers/i.test(ctx.pdfText) &&
        /Investor/i.test(ctx.pdfText) &&
        // Either the WIO email or the operator's Midland address — both are stable
        // signatures even if the header row gets mangled by pdf-parse line breaks.
        (/WIO@btaoil\.com/i.test(ctx.pdfText) || /Midland,\s*TX/i.test(ctx.pdfText)),
    }),
    sampleFile: 'February_2026_West_Pecos_Trading_WIO_Mailout.pdf',
    status: 'stub',
    notes:
      'MEDIUM complexity. No API. No Water Prod. "Investor" column = well name. Needs well name → API lookup table (well_name_aliases). Column header text is fragmented across lines in pdf-parse output — detect on operator identity instead.',
  },

  // ─── Format 9 — BTA Daily Per-Well Sheets XLSX (STUB) ───
  {
    adapter: stubAdapter({
      name: 'BTA Daily Per-Well Sheets',
      operatorName: 'BTA Oil Producers',
      dataType: 'daily',
      fileKinds: ['xlsx'] as const,
      detect: (ctx) => {
        // Signature: multi-sheet with sheet names like "Hideout 1H", "Box Elder 3H"
        if (!ctx.sheetNames || ctx.sheetNames.length < 2) return false;
        const looksBta = ctx.sheetNames.some((n) =>
          /hideout|box\s*elder/i.test(n)
        );
        return looksBta;
      },
    }),
    sampleFile: 'March_2026_Daily_Production.xlsx',
    status: 'stub',
    notes:
      'Multi-sheet (one sheet per well). Well Site column has compound "Name (code) - WellNum". Choke as string "64/64". Has downtime data.',
  },

  // ─── Format 10 — Hierarchical Monthly Report XLSX (STUB) ───
  {
    adapter: stubAdapter({
      name: 'Hierarchical Monthly Report XLSX',
      operatorName: 'Unknown (EFG STATE)',
      dataType: 'daily',
      fileKinds: ['xlsx'] as const,
      detect: (ctx) => {
        if (!ctx.sheetPreview || ctx.sheetPreview.length === 0) return false;
        const flat = ctx.sheetPreview
          .flat()
          .map((c) => String(c ?? ''))
          .join(' ');
        return /Alloc\s*Oil/i.test(flat) && /New\s*Prod\s*Gas/i.test(flat);
      },
    }),
    sampleFile: 'Monthly_Report.xlsx',
    status: 'stub',
    notes:
      'HIGH complexity. Hierarchical rows: well name row with monthly total, then indented date rows. "Alloc" = allocated production = Prod. No API — needs name lookup. Some negative values are valid.',
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
