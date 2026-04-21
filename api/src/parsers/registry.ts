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
import { hierarchicalAllocatedPdfAdapter } from './hierarchicalAllocatedPdf.js';
import { btaDailyPerWellXlsxAdapter } from './btaDailyPerWellXlsx.js';
import { btaWioMailoutPdfAdapter } from './btaWioMailoutPdf.js';
import { pdsEogMonthlyAdapter } from './pdsEogMonthly.js';
import { pdsXtoMonthlyAdapter } from './pdsXtoMonthly.js';
import { pdsConocoPhillipsDailyAdapter } from './pdsConocoPhillipsDaily.js';
import { pdsAnadarkoDailyAdapter } from './pdsAnadarkoDaily.js';
import { pdsEogDailyAdapter } from './pdsEogDaily.js';
import { pdsXtoDailyAdapter } from './pdsXtoDaily.js';
import { pdsMewbourneDailyAdapter } from './pdsMewbourneDaily.js';
import { pdsMewbourneMonthlyAdapter } from './pdsMewbourneMonthly.js';

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

  // ─── Format 3 — PDS Mewbourne Monthly (IMPLEMENTED) ───
  //
  // Monthly variant of Mewbourne Daily (5c). Same positional +
  // header-discovery pattern as XTO Monthly. 14 mapped columns:
  //   Well Num (8-digit) | Well Name | API (10-digit) | Compl.ID |
  //   Prod Date | BTU | Oil Begin | Oil Prod | OilSales | Oil End |
  //   Gas Prod | GasSales | Water Prod | DaysOn
  //
  // IMPORTANT — correction to the project spec:
  //   The spec note ("API is 8-digit — needs padding/lookup") confused
  //   two separate columns. The ACTUAL Mewbourne PDF has BOTH a 8-digit
  //   "Well Num" (Mewbourne's internal ID, goes to operatorWellId) AND
  //   a distinct 10-digit "API" column (the real state API, padded to
  //   api14 with trailing "0000"). Same pattern as Mewbourne Daily.
  //
  // Tank-gauge handling (critical):
  //   - Oil Begin / Oil End are INVENTORY READINGS, not production.
  //     They are captured in extraFields.oilBegin / .oilEnd for audit
  //     but NEVER reach Oil Prod / OilSales.
  //   - BTU (gas quality) and Compl.ID preserved in extraFields.
  //   - DaysOn IS in the ProductionRecord schema → populated directly.
  //
  // Row grouping: sequential-proximity clustering (4 pt) — same pattern
  // as XTO Daily and Mewbourne Daily. Handles the 2-pt well-identity
  // sub-row split while keeping 10+-pt-apart adjacent rows AND the
  // "(H3OG)" continuation lines in separate clusters.
  //
  // Detect: "Mewbourne" + "Monthly Production Estimates" + (tank-gauge
  // labels "Oil Begin"+"Oil End" OR the Mewbourne-unique footnote
  // "Gas at State Pressure Base"), excludes all other PDS operators.
  {
    adapter: pdsMewbourneMonthlyAdapter,
    sampleFile: 'PDSWDX-MP-mewbourne-MONTHLY.pdf',
    status: 'implemented',
    notes:
      'Positional x/y extraction + header-row discovery. 14 mapped columns. 8-digit "Well Num" → operatorWellId; separate 10-digit "API" → api10/api14 (pad with "0000"). Oil Begin/Oil End are tank-gauge inventory → extraFields, NOT production. BTU + Compl.ID → extraFields. DaysOn → daysOn field. Monthly date normalized to first-of-month; raw preserved. Sequential-proximity row clustering (4 pt).',
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

  // ─── Format 5a — PDS Anadarko Daily (IMPLEMENTED) ───
  //
  // Daily variant of Format 1. Same positional (x/y) extraction +
  // hardcoded column-center plan + header-fingerprint verification
  // pattern as Conoco Daily. 15 columns:
  //   Well ID | Well Name | API | Prod Date |
  //   Oil Prod | Oil Sales | Gas Prod | Gas Sales |
  //   Water Prod | Water Inject |
  //   Casing Pres | Tubing Pres. | Choke | Downtime | Downtime Reason
  //
  // Notable differences from Conoco Daily: Anadarko reports Casing
  // Pres BEFORE Tubing Pres. (reversed), has NO Completion No,
  // NO BHP, and INCLUDES Water Inject, Choke, Downtime, and free-text
  // Downtime Reason columns. 14-digit API (direct, no padding). 16-pt
  // row bucket merges the 2-pt well-name sub-row split while keeping
  // 18-20-pt-apart adjacent rows in separate buckets. Downtime Reason
  // is free text that can sit adjacent to the hoursDown numeric
  // column; items containing letters with x >= 630 are force-routed
  // to downtimeReason.
  {
    adapter: pdsAnadarkoDailyAdapter,
    sampleFile: 'PDSWDX-DP-Anadarko- DAILY.pdf',
    status: 'implemented',
    notes:
      'Positional x/y extraction. 15 columns. Hardcoded column-center plan; 16-pt row bucket. 14-digit API (direct). Detect requires "Water Inject" (with t) + "Anadarko Petroleum" and explicitly excludes Conoco (Completion No + BHP). Free-text Downtime Reason handled by letter-content override.',
  },

  // ─── Format 5b — PDS EOG Daily (IMPLEMENTED) ───
  //
  // Daily variant of Format 2. Same positional + column-plan +
  // fingerprint pattern as the other PDS dailies. 14 columns:
  //   Well ID | Well Name | API | Prod Date |
  //   Gas Prod | Gas Sales | Oil Prod | Oil Sales | Water Prod |
  //   Choke | Tubing Pres. | Casing Pres | Hours Down | Water Inj |
  //   Downtime Reason
  //
  // IMPORTANT: EOG puts GAS columns BEFORE oil columns (opposite of
  // every other PDS daily). Column plan reflects this.
  //
  // Row-split quirk: some rows split into left half + right half at
  // 2-pt y-spacing (e.g. y=422 left / y=424 right). 8-pt bucket merges
  // them while keeping adjacent rows (18 pt apart) separate.
  //
  // Detect: "EOG Resources" + "Water Inj" (no 't') + not-Conoco.
  {
    adapter: pdsEogDailyAdapter,
    sampleFile: 'PDSWDX-DP-EOG-DAILY.pdf',
    status: 'implemented',
    notes:
      'Positional x/y extraction. 14 columns. GAS columns before OIL columns (unique vs other PDS dailies). 8-pt row bucket handles left/right 2-pt row-splits. 14-digit API. Detect requires "Water Inj" (no t) + "EOG Resources" and excludes Conoco.',
  },

  // ─── Format 5c — PDS Mewbourne Daily (IMPLEMENTED) ───
  //
  // Daily variant of Format 3. Same positional + column-plan +
  // fingerprint pattern as the other PDS dailies. 10 mapped columns:
  //   Well ID (8-digit) | Well Name | API (10-digit) | Prod Date |
  //   Gas Prod | Oil Prod | Water Prod |
  //   Tubing Pres. | Casing Pres. | Choke
  //
  // Notable differences from Mewbourne MONTHLY (Format 3 — still stub):
  //   - Daily API is 10-DIGIT, not 8-digit like the monthly. The 8-digit
  //     field is Mewbourne's internal "Well ID" and is stored in
  //     operatorWellId + extraFields.mewbourneWellId.
  //   - No BTU, no Oil Begin/End (tank gauges), no Compl.ID.
  //   - No Sales columns (daily reports gross Prod only).
  //   - No DaysOn, no Hours Down, no Downtime Reason.
  //   - Pressures + Choke ARE present (monthly does not have them).
  //   - Gas Prod comes BEFORE Oil Prod (unusual — matches EOG Daily).
  //
  // Sequential-proximity row clustering (4 pt) handles both single-line
  // rows and the 2-pt well-identity sub-row split cleanly. No
  // continuation merge needed (no free-text columns in this format).
  //
  // Detect: "Mewbourne Oil" + "Daily Production Estimates" + (PDS
  // boilerplate OR the Mewbourne-specific "* Gas at State Pressure Base"
  // footnote) and explicitly excludes other PDS operators.
  {
    adapter: pdsMewbourneDailyAdapter,
    sampleFile: 'PDSWDX-DP-mewbourne-DAILY.pdf',
    status: 'implemented',
    notes:
      'Positional x/y extraction. 10 mapped columns. Daily API is 10-digit (unlike monthly 8-digit); 8-digit Well ID stored separately in operatorWellId. No Sales/DaysOn/Downtime columns (format does not report them). Gas Prod BEFORE Oil Prod. Sequential-proximity row clustering (4 pt); no continuation merge needed.',
  },

  // ─── Format 5d — PDS XTO Daily (IMPLEMENTED) ───
  //
  // Daily variant of Format 4. Same positional + column-plan +
  // fingerprint pattern as the other PDS dailies, but with two
  // XTO-specific adaptations:
  //
  //   1. Tank-gauge columns "Begin Oil" and "End Oil" sit between
  //      Oil Sales and Gas Prod. They are NOT production and must
  //      never reach the ComboCurve template. We solve this by
  //      omitting them from the column plan entirely — items at
  //      their x-centers fall outside the ±15 pt tolerance of any
  //      mapped column and drop silently. "Producing Status"
  //      ("Active" / "Shut In") is dropped the same way.
  //
  //   2. Row grouping: XTO rows are 22-24 pt apart (alternating),
  //      with a 2-pt main/split AND a 10-12 pt downtime-reason text
  //      continuation. No fixed modular row-bucket size handles all
  //      three cleanly, so we use sequential-proximity clustering
  //      (y within 4 pt of previous item = same row) plus a second
  //      pass that merges orphan letter-only clusters at x >= 700
  //      back into the preceding main row. That re-assembles multi-
  //      line reasons like "Planned: S/I Long Term/PP".
  //
  // 10-digit API ("3002542063") → api14 padded with "0000".
  // Daily date preserved as YYYY-MM-DD.
  //
  // Detect: "XTO Energy" + "Daily Production Estimates" + both
  // "BeginOil" AND "EndOil" markers, and explicitly excludes every
  // other PDS operator.
  {
    adapter: pdsXtoDailyAdapter,
    sampleFile: 'PDSWDX-DP-XTO-DAILY.pdf',
    status: 'implemented',
    notes:
      'Positional x/y extraction. 14 mapped columns (of 17 visible). BeginOil/EndOil tank-gauge columns and Producing Status are deliberately DROPPED (not in column plan → outside ±15 pt tolerance of any mapped column). Sequential-proximity row clustering (4 pt) + orphan-merge pass for downtime-reason text wraps. 10-digit API padded to 14. Detect requires BeginOil + EndOil markers and excludes all other PDS operators.',
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

  // ─── Format 10 (PDF variant) — Hierarchical Allocated-Production PDF ───
  //
  // PDF sibling of the XLSX above. Same column semantics and column-mapping
  // conventions so both variants produce identical ProductionRecord rows for
  // the same underlying data. Kept as a SEPARATE adapter (rather than
  // multi-file-kind on the XLSX one) because the parser internals are
  // fundamentally different: pdf-parse emits a line-oriented text stream
  // whose numeric columns get concatenated (no separators), so we run a
  // small state machine over well-name / date / api-11 / api-3 / 8-decimal-
  // row transitions instead of a sheet_to_json grid walk.
  //
  // PDF-rendering quirk handled inline: when a row comes back with 7 decimal
  // matches instead of 8 the missing slot is always the zero-valued tubing
  // pressure (confirmed against the XLSX version of the same report). We
  // null out tubingPres rather than shift casingPres into the Ptub slot.
  //
  // Detect: "Completion Well Name/Date" + an "Alloc <Oil|Gas|Wat>" column
  // + "Well Param Chk Sz" + excludes PDS Well Data Exchange.
  {
    adapter: hierarchicalAllocatedPdfAdapter,
    sampleFile: 'PARTNER REPORT - WEST PECOS.pdf',
    status: 'implemented',
    notes:
      'Line-oriented state machine over pdf-parse output. 8 concatenated decimals per row map to OpTm|DT|Oil|Gas|Wat|ChkSz|Ptub|Pcas. 7-decimal short rows null Ptub (zero-value rendering loss). Totals rows captured in extraFields.wellTotalBlock of first daily record per well. Shares column-mapping conventions with hierarchicalAllocatedXlsx.',
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
