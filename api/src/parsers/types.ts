/**
 * Shared Parser Types
 * -------------------
 * Every operator-specific parser implements the `FormatAdapter` interface
 * and registers itself in `parsers/registry.ts`.
 *
 * Design goals:
 *   1. Adding a new operator format = one new file + one line in registry.ts.
 *      No edits to the dispatcher itself.
 *   2. Signature detection is CHEAP and runs on a shared context so we don't
 *      re-parse the PDF (or re-read the Excel workbook) for every candidate.
 *   3. If no adapter matches, the attachment is flagged for manual review —
 *      we NEVER silently drop data (per project_instructions).
 *
 * Future: per project_instructions, these adapters will eventually be driven
 * by rows in the `format_mappings` table (JSON config in DB, updatable without
 * code changes). For Phase 1 / early Phase 2 we keep it in code for speed.
 */

/* ────────────────────────────────────────────────────────────────
 * Production Record — the normalized output of every parser.
 * Matches the ComboCurve 16-column master template closely.
 * Every adapter must produce records in this shape.
 * ──────────────────────────────────────────────────────────────── */
export interface ProductionRecord {
  api14: string;
  api10: string;
  wellName: string;
  combocurveWellId: number | null;
  operatorWellId: number | null;
  prodDate: string;              // YYYY-MM-DD (ISO); monthly = first-of-month
  oilProd: number | null;
  gasProd: number | null;
  waterProd: number | null;
  gasSales: number | null;
  oilSales: number | null;
  waterInj: number | null;
  daysOn: number | null;
  choke: string | null;
  tubingPres: number | null;
  casingPres: number | null;
  hoursDown: number | null;
  downtimeReason: string | null;
  /** Anything else the format emits that doesn't fit the standard columns. */
  extraFields: Record<string, unknown>;
}

/* ────────────────────────────────────────────────────────────────
 * File kinds we accept. Keeps signature checks simple per type.
 * ──────────────────────────────────────────────────────────────── */
export type FileKind = 'pdf' | 'xlsx' | 'xls' | 'csv' | 'unknown';

/* ────────────────────────────────────────────────────────────────
 * ParserContext — shared read state passed to every adapter's
 * detect() and parse() methods. Populated ONCE per attachment by
 * the dispatcher so we don't re-parse the PDF/workbook repeatedly.
 * ──────────────────────────────────────────────────────────────── */
export interface ParserContext {
  /** Raw file bytes. */
  buffer: Buffer;
  /** Original filename (e.g. "PDSWDX-MP-Anadarko-MONTHLY.pdf"). */
  filename: string;
  /** Mime type from Gmail attachment headers. */
  mimeType: string;
  /** Sender email (full address, e.g. "prod@frioenergy.com"). */
  senderEmail: string;
  /** File kind derived from mime/extension/magic bytes. */
  fileKind: FileKind;

  /* ─── Lazily populated by the dispatcher ─── */
  /** Full text extracted from PDF — only populated for PDFs. */
  pdfText?: string;
  /** Sheet names in the workbook — only populated for xlsx/xls. */
  sheetNames?: string[];
  /** First-sheet preview as 2D array — only for xlsx/xls/csv. Small (first ~20 rows). */
  sheetPreview?: (string | number | null)[][];
}

/* ────────────────────────────────────────────────────────────────
 * FormatAdapter — the contract every parser implements.
 * ──────────────────────────────────────────────────────────────── */
export interface FormatAdapter {
  /** Stable human-readable name — shown in logs + UI. Must be unique. */
  readonly name: string;
  /** Operator name that shows up in the operators table. */
  readonly operatorName: string;
  /** Monthly, daily, or weekly granularity. */
  readonly dataType: 'monthly' | 'daily' | 'weekly';
  /** File types this adapter can handle. */
  readonly fileKinds: readonly FileKind[];
  /** Optional hint: sender email patterns this operator reports from.
   *  Used as a short-circuit when email headers clearly identify the operator. */
  readonly senderEmailPatterns?: readonly RegExp[];

  /**
   * Cheap signature check — should NOT re-parse the file. Reads only from
   * pre-populated fields in ParserContext (pdfText, sheetNames, sheetPreview).
   * Returns true if this adapter recognizes the file.
   */
  detect(ctx: ParserContext): boolean;

  /**
   * Full parse — returns normalized ProductionRecord[]. Throws with a clear
   * message if parsing fails after detect() said true (which the dispatcher
   * will capture and log as an error, not as "unrecognized").
   */
  parse(ctx: ParserContext): Promise<ProductionRecord[]>;
}

/* ────────────────────────────────────────────────────────────────
 * Adapter registration status — used so we can expose "here are the
 * 10 formats we plan to support and which are implemented" via the
 * dispatcher's introspection API (helpful for the UI later).
 * ──────────────────────────────────────────────────────────────── */
export interface RegisteredFormat {
  adapter: FormatAdapter;
  /** Path to the sample file we validated against. */
  sampleFile: string;
  /** 'implemented' | 'stub' — stubs throw in parse() so they can't accidentally run. */
  status: 'implemented' | 'stub';
  /** Freeform notes about the format, quirks, known edge cases. */
  notes?: string;
}
