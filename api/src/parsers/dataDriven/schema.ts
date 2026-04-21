/**
 * Data-Driven Mapping — JSON Schema
 * ---------------------------------
 * Types + runtime validators for the `format_mappings` table's two JSONB
 * columns (`mapping_config` and `identification_rules`).
 *
 * Why these types matter:
 *   The Mapping Management UI (Phase 3/4) will let Caleb add a new operator
 *   format by filling out a web form. That form serializes to the shapes
 *   defined here. The data-driven adapter at runtime reads those same
 *   shapes back out and runs them against incoming files.
 *
 *   Any change to these types is a breaking change for already-saved
 *   mappings — version them if the schema evolves (see SCHEMA_VERSION).
 *
 * The schema supports two family types of formats:
 *
 *   1. STRUCTURED (CSV / XLSX / XLS)
 *      - Column headers in a header row
 *      - Each data row maps to one ProductionRecord
 *      - Data-driven via a headers → template-field lookup dictionary
 *
 *   2. PDF (coordinate-based, filled in by the Phase 4 visual tool)
 *      - User draws bounding boxes over each column on a rendered page
 *      - Engine reads pdf-parse positional output and assigns each text
 *        item to a column by x-range intersection
 *      - Row grouping via y-coordinate clustering
 *
 * We include both shapes now so the JSONB column design is forward-
 * compatible — the Phase 4 work will build out `pdfEngine.ts` without
 * needing a schema migration.
 */

/** Bump when the MappingConfig shape changes in a backwards-incompatible way. */
export const SCHEMA_VERSION = 1 as const;

/* ══════════════════════════════════════════════════════════════════════
 * SHARED TYPES
 * ═════════════════════════════════════════════════════════════════════ */

/** Every template field the ComboCurve 16-column master export supports,
 *  plus a few internal ones the engine needs. This keys the column-mapping
 *  dictionaries below. */
export type TemplateField =
  | 'wellName'
  | 'api' // raw API — the engine normalizes to api10/api14 per apiConvention
  | 'prodDate'
  | 'oilProd'
  | 'oilSales'
  | 'gasProd'
  | 'gasSales'
  | 'waterProd'
  | 'waterInj'
  | 'daysOn'
  | 'choke'
  | 'tubingPres'
  | 'casingPres'
  | 'hoursDown'
  | 'downtimeReason'
  | 'operatorWellId';

/** A subset of TemplateField that is REQUIRED for any mapping to store a
 *  record. Everything else is optional / nullable. */
export const REQUIRED_TEMPLATE_FIELDS: readonly TemplateField[] = [
  'wellName', // OR api (see wellIdentification)
  'prodDate',
];

/** Cell value transforms the engine applies after extracting a raw cell. */
export type ValueTransform =
  /** Trim + parse as number (handles comma-thousands). Empty → null. */
  | 'number'
  /** Trim + string-stringify. Empty → null. */
  | 'text'
  /** Parse date per the config's dateConvention. */
  | 'date'
  /** Scientific-notation token ("1.00E+14") → integer. Used for Aftermath-style
   *  Excel-exported well IDs where General-format makes 14-digit ints scientific. */
  | 'scientific-notation-int'
  /** Hyphenated-API ("30-025-42724-00-00") → digits-only. */
  | 'strip-hyphens';

/** What to do when the configured column is missing from the source file. */
export type MissingPolicy =
  | 'null' // Emit null in the output — default
  | 'zero' // Coerce to 0 (rare — some operators report absence as 0)
  | 'skip-row' // Drop the whole row (used for required fields if policy=error is too aggressive)
  | 'error'; // Fail the parse loudly (used only for detection-critical cells)

/* ══════════════════════════════════════════════════════════════════════
 * STRUCTURED (CSV / XLSX) CONFIG
 * ═════════════════════════════════════════════════════════════════════ */

/** How to locate a column within the source file's header row. */
export interface StructuredColumnSpec {
  /** How to find the column among the headers. */
  matchType: 'header' | 'header-alias' | 'column-letter' | 'header-regex';
  /** For matchType='header' or 'header-alias': one of these strings matches.
   *  Comparison is case-insensitive + whitespace-trimmed. */
  headers?: string[];
  /** For matchType='column-letter': Excel letter ("A", "B", "AA", ...).
   *  Useful when a file has no usable headers. */
  columnLetter?: string;
  /** For matchType='header-regex': regex string (not including slashes). */
  regex?: string;
  /** Post-extraction transform. Defaults to 'number' for volumes/pressures
   *  and 'text' for names/reasons. */
  transform?: ValueTransform;
  /** What to do if this column isn't present in the file at all. */
  missingPolicy?: MissingPolicy;
}

