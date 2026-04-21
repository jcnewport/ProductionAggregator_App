/**
 * test-well-name-resolver.ts
 *
 * Synthetic unit tests for wellNameResolver. Runs with:
 *   cd api && npx tsx scripts/test-well-name-resolver.ts
 *
 * These tests use in-memory indexes — NO Supabase connection required.
 * This is intentional: resolver logic must be verifiable without real
 * data, and without network round-trips.
 */

import {
  resolveWellByName,
  _internal,
  type ResolverIndex,
  type ResolvedWell,
} from '../src/services/wellNameResolver.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, description: string, details?: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${description}`);
  } else {
    failed++;
    console.log(`  ✗ ${description}${details ? `  — ${details}` : ''}`);
  }
}

// ─── Test fixtures ────────────────────────────────────────────────

const wEfg1H: ResolvedWell = {
  id: 'well-efg-1h',
  well_name: 'EFG STATE 57-T2-42 1H',
  api10: '4238939516',
  api14: '42389395160000',
  combocurve_well_id: 4238939516,
};
const wEfg2H: ResolvedWell = {
  id: 'well-efg-2h',
  well_name: 'EFG STATE 57-T2-42 2H',
  api10: '4238939517',
  api14: '42389395170000',
  combocurve_well_id: 4238939517,
};
const wHideout1H: ResolvedWell = {
  id: 'well-hideout-1h',
  well_name: 'Hideout 24-13 State Com #1H',
  api10: '3500536001',
  api14: '35005360010000',
  combocurve_well_id: 3500536001,
};
const wHideout2H: ResolvedWell = {
  id: 'well-hideout-2h',
  well_name: 'Hideout 24-13 State Com #2H',
  api10: '3500536002',
  api14: '35005360020000',
  combocurve_well_id: 3500536002,
};
const wDupeA: ResolvedWell = {
  id: 'well-dupe-a',
  well_name: 'DUPLICATE NAME',
  api10: '1111111111',
  api14: '11111111110000',
  combocurve_well_id: 1,
};
const wDupeB: ResolvedWell = {
  id: 'well-dupe-b',
  well_name: 'DUPLICATE NAME',
  api10: '2222222222',
  api14: '22222222220000',
  combocurve_well_id: 2,
};

const index: ResolverIndex = {
  wells: [wEfg1H, wEfg2H, wHideout1H, wHideout2H, wDupeA, wDupeB],
  aliases: [
    { alias: 'Hideout 24-13 State Com #1H (PSHA) - 2211506', well: wHideout1H },
    { alias: 'Hideout 24-13 State Com #2H (PSGB) - 2211507', well: wHideout2H },
  ],
};

// ─── Tests ────────────────────────────────────────────────────────

console.log('\n🧪 Well Name Resolver tests\n');

// Exact match tier
console.log('Tier 1 — exact match on wells.well_name');
{
  const r = resolveWellByName('EFG STATE 57-T2-42 1H', index);
  assert(r.matched?.id === wEfg1H.id, 'Exact match EFG 1H', JSON.stringify(r));
  assert(r.matched !== null && r.tier === 'exact', 'Tier reported as exact');
  assert(r.matched !== null && r.confidence === 1.0, 'Confidence is 1.0 for exact');
}
{
  const r = resolveWellByName('  efg state 57-t2-42 1h  ', index); // case + whitespace
  assert(r.matched?.id === wEfg1H.id, 'Case-insensitive exact match');
}

// Alias tier
console.log('\nTier 2 — exact match on well_name_aliases.alias');
{
  const r = resolveWellByName('Hideout 24-13 State Com #1H (PSHA) - 2211506', index);
  assert(r.matched?.id === wHideout1H.id, 'Alias match with (PSHA) suffix');
  assert(r.matched !== null && r.tier === 'alias', 'Tier reported as alias');
}

