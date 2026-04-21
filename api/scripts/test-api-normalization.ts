/**
 * Unit test for apiNormalization.ts — the shared API10/API14 helpers.
 *
 * Specifically guards against the three historical bogus-API10 patterns
 * that contaminated the wells table before Task #54 Phase B cleanup:
 *   - "0042301413"  (8-digit Mewbourne API mangled by padStart)
 *   - "4230000000"  (empty/near-empty cell padded to all-trailing-zeros)
 *   - "4230140000"  (6-digit partial API padded to all-trailing-zeros)
 *
 * Run: pnpm tsx scripts/test-api-normalization.ts
 */

import {
  normalizeApi,
  isValidApi10,
  normalizeAndValidateApi,
} from '../src/parsers/apiNormalization.js';

interface Case {
  label: string;
  raw: string | number | null | undefined;
  expectApi10?: string;
  expectApi14?: string;
  expectValid?: boolean;
}

const cases: Case[] = [
  /* ─── Known-good inputs ─── */
  {
    label: '14-digit Anadarko API passes straight through',
    raw: '42301058190000',
    expectApi10: '4230105819',
    expectApi14: '42301058190000',
    expectValid: true,
  },
  {
    label: '10-digit Aftermath API right-pads to 14',
    raw: '4230136843',
    expectApi10: '4230136843',
    expectApi14: '42301368430000',
    expectValid: true,
  },
  {
    label: '12-digit ConocoPhillips API → first 10 + right-pad',
    raw: '423013587000',
    expectApi10: '4230135870',
    expectApi14: '42301358700000',
    expectValid: true,
  },
  {
    label: '8-digit Mewbourne Well Num → well segment zero-padded to 5',
    raw: '42301413',
    expectApi10: '4230100413',
    expectApi14: '42301004130000',
    expectValid: true,
  },
  {
    label: 'number input (Excel) — 14-digit integer',
    raw: 42301058190000,
    expectApi10: '4230105819',
    expectApi14: '42301058190000',
    expectValid: true,
  },
  {
    label: 'dashed 14-digit API is stripped',
    raw: '42-301-05819-00-00',
    expectApi10: '4230105819',
    expectApi14: '42301058190000',
    expectValid: true,
  },
  {
    label: 'Kansas 10-digit API with leading "15"',
    raw: '1507109999',
    expectApi10: '1507109999',
    expectApi14: '15071099990000',
    expectValid: true,
  },

  /* ─── The three historical bogus patterns ─── */
  {
    label: 'BOGUS #1: literal "4230000000" (well segment all zeros) rejected',
    raw: '4230000000',
    expectValid: false,
  },
  {
    label: 'BOGUS #2: literal "4230140000" (well segment all zeros after county 014) rejected',
    raw: '4230140000',
    expectValid: false,
  },
  {
    label: 'BOGUS #3: literal "0042301413" (state "00") rejected',
    raw: '0042301413',
    expectValid: false,
  },
  {
    label: 'number 4230000000 (Excel) rejected — zero well segment',
    raw: 4230000000,
    expectValid: false,
  },

  /* ─── Edge cases ─── */
  {
    label: 'empty string returns empty pair, invalid',
    raw: '',
    expectApi10: '',
    expectApi14: '',
    expectValid: false,
  },
  {
    label: 'null returns empty pair, invalid',
    raw: null,
    expectApi10: '',
    expectApi14: '',
    expectValid: false,
  },
  {
    label: 'too-short digit string (4 chars) rejected by validator',
    raw: '4230',
    expectValid: false,
  },
  {
    label: 'all-zeros 14-digit rejected',
    raw: '00000000000000',
    expectValid: false,
  },
  {
    label: 'invariant: api14.slice(0,10) === api10 for 8-digit input',
    raw: '42301413',
    // api14 should be 42301004130000, api10 should be 4230100413
    // api14.slice(0,10) = 4230100413 ✓
    expectApi10: '4230100413',
    expectApi14: '42301004130000',
    expectValid: true,
  },
];

let passed = 0;
let failed = 0;
const failures: string[] = [];

for (const c of cases) {
  const result = normalizeAndValidateApi(c.raw);
  const direct = normalizeApi(c.raw);
  const isValid = isValidApi10(direct.api10);

  const checks: Array<[string, unknown, unknown]> = [];
  if (c.expectApi10 !== undefined) checks.push(['api10', direct.api10, c.expectApi10]);
  if (c.expectApi14 !== undefined) checks.push(['api14', direct.api14, c.expectApi14]);
  if (c.expectValid !== undefined) {
    checks.push(['validated.valid', result.valid, c.expectValid]);
    // Also cross-check isValidApi10 directly
    checks.push(['isValidApi10', isValid, c.expectValid]);
  }

  // Invariant: valid → api14.slice(0,10) === api10
  if (result.valid && direct.api14.slice(0, 10) !== direct.api10) {
    checks.push([
      'invariant_api14_prefix',
      direct.api14.slice(0, 10),
      direct.api10,
    ]);
  }

  const failedChecks = checks.filter(([, actual, expected]) => actual !== expected);

  if (failedChecks.length === 0) {
    passed++;
    console.log(`✓ ${c.label}`);
  } else {
    failed++;
    const detail = failedChecks
      .map(([name, actual, expected]) => `${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
      .join('; ');
    const reason = result.reason ? ` (reason: "${result.reason}")` : '';
    const msg = `✗ ${c.label} → ${detail}${reason}`;
    console.log(msg);
    failures.push(msg);
  }
}

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) {
  console.error(`\nFailed cases:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
process.exit(0);