/** How to pick which sheet(s) to process in an XLSX workbook. */
export interface SheetSelection {
  mode: 'first' | 'named' | 'all' | 'pattern';
  /** For mode='named': exact sheet names (case-insensitive). */
  names?: string[];
  /** For mode='pattern': regex match against the sheet name. */
  pattern?: string;
}

/** Hierarchical-layout support (Format 10 — well-identity row over indented
 *  date rows). Leave `enabled: false` for flat formats. */
export interface HierarchicalConfig {
  enabled: boolean;
  /** Regex that matches the well-identity row in whichever column has the
   *  well name (e.g. "^[A-Z].*STATE" — non-indented, ALL CAPS style). */
  wellHeaderPattern?: string;
  /** Date rows appear indented. This says "if the first column starts with
   *  at least N whitespace chars, treat it as a date row inheriting the most
   *  recent well-identity row." */
  dateRowIndent?: number;
}

/** Well identification strategy — when the file has no API column, the
 *  engine falls back to resolving via well-name lookup. */
export interface WellIdentification {
  /** Preferred source. */
  source: 'api-column' | 'well-name-lookup';
  /** When source='well-name-lookup', which column holds the well name.
   *  (Defaults to the same column mapped to templateField='wellName'.) */
  wellNameColumn?: StructuredColumnSpec;
}

/** How to normalize dates + API numbers into the canonical form. */
export interface Conventions {
  /** Date format in the source. 'auto' tries M/D/YYYY, then YYYY-MM-DD,
   *  then Excel serial number. */
  dateFormat: 'M/D/YYYY' | 'MM/DD/YYYY' | 'YYYY-MM-DD' | 'D/M/YYYY' | 'excel-serial' | 'auto';
  /** For monthly reports, which day-of-month we normalize to.
   *  Project convention = 'first-of-month'. */
  monthlyNormalization?: 'first-of-month' | 'last-of-month' | 'as-is';
  /** What format the API column arrives in. Affects padding logic. */
  apiSource: 'api8' | 'api10' | 'api12' | 'api14' | 'auto';
  /** Whether API is hyphenated ("30-025-42724-00-00") or digits-only. */
  apiFormat?: 'digits-only' | 'hyphenated';
}

/** Full STRUCTURED mapping config. */
export interface StructuredMappingConfig {
  kind: 'structured';
  schemaVersion: number;
  fileKind: 'csv' | 'xlsx' | 'xls';
  dataType: 'monthly' | 'daily' | 'weekly';
  /** 1-indexed row number where the column headers live. Default 1. */
  headerRow: number;
  /** 1-indexed row number where data starts. Defaults to headerRow + 1. */
  dataStartRow?: number;
  /** XLSX: which sheet(s) to process. Ignored for CSV. */
  sheetSelection?: SheetSelection;
  /** Column → template field mappings. */
  columnMappings: Partial<Record<TemplateField, StructuredColumnSpec>>;
  /** Columns to capture as extraFields (audit / debugging). Key = field name
   *  in the extraFields dict; value = how to find the column. */
  extraFieldsCapture?: Record<string, StructuredColumnSpec>;
  /** Well identification — defaults to 'api-column'. */
  wellIdentification?: WellIdentification;
  /** Hierarchical-layout support. Defaults to disabled. */
  hierarchical?: HierarchicalConfig;
  /** Date + API conventions. */
  conventions: Conventions;
}

/* ══════════════════════════════════════════════════════════════════════
 * PDF CONFIG (used by Phase 4 visual tool)
 * ═════════════════════════════════════════════════════════════════════ */

/** A bounding box drawn over one column of a rendered PDF page. */
export interface PdfColumnBox {
  /** 1-indexed page number, or 'all' for repeating-header multi-page PDFs. */
  page: number | 'all';
  /** Left edge in PDF user units (points). Origin = top-left of page. */
  x: number;
  /** Top edge in PDF user units. */
  y: number;
  /** Width in points. */
  width: number;
  /** Height in points. Optional — when omitted, the engine derives row
   *  boundaries by clustering y-coordinates across all items. */
  height?: number;
  /** Post-extraction transform. */
  transform?: ValueTransform;
}

