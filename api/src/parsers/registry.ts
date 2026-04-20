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

  // ─── Format 6 — Aftermath Dailies CSV (STUB) ───
  {
    adapter: stubAdapter({
      name: 'Aftermath Dailies CSV',
      operatorName: 'Aftermath (Concho/ConocoPhillips)',
      dataType: 'daily',
      fileKinds: ['csv'] as const,
      detect: (ctx) => {
        if (!ctx.sheetPreview || ctx.sheetPreview.length === 0) return false;
        const headers = ctx.sheetPreview[0]?.map((c) => String(c ?? '').toUpperCase()) ?? [];
        return (
          headers.includes('WELL ID') &&
          headers.includes('COMPLETION NO') &&
          headers.includes('PRODDATE') &&
          /Aftermath|Dailies/i.test(ctx.filename)
        );
      },
    }),
    sampleFile: '2026_04_07_Aftermath_Dailies.csv',
    status: 'stub',
    notes:
      'WELL ID and COMPLETION NO arrive as scientific notation (e.g. "1.00E+14") — parse as integers. 10-digit API. Oil Sales column blank.',
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
