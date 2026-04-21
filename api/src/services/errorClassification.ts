/**
 * Error Classification
 * --------------------
 * Task #62 (2026-04-21). The retry worker needs to know WHICH failures are
 * worth retrying and which are permanent.
 *
 * Policy (confirmed with Caleb):
 *   • TRANSIENT errors → retry. Network blips, Gmail/Supabase rate-limits,
 *     DB connection hiccups, timeouts, 5xx responses.
 *   • PARSE errors     → do NOT retry. A parser that fails today will fail
 *     tomorrow until the code changes. Re-running wastes compute and
 *     pollutes the dashboard with identical "failed" attempts.
 *
 * The classifier inspects a single error-message string (as already written
 * to `email_log.error_messages[]`) and returns `true` iff it smells
 * transient. Patterns are intentionally conservative — when in doubt, we
 * don't retry.
 *
 * Backoff schedule is also here so the retry worker and finalizer share
 * one source of truth.
 */

/**
 * Returns true if the given error message looks transient (worth retrying).
 *
 * Cases we DO retry:
 *   • Low-level network errors (ECONNRESET, ETIMEDOUT, ENOTFOUND, socket hang up)
 *   • Generic timeout/fetch-failure phrasings
 *   • HTTP 429 (rate limit) and 5xx responses
 *   • Supabase / Postgres connection-reset / pool-exhausted hints
 *   • Gmail API failures that read as service-side (5xx, backendError, rateLimitExceeded)
 *   • "Fatal: Failed to insert email_log row" style orchestration failures —
 *     these usually mean the DB was briefly unreachable
 *
 * Cases we DO NOT retry (classifier returns false):
 *   • "Parser error: ..."                         (deterministic parser bug)
 *   • "Unrecognized format — flagged for manual review" (new operator needs mapping)
 *   • "weekly data must be pre-divided..."        (parser contract violation)
 *   • Anything else we don't explicitly recognize as transient
 */
export function isTransientError(message: string): boolean {
  if (!message) return false;
  const m = message.toLowerCase();

  // Explicit hard-stop markers — these are NEVER transient, even if the
  // message also happens to contain a matching substring below.
  const PERMANENT_MARKERS = [
    'parser error:',
    'unrecognized format',
    'weekly data must be pre-divided',
    'parser returned datatype=',
  ];
  if (PERMANENT_MARKERS.some((p) => m.includes(p))) return false;

  const TRANSIENT_PATTERNS: RegExp[] = [
    // Low-level socket/DNS errors (Node built-in)
    /\beconnreset\b/,
    /\betimedout\b/,
    /\benotfound\b/,
    /\beconnrefused\b/,
    /\beai_again\b/,
    /socket hang up/,

    // Generic phrasings
    /\btimeout\b/,
    /timed out/,
    /network (?:error|failure|is unreachable)/,
    /fetch failed/,
    /request failed with/,
    /temporarily unavailable/,
    /service unavailable/,
    /connection (?:terminated|reset|closed|aborted|refused|lost)/,
    /could not connect/,
    /dns lookup/,

    // HTTP-ish shapes
    /\b429\b/,
    /\b500\b/,
    /\b502\b/,
    /\b503\b/,
    /\b504\b/,
    /status (?:429|5\d\d)/,
    /http (?:429|5\d\d)/,
    /rate limit/,
    /too many requests/,
    /quota exceeded/,
    /quota\s*err(?:or)?/,

    // Postgres / Supabase hints
    /\bpool (?:exhausted|timeout|closed)\b/,
    /server closed the connection/,
    /remaining connection slots/,
    /canceling statement due to/,
    /supabase .* timeout/,
    /supabase storage upload failed/, // almost always a transient 5xx

    // Gmail API hints
    /backend ?error/,
    /rate ?limit ?exceeded/,
    /user ?rate ?limit ?exceeded/,
    /gmail api (?:error|request failed)/,

    // The outer processMessage() catch prefixes with "Fatal:". These are
    // almost always orchestration (Gmail fetch, DB insert, Supabase upload)
    // failures, not parser bugs — those are caught per-attachment and
    // tagged "Parser error:". Treat Fatal as transient by default.
    /^fatal:/,
    /\] fatal:/,
  ];

  return TRANSIENT_PATTERNS.some((re) => re.test(m));
}

