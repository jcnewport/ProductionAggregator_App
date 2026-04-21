/**
 * PDF Engine — stub for Phase 1.
 * -------------------------------
 * The full implementation lands in Phase 4 alongside the visual mapping tool.
 * The schema (PdfMappingConfig) is already in place so saved mappings will
 * round-trip, and the adapter factory below can already route to this engine
 * without needing a schema migration later.
 *
 * Why stub now instead of waiting?
 *   1. Keeps the adapter factory symmetric (structured + pdf branches).
 *   2. If a PDF mapping is accidentally saved in Phases 2/3 via the admin
 *      API, dispatch at least surfaces a clear "not yet implemented" error
 *      in email_log instead of silently ignoring the file.
 *
 * When Phase 4 lands, runPdfEngine will use pdf-parse's positional output
 * (items with x/y/width coordinates) to assign each text item to the column
 * whose bounding box encloses it, cluster y-coordinates into rows, and apply
 * the same Conventions pipeline (date formats, API widths) that the
 * structured engine uses.
 */

import type { ProductionRecord } from '../types.js';
import type { PdfMappingConfig } from './schema.js';

export function runPdfEngine(_buffer: Buffer, cfg: PdfMappingConfig): ProductionRecord[] {
  // Argument used for signature parity with runStructuredEngine; not yet read.
  void cfg;
  throw new Error(
    '[pdf-engine] PDF data-driven engine is not yet implemented. ' +
      'Scheduled for Phase 4 of Task #79 (visual bounding-box tool).'
  );
}
