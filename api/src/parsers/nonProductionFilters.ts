/**
 * Non-Production File Filters
 * ---------------------------
 * Not every attachment that arrives at S.IS_AD_Prod@stewardship.is contains
 * production volumes. Operators and service providers routinely send:
 *
 *   • Tracking / reference spreadsheets (well catalogs, download URL lists)
 *   • Invoices, statements, AFEs
 *   • Sample/test files
 *   • ComboCurve export templates (the master format, EMPTY — not data)
 *
 * If any of those leak into the FormatAdapter chain, two bad things happen:
 *   1. A loose adapter (e.g. "Generic Production CSV") might half-match and
 *      write garbage into production_monthly.
 *   2. They clutter the "flagged for manual review" dashboard, which is
 *      supposed to surface REAL new operator formats needing a parser.
 *
 * NonProductionFilters run BEFORE any FormatAdapter. If one matches, the
 * dispatcher returns `{ kind: 'ignored' }` — the email poller treats this
 * as a clean success (no error list, no red pill on the dashboard) and
 * labels the email_log row with the filter's category.
 *
 * Adding a new filter = one new object here + one entry in NON_PRODUCTION_FILTERS.
 * Keep detect() CHEAP — only read from the pre-populated ParserContext fields.
 */

import type { NonProductionFilter, ParserContext } from './types.js';

/* ────────────────────────────────────────────────────────────────
 * Helper: normalize a header cell for case-insensitive compare.
 * ──────────────────────────────────────────────────────────────── */
function normalizeCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v).trim().toLowerCase();
}

/**
 * West Pecos Trading — Well Tracking Catalog (XLSX)
 * -------------------------------------------------
 * Monthly reference workbook with a row per well and columns pointing to
 * where the actual production data can be downloaded. Contains NO volumes.
 *
 * Confirmed signature (observed in sample file):
 *   Sheet #1 headers: ["Well Name", "API", "Monthly Data", "Daily Data", "Frequency", ""]
 *   Data rows: well name, API, a URL under "Monthly Data" like "pdswdx.com", etc.
 *
 * Detection strategy:
 *   - xlsx/xls only
 *   - Look at the first non-empty row in sheetPreview
 *   - Match if it contains the triple "Monthly Data" + "Daily Data" + "Frequency"
 *     (this is distinctive enough that we'll never hit a real production file)
 */
const westPecosTrackingCatalog: NonProductionFilter = {
  name: 'west-pecos-tracking-catalog',
  category: 'tracking spreadsheet',
  fileKinds: ['xlsx', 'xls'],
  detect(ctx: ParserContext): string | null {
    const preview = ctx.sheetPreview;
    if (!preview || preview.length === 0) return null;

    // Scan the first few rows (some workbooks have a title/blank first row)
    for (let i = 0; i < Math.min(preview.length, 5); i++) {
      const row = preview[i];
      if (!row || row.length === 0) continue;
      const cells = row.map(normalizeCell);
      const hasMonthly = cells.includes('monthly data');
      const hasDaily = cells.includes('daily data');
      const hasFreq = cells.includes('frequency');
      if (hasMonthly && hasDaily && hasFreq) {
        return (
          'Well-tracking catalog (headers include "Monthly Data", "Daily Data", ' +
          '"Frequency" — lists download URLs, not production volumes)'
        );
      }
    }
    return null;
  },
};

/**
 * ComboCurve Export Sample / Template (XLSX)
 * ------------------------------------------
 * The empty 16-column template we use as our own export gold standard.
 * If someone forwards it into the inbox (easy mistake — it's right there
 * in the shared drive), we must NOT try to parse it as production data.
 *
 * Signature: filename contains "ComboCurve" and the workbook is either
 * empty past the header or has exclusively non-numeric content under
 * the template's 16 canonical columns.
 */