// Fuzzy tier
console.log('\nTier 3 — fuzzy match (Levenshtein ≥ 0.85)');
{
  const r = resolveWellByName('EFG STATE 57-T2-42 #1H', index); // extra hash
  assert(r.matched?.id === wEfg1H.id, 'Fuzzy match with extra #');
  assert(r.matched !== null && r.tier === 'fuzzy', 'Tier reported as fuzzy');
  // NOTE: confidence can be 1.0 in fuzzy tier when the noise-stripped
  // forms happen to be identical (the raw strings differed only in
  // characters that normalizeFuzzy strips). That's still "fuzzy" — we
  // reached the match via fuzzy normalization, not raw equality.
  assert(r.matched !== null && r.confidence <= 1.0, 'Confidence ≤ 1 for fuzzy');
}
{
  const r = resolveWellByName('Hideout 24-13 State Com 1H', index); // missing #
  assert(r.matched?.id === wHideout1H.id, 'Fuzzy match missing #');
}
{
  const r = resolveWellByName('Hideout 24-13 State Com #1H (PSHX) - 9999999', index); // different suffix
  assert(
    r.matched?.id === wHideout1H.id,
    'Fuzzy match strips parens + trailing code, picks 1H over 2H',
    r.matched === null ? `no match: ${r.reason}` : `matched ${r.matched.id}`
  );
}

// Collision policy
console.log('\nCollision policy — flag, don\'t guess');
{
  const r = resolveWellByName('DUPLICATE NAME', index);
  assert(r.matched === null, 'Duplicate exact names → no match');
  assert(r.matched === null && r.reason.includes('ambiguous'), 'Reason contains "ambiguous"');
}

// No match
console.log('\nNo match');
{
  const r = resolveWellByName('Totally Nonexistent Well ZZZ', index);
  assert(r.matched === null, 'Unknown name → no match');
  assert(r.matched === null && r.reason.includes('no well-name match'), 'Reason indicates no match');
}

// Empty / whitespace input
console.log('\nEmpty input');
{
  const r = resolveWellByName('', index);
  assert(r.matched === null, 'Empty string → no match');
  assert(r.matched === null && r.reason === 'empty well-name query', 'Specific reason for empty');
}
{
  const r = resolveWellByName('   ', index);
  assert(r.matched === null, 'Whitespace-only → no match');
}

// Normalization helpers (exported via _internal for whitebox verification)
console.log('\nNormalization helpers');
{
  const { normalizeExact, normalizeFuzzy, similarity } = _internal;
  assert(normalizeExact('  Foo Bar  ') === 'foo bar', 'exact: trim + lowercase + collapse');
  assert(
    normalizeFuzzy('Hideout 24-13 State Com #1H (PSHA) - 2211506') === 'hideout 24-13 state com 1h',
    'fuzzy: strips (PSHA) + trailing code + hash',
    JSON.stringify(normalizeFuzzy('Hideout 24-13 State Com #1H (PSHA) - 2211506'))
  );
  assert(similarity('abc', 'abc') === 1.0, 'similarity: identical → 1.0');
  assert(similarity('abc', 'abd') > 0.6, 'similarity: 1-edit in 3-char → high');
  assert(similarity('abc', 'xyz') === 0, 'similarity: completely different → 0');
}

// Tie-breaker policy
console.log('\nFuzzy tie-breaker — refuse near-ties');
{
  // Two wells with similar-enough names that the top candidate doesn't beat runner-up by 0.05
  const tieIndex: ResolverIndex = {
    wells: [
      { id: 'a', well_name: 'Alpha 1', api10: '0000000001', api14: '00000000010000', combocurve_well_id: 1 },
      { id: 'b', well_name: 'Alpha 2', api10: '0000000002', api14: '00000000020000', combocurve_well_id: 2 },
    ],
    aliases: [],
  };
  const r = resolveWellByName('Alpha X', tieIndex);
  // Both "Alpha 1" and "Alpha 2" are equidistant from "Alpha X" (1 edit).
  // Should refuse to pick.
  assert(r.matched === null, 'Near-tie → refuses to pick', r.matched ? `picked ${r.matched.id}` : '');
  assert(r.matched === null && r.reason.includes('ambiguous fuzzy'), 'Reason: ambiguous fuzzy');
}

// ─── Summary ──────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