/** How the engine groups items into rows after it's bucketed them by column. */
export interface PdfRowDetection {
  mode: 'y-coordinate-clustering' | 'horizontal-rule-lines' | 'date-anchor';
  /** For mode='y-coordinate-clustering': items within this many points on
   *  the y-axis are considered the same row. Default 4. */
  rowGapPx?: number;
  /** For mode='date-anchor': which column is the date column — its items
   *  define row anchors, everything else snaps to the nearest anchor. */
  dateAnchorField?: TemplateField;
}

/** How to skip header/footer pages that don't contain data rows. */
export interface PdfMultiPage {
  /** When true, column boxes with page='all' apply to every data page.
   *  When false, each page needs its own boxes. */
  repeatsHeader: boolean;
  /** Skip the first N pages (cover/title pages). */
  skipFirstNPages?: number;
  /** Skip the last N pages (footer/summary pages). */
  skipLastNPages?: number;
}

/** Full PDF mapping config. */
export interface PdfMappingConfig {
  kind: 'pdf';
  schemaVersion: number;
  fileKind: 'pdf';
  dataType: 'monthly' | 'daily' | 'weekly';
  /** Column boxes, keyed by template field. */
  columnBoxes: Partial<Record<TemplateField, PdfColumnBox>>;
  /** Extra columns to capture as extraFields. */
  extraFieldsBoxes?: Record<string, PdfColumnBox>;
  /** Row detection strategy. */
  rowDetection: PdfRowDetection;
  /** Multi-page handling. */
  multiPage: PdfMultiPage;
  /** Date + API conventions. */
  conventions: Conventions;
}

/* ══════════════════════════════════════════════════════════════════════
 * IDENTIFICATION RULES
 * ═════════════════════════════════════════════════════════════════════ */

/** Rules the dispatcher uses to decide which mapping applies to a given
 *  incoming attachment. Stored in format_mappings.identification_rules. */
export interface IdentificationRules {
  /** Regex strings matched against the sender email address. */
  senderEmailPatterns?: string[];
  /** Regex strings matched against the attachment filename. */
  filenamePatterns?: string[];
  /** Regex strings matched against the extracted text (PDF) or first-sheet
   *  preview (XLSX/CSV). Very useful for operator-name substrings in
   *  PDS-style feeds where the sender is a generic forwarder. */
  contentSignatures?: string[];
  /** Header tokens that must all be present in the header row (case-insensitive).
   *  ONLY used for structured formats. */
  requiredHeaders?: string[];
  /** If true, ALL of sender/filename/content signatures must match.
   *  If false, ANY of them matching counts as a detection hit.
   *  Default: false (ANY). */
  requireAll?: boolean;
}

/* ══════════════════════════════════════════════════════════════════════
 * UNION + VALIDATION
 * ═════════════════════════════════════════════════════════════════════ */

/** The discriminated union stored in `format_mappings.mapping_config`. */
export type MappingConfig = StructuredMappingConfig | PdfMappingConfig;

/**
 * Runtime validator — accepts `unknown` (straight from DB JSONB) and either
 * returns a typed MappingConfig or throws a clear error. Keeps us safe against
 * bad data in the table without pulling in a heavy schema library like zod.
 */
export function validateMappingConfig(raw: unknown): MappingConfig {
  if (!raw || typeof raw !== 'object') {
    throw new Error('mapping_config must be a JSON object.');
  }
  const cfg = raw as Record<string, unknown>;
  const kind = cfg.kind;
  if (kind !== 'structured' && kind !== 'pdf') {
    throw new Error(`mapping_config.kind must be 'structured' or 'pdf' (got ${JSON.stringify(kind)}).`);
  }
  if (typeof cfg.schemaVersion !== 'number') {
    throw new Error('mapping_config.schemaVersion must be a number.');
  }
  // We're permissive here — the engines below will throw more specific errors
  // when a field they need is missing. The goal of this validator is to catch
  // obvious corruption, not to enforce every nested type.
  return cfg as unknown as MappingConfig;
}

export function validateIdentificationRules(raw: unknown): IdentificationRules {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object') {
    throw new Error('identification_rules must be a JSON object.');
  }
  return raw as IdentificationRules;
}

/** A complete format_mappings row, post-validation. This is what the loader
 *  returns and what the adapter factory consumes. */
export interface LoadedMapping {
  id: string;
  operatorId: string | null;
  name: string;
  fileType: 'pdf' | 'xlsx' | 'xls' | 'csv';
  dataType: 'monthly' | 'daily' | 'weekly';
  config: MappingConfig;
  rules: IdentificationRules;
  version: number;
  isActive: boolean;
  operatorName: string | null; // joined from operators.name
}