const combocurveTemplateSample: NonProductionFilter = {
  name: 'combocurve-template-sample',
  category: 'template/sample file',
  fileKinds: ['xlsx', 'xls', 'csv'],
  detect(ctx: ParserContext): string | null {
    const fname = ctx.filename.toLowerCase();
    // Match the export template by filename signature; conservative pattern.
    const looksLikeTemplate =
      /combocurve/.test(fname) &&
      (/template/.test(fname) || /export[_-]?sample/.test(fname) || /sample/.test(fname));
    if (!looksLikeTemplate) return null;

    return (
      'ComboCurve export template/sample file (filename matches "combocurve…template|sample|export_sample") — ' +
      'this is our own master format skeleton, not operator production data'
    );
  },
};

/**
 * Test-Export Files (our own outputs forwarded back into the inbox)
 * -----------------------------------------------------------------
 * Same problem as above: filenames like "test-export.xlsx" sometimes
 * round-trip into the monitored inbox during dev/QA.
 */
const ourOwnTestExport: NonProductionFilter = {
  name: 'our-own-test-export',
  category: 'test/sample file',
  fileKinds: ['xlsx', 'xls', 'csv'],
  detect(ctx: ParserContext): string | null {
    const fname = ctx.filename.toLowerCase();
    if (/^test[_-]?export\b/.test(fname) || /\btest[_-]?export\b/.test(fname)) {
      return 'Dev/QA test-export file (filename starts or contains "test-export")';
    }
    return null;
  },
};

/**
 * ComboCurve Well Header / Catalog Export
 * ---------------------------------------
 * Frio Energy Holdings (and similar) send periodic CSV exports of the full
 * ComboCurve well-header table. Filename pattern:
 *   well_<ProjectName>_<YYYYMMDDHHMMSS>.csv
 * e.g. well_Frio_Energy_Holdings_I__EPK_Capital_Database_20260420043844.csv
 *
 * These files are CRITICAL reference data (they're what gives us the
 * "Chosen ID" aka ComboCurve Well ID for every export row), but they
 * contain NO production volumes — only well metadata (API, formation,
 * lease, lat/long, spud date, …). They must NEVER be routed to a
 * production parser; the import pipeline for catalogs is the separate
 * `scripts/import-combocurve-catalog.ts`.
 *
 * Detection strategy (belt & suspenders):
 *   1. Filename matches /^well_.*_\d{14}\.csv$/i  (the ComboCurve export
 *      naming convention), OR
 *   2. Tightened header signature (Task #61, 2026-04-21): it is NOT enough
 *      that the row contains "Well Name" + "API 14" + "Chosen ID" — real
 *      operator production CSVs (EFG Monthly, Ruthless Dailies, etc.) also
 *      carry those three columns because operators increasingly include
 *      Chosen ID as a cross-reference. To avoid eating production files,
 *      Rule 2 now requires ALL of:
 *        a) the identity triplet ("Well Name" + "API 14" + "Chosen ID"), AND
 *        b) NO production-volume columns (oil prod, gas prod, water prod,
 *           oil sales, gas sales, …) — a catalog has metadata, never volumes, AND
 *        c) at least TWO catalog-distinctive metadata columns from
 *           CATALOG_ONLY_HEADERS (things like "Chosen ID Key", "Has Monthly
 *           Data", "INPT ID", "Cum BOE", "Scope", etc. — columns a
 *           production CSV would NEVER carry).
 *
 * Why this matters (the bug this fixed): prior to Task #61 the three-header
 * Rule 2 was eating the Frio email's EFG Monthly, EFG State Daily, and
 * Ruthless Dailies Production CSVs. They were silently marked "ignored" on
 * the dashboard and never parsed. The real catalog still carries the full
 * metadata column set, so Rule 2 still catches it cleanly.
 */

/**
 * Headers that appear in a ComboCurve catalog export but NEVER in an
 * operator production CSV. Normalized per `normalizeCell` (lowercased).
 * Any TWO of these present → very strong evidence this is a catalog.
 */
