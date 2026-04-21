/**
 * Backfill wells.combocurve_well_id from combocurve_wells
 * -------------------------------------------------------
 * The production pipeline now auto-enriches every new/seen well with its
 * ComboCurve Well ID (chosen_id) via productionStorage.upsertWell().
 * But any well that was created BEFORE that enrichment logic landed, OR
 * any well whose API10 wasn't in the catalog at the time of insert, may
 * still have combocurve_well_id = NULL.
 *
 * This script closes that gap: for every well with NULL combocurve_well_id,
 * look up chosen_id in combocurve_wells by API10 and set it. Idempotent —
 * safe to run any time after a catalog import, and a clean no-op if all
 * gaps are already closed.
 *
 * Usage:
 *   npx tsx scripts/backfill-wells-combocurve-id.ts
 *   npx tsx scripts/backfill-wells-combocurve-id.ts --dry-run   # prints matches, writes nothing
 */
import { supabase } from '../src/services/supabase.js';

interface WellMissing {
  id: string;
  api10: string | null;
  well_name: string | null;
}

interface CatalogRow {
  api10: string;
  chosen_id: number | null;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`[backfill] Running ${dryRun ? '(DRY RUN — no writes)' : '(live)'}`);

  // 1. Pull every well that's missing a ComboCurve Well ID
  const { data: missing, error: missingErr } = await supabase
    .from('wells')
    .select('id, api10, well_name')
    .is('combocurve_well_id', null);

  if (missingErr) {
    console.error('[backfill] Failed to read wells:', missingErr.message);
    process.exit(1);
  }

  const wells = (missing ?? []) as WellMissing[];
  console.log(`[backfill] Found ${wells.length} wells with NULL combocurve_well_id`);
  if (wells.length === 0) {
    console.log('[backfill] Nothing to do. ✓');
    return;
  }

  // Filter to wells that actually have an API10 to join on
  const joinable = wells.filter((w) => !!w.api10);
  const noApi = wells.length - joinable.length;
  if (noApi > 0) {
    console.log(
      `[backfill] ${noApi} of those have no API10 at all — can't match; will need a well_name_aliases route later.`
    );
  }

  if (joinable.length === 0) {
    console.log('[backfill] No wells have API10 to match on. ✓');
    return;
  }

  // 2. Pull every catalog row whose api10 matches one of our missing wells
  const apiList = joinable.map((w) => w.api10!) as string[];
  const { data: catalogRows, error: catErr } = await supabase
    .from('combocurve_wells')
    .select('api10, chosen_id')
    .in('api10', apiList);

  if (catErr) {
    console.error('[backfill] Failed to read combocurve_wells:', catErr.message);
    process.exit(1);
  }

  const byApi10 = new Map<string, number>();
  for (const row of (catalogRows ?? []) as CatalogRow[]) {
    if (row.chosen_id !== null && row.chosen_id !== undefined) {
      byApi10.set(row.api10, row.chosen_id);
    }
  }
  console.log(
    `[backfill] Catalog has matches for ${byApi10.size} of ${joinable.length} joinable wells.`
  );

  // 3. For each match, update the well row
  let updated = 0;
  let unmatched = 0;
  for (const w of joinable) {
    const chosenId = byApi10.get(w.api10!);
    if (chosenId === undefined) {
      unmatched++;
      console.log(
        `[backfill]   ✗ No catalog row for ${w.api10}  (${w.well_name ?? 'unnamed'}) — skipped`
      );
      continue;
    }
    if (dryRun) {
      console.log(
        `[backfill]   ~ Would set well ${w.well_name ?? w.id} (api10=${w.api10}) → combocurve_well_id=${chosenId}`
      );
      updated++;
      continue;
    }
    const { error: updErr } = await supabase
      .from('wells')
      .update({ combocurve_well_id: chosenId })
      .eq('id', w.id);
    if (updErr) {
      console.error(
        `[backfill]   ! Failed to update ${w.api10} (${w.well_name}): ${updErr.message}`
      );
      continue;
    }
    console.log(
      `[backfill]   ✓ ${w.well_name ?? w.id}  api10=${w.api10}  →  combocurve_well_id=${chosenId}`
    );
    updated++;
  }

  console.log('');
  console.log(`[backfill] Summary: ${updated} updated, ${unmatched} unmatched, ${noApi} had no API10.`);
  if (unmatched > 0) {
    console.log(
      `[backfill] To close the "unmatched" gap, re-import the latest ComboCurve catalog:`
    );
    console.log(
      `[backfill]   npx tsx scripts/import-combocurve-catalog.ts <path-to-latest-well_*.csv>`
    );
    console.log('[backfill] Then re-run this script.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