/**
 * Returns true if ANY element in the errors array looks transient.
 *
 * Semantics: a partial/failed run is retry-eligible if at least one of its
 * errors is transient. The re-run will re-execute every attachment — the
 * parse errors will fail again identically, but the transient ones may
 * succeed, moving the row from 'failed' → 'partial' or 'partial' → 'completed'.
 *
 * (In practice most real-world cases have EITHER all-transient or
 * all-parse-errors, not both, so this simple rule works fine.)
 */
export function hasTransientError(errors: readonly string[]): boolean {
  return errors.some(isTransientError);
}

/**
 * Backoff schedule — minutes between retries, indexed by the UPCOMING
 * attempt number (1 = "this is the first retry", etc.). Everything past
 * the end uses the final value.
 *
 * Chosen shape:
 *   Retry 1 → 5 min   (catch quick blips fast)
 *   Retry 2 → 30 min  (let rate-limits clear)
 *   Retry 3 → 2 hrs   (intermittent service issue)
 *   Retry 4 → 6 hrs
 *   Retry 5 → 12 hrs  (final attempt)
 * Total window: ~20.6 hours across 5 attempts. After that we mark
 * is_retryable=false and surface the email for manual investigation.
 */
export const BACKOFF_MINUTES: readonly number[] = [5, 30, 120, 360, 720];
export const DEFAULT_MAX_RETRIES = 5;

/** Returns the number of minutes to wait before retry attempt N (1-indexed). */
export function computeBackoffMinutes(upcomingAttemptNumber: number): number {
  if (upcomingAttemptNumber < 1) return BACKOFF_MINUTES[0];
  const idx = Math.min(upcomingAttemptNumber - 1, BACKOFF_MINUTES.length - 1);
  return BACKOFF_MINUTES[idx];
}

/**
 * Represents the retry-state decision after a processing run finishes.
 * Consumed by finalizeEmailLog to update email_log's retry columns.
 */
export interface RetryState {
  is_retryable: boolean;
  next_retry_at: string | null;
  last_retry_outcome: 'success' | 'transient_failure' | 'permanent_failure' | 'exhausted' | null;
}

/**
 * Given the current run's status + errors + how many retries have already
 * fired, decide what the retry-state columns should be set to.
 *
 * `retryCountSoFar` is the DB value BEFORE this run contributes. If this
 * run was triggered by the retry worker, the worker has already incremented
 * retry_count atomically, so the value passed here INCLUDES the current
 * attempt (e.g. retryCountSoFar=1 after the first retry completes).
 */
export function computeRetryState(
  status: 'completed' | 'partial' | 'failed' | 'skipped' | 'ignored',
  errors: readonly string[],
  retryCountSoFar: number,
  maxRetries: number = DEFAULT_MAX_RETRIES
): RetryState {
  // Success / clean-no-action paths — not retryable, clear next_retry_at.
  if (status === 'completed' || status === 'ignored') {
    return {
      is_retryable: false,
      next_retry_at: null,
      // 'success' only makes sense if this was reached via a retry path.
      // For initial successful runs, finalizer passes retryCountSoFar=0 and
      // we still mark 'success' — it's harmless and future dashboards can
      // use it to count "clean on first try" vs "rescued by retry".
      last_retry_outcome: retryCountSoFar > 0 ? 'success' : null,
    };
  }

  // 'skipped' = no attachments found. Not retryable.
  if (status === 'skipped') {
    return { is_retryable: false, next_retry_at: null, last_retry_outcome: null };
  }

  // status is 'partial' or 'failed' below.
  const hasTransient = hasTransientError(errors);

  // No transient error → permanent (parser bug / unknown format). Don't retry.
  if (!hasTransient) {
    return {
      is_retryable: false,
      next_retry_at: null,
      last_retry_outcome: 'permanent_failure',
    };
  }

  // Exhausted budget → stop retrying, mark for manual attention.
  if (retryCountSoFar >= maxRetries) {
    return {
      is_retryable: false,
      next_retry_at: null,
      last_retry_outcome: 'exhausted',
    };
  }

  // Schedule the next retry.
  const upcoming = retryCountSoFar + 1;
  const minutes = computeBackoffMinutes(upcoming);
  const next = new Date(Date.now() + minutes * 60_000).toISOString();
  return {
    is_retryable: true,
    next_retry_at: next,
    last_retry_outcome: 'transient_failure',
  };
}
