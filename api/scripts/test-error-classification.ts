/**
 * Unit tests for errorClassification.ts (Task #62).
 *
 * Covers:
 *   • isTransientError — network/5xx/timeout shapes return true;
 *     parser/unrecognized-format shapes return false; permanent markers
 *     win even when a transient-looking substring is also present.
 *   • hasTransientError — OR across an error array.
 *   • computeBackoffMinutes — indexing and tail clamping.
 *   • computeRetryState — every branch:
 *       completed     → not retryable
 *       ignored       → not retryable
 *       skipped       → not retryable
 *       partial/failed + permanent error   → not retryable, outcome='permanent_failure'
 *       partial/failed + transient + room  → retryable with next_retry_at
 *       partial/failed + transient + no room → exhausted
 *
 * Run: npx tsx scripts/test-error-classification.ts
 * No database access needed.
 */

import {
  isTransientError,
  hasTransientError,
  computeBackoffMinutes,
  computeRetryState,
  BACKOFF_MINUTES,
  DEFAULT_MAX_RETRIES,
} from '../src/services/errorClassification.js';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function expect(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`[PASS] ${name}`);
  } else {
    fail++;
    const msg = `[FAIL] ${name}${detail ? ' — ' + detail : ''}`;
    failures.push(msg);
    console.log(msg);
  }
}

/* ── isTransientError ─────────────────────────────────────────── */
console.log('\n── isTransientError ──');

const TRANSIENT_SAMPLES = [
  'ECONNRESET',
  'socket hang up',
  'Request timed out after 30000ms',
  'fetch failed',
  'HTTP 502 Bad Gateway',
  'status 503 Service Unavailable',
  'Too Many Requests (rate limit exceeded)',
  'Gmail API: backendError',
  'Supabase storage upload failed: 502 Bad Gateway',
  'Fatal: Failed to insert email_log row: connection terminated',
  'pool exhausted',
  'server closed the connection unexpectedly',
  'ETIMEDOUT',
  'ENOTFOUND accounts.google.com',
  'EAI_AGAIN',
];
for (const msg of TRANSIENT_SAMPLES) {
  expect(`transient: "${msg.slice(0, 40)}"`, isTransientError(msg));
}

const PERMANENT_SAMPLES = [
  'Parser error: Expected header row at line 1',
  'Unrecognized format — flagged for manual review',
  'Weekly data must be pre-divided by the parser',
  'Parser returned dataType=unknown',
  // Plain parse bugs with no transient keyword
  "Cannot read properties of undefined (reading 'split')",
];
for (const msg of PERMANENT_SAMPLES) {
  expect(`permanent: "${msg.slice(0, 40)}"`, !isTransientError(msg));
}

// Permanent markers must WIN over transient substrings
expect(
  'permanent marker overrides transient substring',
  !isTransientError('Parser error: fetch failed while reading PDF')
);

/* ── hasTransientError ────────────────────────────────────────── */
console.log('\n── hasTransientError ──');

expect('mixed array with one transient → true', hasTransientError([
  'Parser error: bad column',
  'ECONNRESET during upload',
]));
expect('all-permanent array → false', !hasTransientError([
  'Parser error: bad column',
  'Unrecognized format — flagged',
]));
expect('empty array → false', !hasTransientError([]));

/* ── computeBackoffMinutes ────────────────────────────────────── */
console.log('\n── computeBackoffMinutes ──');

expect('attempt 1 → 5 min', computeBackoffMinutes(1) === BACKOFF_MINUTES[0]);
expect('attempt 2 → 30 min', computeBackoffMinutes(2) === BACKOFF_MINUTES[1]);
expect('attempt 5 → 720 min', computeBackoffMinutes(5) === BACKOFF_MINUTES[4]);
expect('attempt 99 clamps to tail', computeBackoffMinutes(99) === BACKOFF_MINUTES[BACKOFF_MINUTES.length - 1]);
expect('attempt 0 clamps to head', computeBackoffMinutes(0) === BACKOFF_MINUTES[0]);
expect('attempt -3 clamps to head', computeBackoffMinutes(-3) === BACKOFF_MINUTES[0]);

/* ── computeRetryState ────────────────────────────────────────── */
console.log('\n── computeRetryState ──');

// completed → never retryable
{
  const s = computeRetryState('completed', [], 0);
  expect(
    'completed with retryCount=0 → not retryable, no outcome',
    !s.is_retryable && s.next_retry_at === null && s.last_retry_outcome === null
  );
}
{
  const s = computeRetryState('completed', [], 2);
  expect(
    'completed after previous retries → outcome=success',
    !s.is_retryable && s.last_retry_outcome === 'success'
  );
}

// ignored → quiet success
{
  const s = computeRetryState('ignored', [], 0);
  expect('ignored → not retryable', !s.is_retryable && s.next_retry_at === null);
}

// skipped → not retryable
{
  const s = computeRetryState('skipped', [], 0);
  expect('skipped → not retryable', !s.is_retryable && s.last_retry_outcome === null);
}

// failed + only parser errors → permanent, not retryable
{
  const s = computeRetryState(
    'failed',
    ['Parser error: bad column', 'Unrecognized format — flagged'],
    0
  );
  expect(
    'failed + parser errors → permanent_failure, not retryable',
    !s.is_retryable && s.last_retry_outcome === 'permanent_failure'
  );
}

// partial + transient + budget remaining → retryable with future next_retry_at
{
  const s = computeRetryState(
    'partial',
    ['Parser error: bad column', 'ECONNRESET while downloading'],
    0
  );
  expect('partial + transient → is_retryable=true', s.is_retryable === true);
  expect(
    'partial + transient → last_retry_outcome=transient_failure',
    s.last_retry_outcome === 'transient_failure'
  );
  expect(
    'partial + transient → next_retry_at in the future',
    !!s.next_retry_at && new Date(s.next_retry_at).getTime() > Date.now()
  );
  // Should be ~5 min ahead (first-retry backoff) — allow a wide tolerance
  const minsAhead =
    (new Date(s.next_retry_at!).getTime() - Date.now()) / 60_000;
  expect(
    `first-retry backoff ≈ ${BACKOFF_MINUTES[0]} min (got ${minsAhead.toFixed(1)})`,
    Math.abs(minsAhead - BACKOFF_MINUTES[0]) < 1
  );
}

// failed + transient + budget exhausted → 'exhausted', not retryable
{
  const s = computeRetryState(
    'failed',
    ['ETIMEDOUT'],
    DEFAULT_MAX_RETRIES // caller has already exhausted
  );
  expect(
    'exhausted budget → last_retry_outcome=exhausted, not retryable',
    !s.is_retryable && s.last_retry_outcome === 'exhausted'
  );
}

// failed + transient + last attempt before exhaustion → still retryable
{
  const s = computeRetryState(
    'failed',
    ['fetch failed'],
    DEFAULT_MAX_RETRIES - 1
  );
  expect(
    'one attempt remaining → still retryable',
    s.is_retryable === true && s.last_retry_outcome === 'transient_failure'
  );
}

/* ── Summary ──────────────────────────────────────────────────── */
console.log(`\n── Summary: ${pass} passed, ${fail} failed ──`);
if (fail > 0) {
  for (const f of failures) console.log(f);
  process.exit(1);
}
