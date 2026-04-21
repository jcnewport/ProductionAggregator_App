/**
 * Well Name Resolver
 * ------------------
 * When a parser emits a ProductionRecord with no API10 (because the source
 * file has no API column — common for Monthly_Report.xlsx, BTA Daily/WIO,
 * Frio_Daily_Production.xlsx, etc.), this module is the last chance to
 * hydrate api10 before the storage-layer validator rejects the record.
 *
 * Resolution strategy (in priority order):
 *
 *   1. **Exact match** on `wells.well_name` (case-insensitive + trimmed)
 *   2. **Exact match** on `well_name_aliases.alias` (case-insensitive + trimmed)
 *   3. **Fuzzy match** (Levenshtein similarity ≥ 0.85) against both pools,
 *      AFTER stripping common noise (parentheticals, hashes, trailing codes)
 *
 * Collision policy (Caleb's call, 2026-04-21):
 *   If a query matches MORE than one well at the same tier, we refuse to
 *   guess. The record is returned unresolved with reason "ambiguous
 *   well-name match: N candidates". The row ends up in flagged_records
 *   where Caleb can manually pick the correct well.
 *
 * Self-learning:
 *   When a FUZZY match wins, we auto-upsert the original (un-normalized)
 *   query string into well_name_aliases with source='auto-fuzzy-resolver'
 *   so the next identical arrival becomes an exact alias hit. This keeps
 *   the table warm without any manual curation.
 *
 * Performance:
 *   The resolver pre-loads every well + alias once per `storeMonthly/
 *   Daily` call (typical 100-300 rows + 25 aliases = one query). We do
 *   NOT run a query per record — fuzzy matching over 130 strings in
 *   memory is ~microseconds; the DB round-trip would be the bottleneck.
 */

import { supabase } from './supabase.js';

// ─── Types ────────────────────────────────────────────────────────

/** Minimal well info the resolver needs — matches the subset of wells columns we return. */
export interface ResolvedWell {
  id: string;
  well_name: string;
  api10: string;
  api14: string;
  combocurve_well_id: number | null;
}

/** Outcome for a single lookup. */
export type ResolveOutcome =
  | { matched: ResolvedWell; tier: 'exact' | 'alias' | 'fuzzy'; confidence: number; originalQuery: string }
  | { matched: null; reason: string; originalQuery: string };

/** Pool of candidates loaded once per batch, reused across many resolve() calls. */
export interface ResolverIndex {
  wells: ResolvedWell[];
  aliases: Array<{ alias: string; well: ResolvedWell }>;
}

/**
 * Options for tuning resolver behavior per-call.
 *
 * skipFuzzy:
 *   When true, the resolver stops after Tier 1 (exact name) and Tier 2
 *   (exact alias). Tier 3 (fuzzy Levenshtein) is treated as a refusal.
 *   Rationale: fuzzy is a "guess" tier. Callers that are trying to
 *   pre-empt a silently-wrong value (e.g. an operator-supplied api10 that
 *   happens to be valid but points at the wrong well) should never
 *   second-guess with approximate matching — that's double uncertainty
 *   (wrong api10 + wrong name shape) and can silently reroute data.
 *   Only use fuzzy when the record was going to be rejected anyway
 *   (missing/invalid api10).
 */
export interface ResolveOptions {
  skipFuzzy?: boolean;
}

// ─── Normalization ────────────────────────────────────────────────

/**
 * Tier-1/2 "exact" normalization: trim + lowercase + collapse whitespace.
 * Keeps punctuation, hashes, parentheticals intact — so "Hideout #1H" and
 * "Hideout 1H" are NOT treated as identical at this tier (they'd only
 * converge at fuzzy).
 */