const CATALOG_ONLY_HEADERS: readonly string[] = [
  'chosen id key',
  'assigned well collection',
  'has monthly data',
  'has daily data',
  'inpt id',
  'aries id',
  'phdwin id',
  'first prod date monthly',
  'first prod date daily',
  'last prod date monthly',
  'last prod date daily',
  'perf lateral length',
  'lateral length',
  'landing zone',
  'type curve area',
  'recovery method',
  'cum boe',
  'cum oil',
  'cum gas',
  'cum water',
  'first 12 boe',
  'first 6 boe',
  'last 12 boe',
  'last month boe',
  'prms reserves category',
  'prms reserves sub category',
  'data pool',
  'data source',
  'scope',
  'surface latitude',
  'surface longitude',
  'heel latitude',
  'toe latitude',
  'formation thickness mean',
  'gas specific gravity',
  'oil api gravity',
  'custom string 1',
  'custom string 0',
  'custom number 0',
  'custom date 0',
];

/**
 * Production-volume column headers. If ANY cell in the header row looks
 * like a volume column, the file is production data — not a catalog — even
 * if the row also happens to include the Well Name / API 14 / Chosen ID
 * identity triplet.
 *
 * Match strategy is pattern-based rather than a literal exact-match list so
 * that operator-specific unit formats (e.g. "Oil (BBL/D)", "Gas (MCF/D)",
 * "Water (BBL/D)" used by the Frio/Ruthless dailies) are recognized without
 * having to enumerate every combination of units. The patterns are written
 * to be conservative — they only fire on cells that LOOK like a volume
 * column header (something + oil/gas/water + something-volume-ish), not
 * anything that happens to contain the word "oil".
 *
 * All regexes run against a cell that has already been lowercased and
 * trimmed by `normalizeCell`.
 */
const PRODUCTION_VOLUME_HEADER_PATTERNS: readonly RegExp[] = [
  // "Oil Prod", "oil production", "Gas Prod", "Water Production" (with any separator)
  /^(oil|gas|water)[\s_-]*prod(uction)?$/,
  // "Oil Sales", "gas sold", "oilsales", "gas sold"
  /^(oil|gas|water)[\s_-]*sales?$/,
  /^(oil|gas|water)[\s_-]*sold$/,
  // "Gross Oil", "Net Gas", "Total Water", "New Prod Oil", "New Prod Gas"
  /^(gross|net|total)[\s_-]+(oil|gas|water)$/,
  /^new[\s_-]+prod[\s_-]+(oil|gas|water)$/,
  // "Alloc Oil", "Alloc Gas", "Alloc Wat (bbl)", "Allocated Water"
  /^alloc(ated)?[\s_-]+(oil|gas|wat(er)?)(\s*\(.*\))?$/,
  // "Oil (BBL)", "Oil (BBL/D)", "Gas (MCF)", "Gas (MCF/D)", "Water (BBL)", "Water (BBL/D)"
  /^(oil|gas|water)\s*\(\s*(bbl|mcf)[^)]*\)$/,
  // "Oil Volume", "Gas Volume"
  /^(oil|gas|water)[\s_-]*volume$/,
  // Rate-style abbreviations
  /^bopd$/,
  /^mcfpd$/,
  /^bwpd$/,
  // "Oil BBL", "Gas MCF" (no parens)
  /^(oil|gas|water)[\s_-]+(bbl|mcf)(\s*\/?\s*d)?$/,
  // "MCF Gas", "BBL Oil" — inverted but seen in the wild
  /^(bbl|mcf)[\s_-]+(oil|gas|water)$/,
];

/** Returns true if the header cell looks like a production-volume column. */
function isProductionVolumeHeader(cell: string): boolean {
  return PRODUCTION_VOLUME_HEADER_PATTERNS.some((re) => re.test(cell));
}

