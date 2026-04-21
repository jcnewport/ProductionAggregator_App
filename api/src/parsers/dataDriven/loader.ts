/**
 * Mapping Loader — Supabase → LoadedMapping[]
 * -------------------------------------------
 * Pulls every active row from the `format_mappings` table, joined to
 * `operators`, validates the JSONB columns, and returns a normalized array
 * the adapter factory can consume.
 *
 * Why this has an in-memory cache:
 *   Every inbound email triggers the dispatcher → the dispatcher builds an
 *   adapter list on every call. Going to Supabase on every email would add
 *   ~50ms of latency and needlessly stress the free-tier connection pool.
 *   A 60-second in-memory TTL means an edit in the Mapping UI propagates to
 *   the live poller within a minute, which is plenty fast for Caleb's use.
 *
 * Cache invalidation:
 *   - Time-based: entries older than TTL_MS are refetched on next access.
 *   - Explicit:   invalidateMappingCache() nukes the cache — call this from
 *                 the admin CRUD endpoints (Phase 2) after any write.
 *
 * Failure modes:
 *   - Supabase down → return cached copy if we have one; else throw.
 *   - Bad JSONB in one row → skip that row, log a warning, keep going.
 *     One bad mapping must not poison the whole pipeline.
 */

import {
  validateMappingConfig,
  validateIdentificationRules,
  type LoadedMapping,
} from './schema.js';

// NOTE: we deliberately do NOT `import { supabase } from '../../services/supabase.js'`
// at the top level here. That module throws at import time if SUPABASE_URL or
// SUPABASE_SERVICE_KEY are missing — which breaks every offline test that
// exercises the dispatcher without needing DB-backed mappings (e.g. the
// Aftermath precedence test). We lazy-import below inside fetchFreshMappings()
// so the failure is contained to actual fetch attempts, not module load.

/** Cache lifetime. 60 seconds hits the sweet spot between freshness and
 *  overhead — the UI preview endpoint (Phase 2) will bypass cache anyway. */
const TTL_MS = 60 * 1000;

let cachedMappings: LoadedMapping[] | null = null;
let cachedAt = 0;
let inflight: Promise<LoadedMapping[]> | null = null;

/** When Supabase is unreachable, we log a warning the FIRST time per process
 *  lifetime and then stay quiet — otherwise every inbound email would spam
 *  the logs. Reset by invalidateMappingCache(). */
let loaderFailureWarned = false;

/** Shape of a raw join between format_mappings + operators we pull from DB. */
interface RawMappingRow {
  id: string;
  operator_id: string | null;
  name: string;
  file_type: string;
  data_type: string;
  mapping_config: unknown;
  identification_rules: unknown;
  version: number | null;
  is_active: boolean | null;
  operators?: { name?: string | null } | null;
}

/** Fetch all active mappings, validate, return. */
async function fetchFreshMappings(): Promise<LoadedMapping[]> {
  // Lazy import — see note at top of file. Any env-var or connection failure
  // here is caught by the try/wrap in getActiveMappings() below.
  const { supabase } = await import('../../services/supabase.js');
  const { data, error } = await supabase
    .from('format_mappings')
    .select(
      `
      id,
      operator_id,
      name,
      file_type,
      data_type,
      mapping_config,
      identification_rules,
      version,
      is_active,
      operators ( name )
    `
    )
    .eq('is_active', true);

  if (error) {
    throw new Error(`[mapping-loader] Supabase query failed: ${error.message}`);
  }

  const rows = (data ?? []) as unknown as RawMappingRow[];
  const loaded: LoadedMapping[] = [];

  for (const row of rows) {
    try {
      const config = validateMappingConfig(row.mapping_config);
      const rules = validateIdentificationRules(row.identification_rules);

      // Guard against file_type / data_type widening.
      if (!['pdf', 'xlsx', 'xls', 'csv'].includes(row.file_type)) {
        console.warn(`[mapping-loader] skipping ${row.id}: unknown file_type "${row.file_type}"`);
        continue;
      }
      if (!['monthly', 'daily', 'weekly'].includes(row.data_type)) {
        console.warn(`[mapping-loader] skipping ${row.id}: unknown data_type "${row.data_type}"`);
        continue;
      }

      loaded.push({
        id: row.id,
        operatorId: row.operator_id,
        name: row.name,
        fileType: row.file_type as LoadedMapping['fileType'],
        dataType: row.data_type as LoadedMapping['dataType'],
        config,
        rules,
        version: row.version ?? 1,
        isActive: row.is_active ?? true,
        operatorName: row.operators?.name ?? null,
      });
    } catch (err) {
      // One bad row shouldn't break the whole list. Log + skip.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[mapping-loader] skipping mapping ${row.id} ("${row.name}"): ${msg}`);
    }
  }

  return loaded;
}

/**
 * Public: return the current list of active, validated mappings.
 * Caches across calls; refreshes every TTL_MS.
 * If Supabase is momentarily unavailable and we have a cached list, we return
 * the stale cache rather than failing the whole email pipeline.
 */
export async function getActiveMappings(): Promise<LoadedMapping[]> {
  const now = Date.now();
  const fresh = cachedMappings !== null && now - cachedAt < TTL_MS;
  if (fresh && cachedMappings) return cachedMappings;

  // Coalesce concurrent refreshes — multiple inbound emails shouldn't all
  // fire a fetch at the same moment.
  if (inflight) return inflight;

  inflight = fetchFreshMappings()
    .then((mappings) => {
      cachedMappings = mappings;
      cachedAt = Date.now();
      return mappings;
    })
    .catch((err) => {
      // If we have ANY cached copy, serve it during the outage.
      if (cachedMappings) {
        console.warn('[mapping-loader] fresh fetch failed, serving stale cache:', err);
        return cachedMappings;
      }
      throw err;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

/** Call this from admin CRUD endpoints after any write. */
export function invalidateMappingCache(): void {
  cachedMappings = null;
  cachedAt = 0;
  loaderFailureWarned = false;
}

/** Let the dispatcher suppress noisy repeated warnings when the loader fails
 *  (e.g. offline-test runs where Supabase env vars aren't set). Returns true
 *  on the first failure and false on every subsequent failure. */
export function shouldLogLoaderFailure(): boolean {
  if (loaderFailureWarned) return false;
  loaderFailureWarned = true;
  return true;
}

/** Testing-only: inject a list directly (bypasses Supabase). */
export function __setMappingsForTest(m: LoadedMapping[] | null): void {
  cachedMappings = m;
  cachedAt = m ? Date.now() : 0;
}
