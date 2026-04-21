/**
 * ComboCurve Well Catalog Importer
 * --------------------------------
 * Loads a ComboCurve well-header export CSV (filename pattern:
 * `well_<project>_<timestamp>.csv`) into the `combocurve_wells`
 * staging/reference table. Idempotent — re-running on the same file
 * (or a newer version of it) updates rows in place keyed on API10.
 *
 * This is the authoritative source for:
 *   • ComboCurve Well ID (`chosen_id`) — used as the integer "Well ID"
 *     column in every ComboCurve export
 *   • Operator attribution (Current Operator)
 *   • Full well-header metadata (formation, lease, lat/long, etc.)
 *
 * Why a separate table (and not just `wells`): the ComboCurve catalog
 * has ~300 columns we don't own and don't want leaking into our own
 * operational schema. We stash the full row in `raw_fields` (JSONB) so
 * nothing is lost, and project only the columns we actually query on.
 *
 * Usage:
 *   npx tsx scripts/import-combocurve-catalog.ts <csv-path>
 *
 * Then run the backfill (optional, but recommended after a fresh import):
 *   npx tsx scripts/backfill-wells-combocurve-id.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as XLSX from 'xlsx';
import { supabase } from '../src/services/supabase.js';

/* ────────────────────────────────────────────────────────────────
 * Column mappings. Keys are ComboCurve header labels; values are
 * our column names in `combocurve_wells`. Everything else is
 * captured into `raw_fields` (JSONB) so no data is lost.
 * ──────────────────────────────────────────────────────────────── */
const COLUMN_MAP: Record<string, string> = {
  'Well Name': 'well_name',
  'API 14': 'api14',
  'API 10': 'api10',
  'API 12': 'api12',
  'Chosen ID': 'chosen_id',
  'Current Operator': 'current_operator',
};

/** Fields that should be parsed as integers (chosen_id lives here). */
const INT_FIELDS = new Set(['chosen_id']);
/** Fields that should be kept as strings even if numeric-looking
 *  (API numbers have leading zeros we must preserve). */
const STRING_FIELDS = new Set(['api14', 'api10', 'api12', 'well_name', 'current_operator']);

/* ────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────── */

/** Normalize an API-like value to a left-padded string. Handles scientific
 *  notation, numeric input, and already-stringified values. */
function normalizeApi(value: unknown, width: number): string | null {
  if (value === null || value === undefined || value === '') return null;
  let s: string;
  if (typeof value === 'number') {
    // Avoid scientific notation for large numbers.
    s = value.toLocaleString('fullwide', { useGrouping: false });
  } else {
    s = String(value).trim();
  }
  // Remove trailing ".0" from parseFloat string round-trips
  s = s.replace(/\.0+$/, '');
  // Keep only digits (APIs are digits-only)
  s = s.replace(/\D/g, '');
  if (s.length === 0) return null;
  // Left-pad to width (handles operators that provide 8/10/12-digit APIs)
  if (s.length < width) s = s.padStart(width, '0');
  // Right-trim if longer than target width — for API10 we take the first 10
  if (s.length > width) s = s.slice(0, width);
  return s;
}

function toInt(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }
  const s = String(value).trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

interface CatalogRow {
  well_name: string;
  api14: string | null;
  api10: string | null;
  api12: string | null;
  chosen_id: number | null;
  current_operator: string | null;
  raw_fields: Record<string, unknown>;
  source_file: string;
}

/* ────────────────────────────────────────────────────────────────
 * Main
 * ──────────────────────────────────────────────────────────────── */
async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: npx tsx scripts/import-combocurve-catalog.ts <csv-path>');
    process.exit(1);
  }
  const csvPath = path.resolve(arg);
  if (!fs.existsSync(csvPath)) {
    console.error(`File not found: ${csvPath}`);
    process.exit(1);
  }
  const sourceFile = path.basename(csvPath);
  console.log(`[import] Reading ${sourceFile}...`);

  const wb = XLSX.readFile(csvPath, { type: 'file', cellDates: false, raw: true });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  // header: 1 gives us arrays of arrays; we'll build objects manually so
  // the raw_fields capture is exact.
  const aoa = XLSX.utils.sheet_to_json<(string | number | null)[]>(sheet, {
    header: 1,
    blankrows: false,
    raw: true,
  });
  if (aoa.length < 2) {
    console.error('CSV has no data rows.');
    process.exit(1);
  }

  const headers = (aoa[0] as unknown[]).map((h) => String(h ?? '').trim());
  const rows: CatalogRow[] = [];
  let skippedNoApi = 0;

  for (let i = 1; i < aoa.length; i++) {
    const row = aoa[i];
    if (!row || row.length === 0) continue;

    // Build the raw_fields object from every non-empty cell.
    const raw: Record<string, unknown> = {};
    for (let j = 0; j < headers.length; j++) {
      const h = headers[j];
      if (!h) continue;
      const v = row[j];
      if (v === null || v === undefined || v === '') continue;
      raw[h] = v;
    }

    // Project the columns we care about.
    const getRaw = (label: string) => raw[label];
    const api14 = normalizeApi(getRaw('API 14'), 14);
    const api10 = normalizeApi(getRaw('API 10'), 10);
    const api12 = normalizeApi(getRaw('API 12'), 12);
    const wellName = toStringOrNull(getRaw('Well Name'));
    const chosenId = toInt(getRaw('Chosen ID'));
    const currentOperator = toStringOrNull(getRaw('Current Operator'));

    // API10 is our join key on the production side — rows without it can't
    // be linked to wells. Log and skip, but keep them in count.
    if (!api10 && !api14) {
      skippedNoApi++;
      continue;
    }

    rows.push({
      well_name: wellName ?? '(unknown)',
      api14,
      api10,
      api12,
      chosen_id: chosenId,
      current_operator: currentOperator,
      raw_fields: raw,
      source_file: sourceFile,
    });
  }

  console.log(
    `[import] Parsed ${rows.length} catalog rows (skipped ${skippedNoApi} without any API number).`
  );

  // Upsert on api10 — the ComboCurve catalog uses API10 as its de-facto
  // well-identity key (API14 varies per completion). If a row has only
  // API14 and no API10, fall back to derive API10 as the first 10 digits.
  for (const r of rows) {
    if (!r.api10 && r.api14) {
      r.api10 = r.api14.slice(0, 10);
    }
  }

  const CHUNK = 200;
  let upserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error, count } = await supabase
      .from('combocurve_wells')
      .upsert(chunk, { onConflict: 'api10', count: 'exact' });
    if (error) {
      console.error(`[import] Upsert chunk ${i}..${i + chunk.length} failed:`, error.message);
      // If the unique constraint isn't on api10, the first error will tell us.
      process.exit(1);
    }
    upserted += count ?? chunk.length;
    console.log(`[import] Upserted chunk ${i + 1}..${i + chunk.length}`);
  }

  console.log(`\n[import] Done. Upserted ${upserted} rows into combocurve_wells.`);
  console.log(`[import] Source: ${sourceFile}`);
  console.log(
    `[import] Next step: run 'npx tsx scripts/backfill-wells-combocurve-id.ts' to push the chosen_id values into the wells table so exports can use them.`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