const combocurveWellCatalog: NonProductionFilter = {
  name: 'combocurve-well-catalog',
  category: 'well catalog / reference export',
  fileKinds: ['csv', 'xlsx', 'xls'],
  detect(ctx: ParserContext): string | null {
    // Rule 1: filename signature — very specific, real catalogs match this.
    const fname = ctx.filename.toLowerCase();
    if (/^well_.*_\d{14}\.(csv|xlsx|xls)$/i.test(fname)) {
      return (
        'ComboCurve well-header export (filename matches "well_<project>_<timestamp>.{csv|xlsx}") — ' +
        'this is reference metadata; ingest via scripts/import-combocurve-catalog.ts, not the email pipeline'
      );
    }

    // Rule 2: tightened header signature — see header comment above.
    const preview = ctx.sheetPreview;
    if (!preview || preview.length === 0) return null;

    for (let i = 0; i < Math.min(preview.length, 3); i++) {
      const row = preview[i];
      if (!row || row.length === 0) continue;
      const cells = row.map(normalizeCell);

      // (a) identity triplet
      const hasIdentity =
        cells.includes('well name') &&
        cells.includes('api 14') &&
        cells.includes('chosen id');
      if (!hasIdentity) continue;

      // (b) disqualifier: any production-volume column present → this is
      //     production data carrying Chosen ID as a cross-reference. Let
      //     the FormatAdapter chain handle it. Pattern-based so unit-in-parens
      //     variants like "Oil (BBL/D)" are caught without enumerating each.
      const volumeHits = cells.filter(isProductionVolumeHeader);
      if (volumeHits.length > 0) {
        return null;
      }

      // (c) positive: require >= 2 catalog-only columns to confirm.
      const catalogHits = CATALOG_ONLY_HEADERS.filter((h) => cells.includes(h));
      if (catalogHits.length >= 2) {
        // Show up to 3 of the matched signature columns in the reason so
        // the dashboard makes it obvious why we called this a catalog.
        const sample = catalogHits.slice(0, 3).join(', ');
        return (
          'ComboCurve well-header export (headers include "Well Name", "API 14", "Chosen ID" ' +
          `plus ${catalogHits.length} catalog-only metadata columns: ${sample}${
            catalogHits.length > 3 ? ', …' : ''
          } — no production-volume columns present)`
        );
      }
      // Identity triplet present but fewer than 2 catalog-only columns and
      // no production volumes — ambiguous. Don't claim it; let the registry
      // try to parse it. If no adapter matches it'll land in "unrecognized"
      // for manual review, which is the right outcome for ambiguous files.
      return null;
    }
    return null;
  },
};

/**
 * Peloton WellView — Daily Drilling Report (PDF)
 * ----------------------------------------------
 * Peloton WellView is a drilling/completions data management platform that
 * Frio (and many operators) use to distribute daily rig-floor reports while
 * a well is being drilled. The reports cover AFE costs, casing strings, mud
 * checks, drilling parameters (ROT/WOB/GPM), and rig time-logs — NOT
 * production volumes.
 *
 * They land in the inbox forwarded by Aaron with subject lines like:
 *   "Fwd: Daily Drilling - Peloton WellView Report Distribution"
 * with one PDF per well-day under filenames like "<Well Name> <Wellbore>.pdf".
 *
 * These should be CLEANLY IGNORED, not flagged for review:
 *   - There's no production parser to add — the file has no production data.
 *   - They're sent regularly per active rig — they'd otherwise pile up in
 *     the flagged queue forever, drowning out genuine new operator formats
 *     that need a real parser.
 *
 * Detection signature (PDF only):
 *   1. PDF text contains "Peloton" (the platform vendor — branded on every
 *      page header), AND
 *   2. PDF text contains EITHER "Daily Drilling" OR "Mud Checks" — both are
 *      exclusive to drilling/completions reports. No production report ever
 *      contains either string.
 *
 * Conservative-by-design: requires BOTH a vendor signature AND a content
 * signature so that a hypothetical future Peloton ProCount production report
 * (different module, different layout) wouldn't be eaten by this filter.
 *
 * First seen 2026-05-04 — Hollywood Unit 1SH.pdf forwarded by adavis@frioenergypartners.com.
 */