function normalizeExact(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Tier-3 "fuzzy" normalization: aggressive cleanup. Strips parentheticals,
 * hashes, trailing `- NNNNNNN` operator codes, leading "the", commas,
 * periods, slashes. Keeps alphanumerics + single spaces.
 *
 * Examples:
 *   "Hideout 24-13 State Com #1H (PSHA) - 2211506" → "hideout 24-13 state com 1h"
 *   "EFG STATE 57-T2-42 1H"                        → "efg state 57-t2-42 1h"
 *   "EFG STATE 57-T2-42 #1H"                       → "efg state 57-t2-42 1h"
 *   "FLEA FLICKER A"                               → "flea flicker a"
 */
function normalizeFuzzy(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')       // strip (PSHA), (PSGB) etc.
    .replace(/\s-\s*\d{5,}\s*$/, ' ') // strip trailing " - 2211506" codes
    .replace(/#/g, ' ')               // hash treated as whitespace
    .replace(/[.,/]/g, ' ')           // periods, commas, slashes → space
    .replace(/\s+/g, ' ')             // collapse
    .trim();
}

// ─── Levenshtein (tight, allocation-light) ────────────────────────

/**
 * Classic DP Levenshtein. Two rolling rows instead of a full NxM matrix —
 * ~2 * max(a.length, b.length) integer allocations per call.
 * For our strings (rarely > 50 chars), this is ~microseconds.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,         // insert
        prev[j] + 1,             // delete
        prev[j - 1] + cost       // substitute
      );
    }
    [prev, curr] = [curr, prev]; // swap, reuse buffers
  }
  return prev[b.length];
}

/** Similarity ratio in [0,1]. 1 = identical, 0 = max-distance. */
function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

const FUZZY_THRESHOLD = 0.85;

// ─── Index loading ────────────────────────────────────────────────

/**
 * Load every well + alias in one pass. Cheap — ~130 rows today, and even
 * at 10,000 wells this is still a ~1MB JSON payload and sub-second query.
 * Call this ONCE at the top of storeMonthlyRecords / storeDailyRecords
 * and reuse the index across every record in the batch.
 */
export async function loadResolverIndex(): Promise<ResolverIndex> {
  const [wellsRes, aliasesRes] = await Promise.all([
    supabase.from('wells').select('id, well_name, api10, api14, combocurve_well_id'),
    supabase
      .from('well_name_aliases')
      .select('alias, wells(id, well_name, api10, api14, combocurve_well_id)'),
  ]);

  if (wellsRes.error) {
    throw new Error(`Failed to load wells for resolver: ${wellsRes.error.message}`);
  }
  if (aliasesRes.error) {
    throw new Error(`Failed to load well_name_aliases for resolver: ${aliasesRes.error.message}`);
  }

  const wells = (wellsRes.data ?? []) as ResolvedWell[];

  // Supabase FK joins can return either a single object or an array depending
  // on relationship cardinality. Alias → well is many-to-one so we expect a
  // single object, but guard defensively.
  const aliases: Array<{ alias: string; well: ResolvedWell }> = [];
  for (const row of aliasesRes.data ?? []) {
    const w = Array.isArray(row.wells) ? row.wells[0] : row.wells;
    if (w && w.id && w.api10) {
      aliases.push({ alias: row.alias as string, well: w as ResolvedWell });
    }
  }

  return { wells, aliases };
}

// ─── Resolve ──────────────────────────────────────────────────────

/**
 * Resolve a well by name against the pre-loaded index.
 *
 * Returns an outcome with either a matched well (with tier + confidence)
 * or null + reason. Does NOT write back to well_name_aliases — the caller
 * (productionStorage) is responsible for recording fuzzy hits as aliases
 * after a successful storage.
 */
export function resolveWellByName(
  wellName: string,
  index: ResolverIndex,
  options?: ResolveOptions
): ResolveOutcome {
  const originalQuery = wellName;

  if (!wellName || !wellName.trim()) {
    return { matched: null, reason: 'empty well-name query', originalQuery };
  }

  const queryExact = normalizeExact(wellName);
  const queryFuzzy = normalizeFuzzy(wellName);

  // ── Tier 1: exact match on wells.well_name ────────────────────
  const exactWellHits = index.wells.filter((w) => normalizeExact(w.well_name) === queryExact);
  if (exactWellHits.length === 1) {
    return { matched: exactWellHits[0], tier: 'exact', confidence: 1.0, originalQuery };
  }
  if (exactWellHits.length > 1) {
    return {
      matched: null,
      reason: `ambiguous well-name match: ${exactWellHits.length} wells share the name "${wellName}"`,
      originalQuery,
    };
  }

  // ── Tier 2: exact match on well_name_aliases.alias ────────────
  const exactAliasHits = index.aliases.filter((a) => normalizeExact(a.alias) === queryExact);
  const distinctWellIdsFromAliases = new Set(exactAliasHits.map((a) => a.well.id));
  if (distinctWellIdsFromAliases.size === 1) {
    return { matched: exactAliasHits[0].well, tier: 'alias', confidence: 1.0, originalQuery };
  }
  if (distinctWellIdsFromAliases.size > 1) {
    return {
      matched: null,
      reason: `ambiguous alias match: "${wellName}" maps to ${distinctWellIdsFromAliases.size} different wells`,
      originalQuery,
    };
  }

  // ── Tier 3: fuzzy match against wells + aliases ────────────────
  //   If the caller opted out of fuzzy (e.g. pre-empting valid-but-wrong
  //   operator api10s where guessing is unsafe), return a clear refusal.
  if (options?.skipFuzzy) {
    return {
      matched: null,
      reason: `no exact or alias match for "${wellName}" (fuzzy disabled by caller)`,
      originalQuery,
    };
  }

  //   Score everything. If a single candidate clears the threshold AND
  //   beats the runner-up by at least 0.05, we accept it. If two or
  //   more are within 0.05 of the top score, we refuse (ambiguous).
  const candidates: Array<{ wellId: string; well: ResolvedWell; score: number; via: string }> = [];

  for (const w of index.wells) {
    const s = similarity(queryFuzzy, normalizeFuzzy(w.well_name));
    if (s >= FUZZY_THRESHOLD) {
      candidates.push({ wellId: w.id, well: w, score: s, via: `well.well_name="${w.well_name}"` });
    }
  }
  for (const a of index.aliases) {
    const s = similarity(queryFuzzy, normalizeFuzzy(a.alias));
    if (s >= FUZZY_THRESHOLD) {
      candidates.push({
        wellId: a.well.id,
        well: a.well,
        score: s,
        via: `alias="${a.alias}"`,
      });
    }
  }

  if (candidates.length === 0) {
    return {
      matched: null,
      reason: `no well-name match: "${wellName}" (tried exact, alias, fuzzy ≥ ${FUZZY_THRESHOLD})`,
      originalQuery,
    };
  }

  // Keep only the best score per well_id — a well might match on both its
  // name AND an alias; we don't want that to count as two candidates.
  const bestPerWell = new Map<string, typeof candidates[number]>();
  for (const c of candidates) {
    const prev = bestPerWell.get(c.wellId);
    if (!prev || c.score > prev.score) bestPerWell.set(c.wellId, c);
  }
  const ranked = Array.from(bestPerWell.values()).sort((a, b) => b.score - a.score);

  if (ranked.length === 1) {
    return {
      matched: ranked[0].well,
      tier: 'fuzzy',
      confidence: ranked[0].score,
      originalQuery,
    };
  }

  // Multiple wells cleared threshold. Tie-breaker rules:
  //   (a) If the top score is 1.0 (fuzzy-normalized exact match) AND the
  //       runner-up is strictly less than 1.0, accept the top. This is
  //       effectively a tier-2.5 match: the query's noise-stripped form
  //       equals the target's, and no other target shares that property.
  //   (b) Otherwise, require the top to beat #2 by ≥ 0.05.
  //   (c) If neither holds, refuse — flag as ambiguous.
  const [top, runnerUp] = ranked;
  const topIsFuzzyExact = top.score === 1.0 && runnerUp.score < 1.0;
  const topBeatsGap = top.score - runnerUp.score >= 0.05;

  if (topIsFuzzyExact || topBeatsGap) {
    return { matched: top.well, tier: 'fuzzy', confidence: top.score, originalQuery };
  }

  return {
    matched: null,
    reason:
      `ambiguous fuzzy match: "${wellName}" ties between ${ranked.length} wells ` +
      `(top=${top.well.well_name} @ ${top.score.toFixed(2)}, ` +
      `next=${runnerUp.well.well_name} @ ${runnerUp.score.toFixed(2)})`,
    originalQuery,
  };
}

// ─── Alias write-back (for successful fuzzy hits) ─────────────────

/**
 * Record a fuzzy match as an alias for next time. Called by productionStorage
 * AFTER the row has stored successfully. Best-effort — a failure here must
 * NEVER break the import (we log + move on).
 */
export async function recordFuzzyAliasHit(
  originalQuery: string,
  wellId: string
): Promise<void> {
  try {
    const { error } = await supabase
      .from('well_name_aliases')
      .upsert(
        {
          alias: originalQuery,
          well_id: wellId,
          source: 'auto-fuzzy-resolver',
        },
        { onConflict: 'alias', ignoreDuplicates: true }
      );
    if (error) {
      console.warn(
        `[wellNameResolver] Failed to record fuzzy alias "${originalQuery}" → ${wellId}: ${error.message}`
      );
    }
  } catch (err) {
    console.warn(
      `[wellNameResolver] Unexpected error recording fuzzy alias: ${(err as Error).message}`
    );
  }
}

// ─── Exported helpers for testing ─────────────────────────────────

export const _internal = {
  normalizeExact,
  normalizeFuzzy,
  levenshtein,
  similarity,
  FUZZY_THRESHOLD,
};
