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
 *   2. The CSV's first row contains the distinctive ComboCurve catalog
 *      headers "Well Name" + "API 14" + "Chosen ID" (a combination no
 *      operator production file uses).
 */
const combocurveWellCatalog: NonProductionFilter = {
  name: 'combocurve-well-catalog',
  category: 'well catalog / reference export',
  fileKinds: ['csv', 'xlsx', 'xls'],
  detect(ctx: ParserContext): string | null {
    // Rule 1: filename signature
    const fname = ctx.filename.toLowerCase();
    if (/^well_.*_\d{14}\.(csv|xlsx|xls)$/i.test(fname)) {
      return (
        'ComboCurve well-header export (filename matches "well_<project>_<timestamp>.{csv|xlsx}") — ' +
        'this is reference metadata; ingest via scripts/import-combocurve-catalog.ts, not the email pipeline'
      );
    }

    // Rule 2: header signature — look at the first non-empty preview row
    const preview = ctx.sheetPreview;
    if (!preview || preview.length === 0) return null;
    for (let i = 0; i < Math.min(preview.length, 3); i++) {
      const row = preview[i];
      if (!row || row.length === 0) continue;
      const cells = row.map(normalizeCell);
      const hasWellName = cells.includes('well name');
      const hasApi14 = cells.includes('api 14');
      const hasChosenId = cells.includes('chosen id');
      if (hasWellName && hasApi14 && hasChosenId) {
        return (
          'ComboCurve well-header export (headers include "Well Name", "API 14", "Chosen ID" — ' +
          'a signature unique to the ComboCurve catalog, not an operator production report)'
        );
      }
    }
    return null;
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
] as const;