const pelotonWellViewDailyDrilling: NonProductionFilter = {
  name: 'peloton-wellview-daily-drilling',
  category: 'drilling report (Peloton WellView)',
  fileKinds: ['pdf'],
  detect(ctx: ParserContext): string | null {
    const text = ctx.pdfText;
    if (!text) return null;
    // Vendor signature: Peloton appears on every page header.
    const hasVendor = /\bpeloton\b/i.test(text) || /www\.peloton\.com/i.test(text);
    if (!hasVendor) return null;
    // Content signature: one of these strings is unique to drilling-report layouts.
    const hasDrillingHeader = /\bDaily Drilling\b/i.test(text);
    const hasMudChecks = /\bMud Checks\b/i.test(text);
    if (!hasDrillingHeader && !hasMudChecks) return null;

    const which = hasDrillingHeader && hasMudChecks
      ? '"Daily Drilling" + "Mud Checks"'
      : hasDrillingHeader
        ? '"Daily Drilling"'
        : '"Mud Checks"';
    return (
      `Peloton WellView Daily Drilling report (PDF text contains "Peloton" + ${which}). ` +
      'These cover rig operations, AFE costs, mud weights, and drilling parameters — ' +
      'no production volumes. Ignored cleanly so the flagged-review queue stays focused ' +
      'on genuine new operator formats.'
    );
  },
};


/**
 * Inline image attachments (PNG / JPG / GIF / etc.)
 * -------------------------------------------------
 * Emails forwarded from Outlook (and Apple Mail, Gmail's own composer, etc.)
 * commonly carry the sender's signature image as an "attachment" rather than
 * embedded HTML. Gmail's API returns those right alongside the real payload.
 *
 * Before this filter existed, ONE small PNG (e.g. "Outlook-zqz425aa.png") was
 * enough to mark an entire multi-attachment email as 'failed' — even if the
 * other attachments parsed cleanly — because the PNG hit the "unsupported
 * file type" branch and landed in errors[].
 *
 * Policy: we never parse images. If someone ever has a production report that
 * only exists as an image, the right workflow is to send the source workbook
 * or a text-based PDF. We take a broad match (any file kind 'image') and
 * quietly classify it as ignored.
 *
 * NOTE: fileKind='image' is assigned by detectFileKind() in parsers/index.ts
 * based on mime/extension. This filter runs BEFORE the 'unknown'/'image'
 * short-circuit in the dispatcher (see re-ordering in parsers/index.ts).
 */
const inlineImageAttachment: NonProductionFilter = {
  name: 'inline-image-attachment',
  category: 'inline image / email signature',
  fileKinds: ['image'],
  detect(ctx: ParserContext): string | null {
    // Any file that made it to fileKind='image' is, by policy, ignored.
    // No further signature check needed — filename/mime already classified it.
    return (
      `Inline image attachment (${ctx.mimeType || ctx.filename}) — ` +
      'treated as email-signature graphic, not production data. ' +
      'If this was a real report, ask the sender to forward the source workbook/PDF.'
    );
  },
};

/* ────────────────────────────────────────────────────────────────
 * Registry — order matters: most specific first. The dispatcher
 * short-circuits on the first match.
 * ──────────────────────────────────────────────────────────────── */
export const NON_PRODUCTION_FILTERS: readonly NonProductionFilter[] = [
  westPecosTrackingCatalog,
  combocurveTemplateSample,
  ourOwnTestExport,
  combocurveWellCatalog,
  pelotonWellViewDailyDrilling,
  inlineImageAttachment,
] as const;
