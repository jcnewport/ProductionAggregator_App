/**
 * Retry Worker
 * ------------
 * Task #62 (2026-04-21). Every 15 minutes, wakes up, finds email_log rows
 * that are due for retry, claims them atomically, and re-runs processMessage()
 * for each.
 *
 * Due-for-retry is defined by:
 *   • is_retryable = true
 *   • next_retry_at <= NOW()
 *   • retry_count < max_retries
 *   • gmail_message_id IS NOT NULL (we need it to call processMessage)
 *
 * Claim protocol — to avoid two workers (or the cron + an admin click)
 * re-running the same email twice:
 *   UPDATE email_log
 *   SET retry_count = retry_count + 1,
 *       last_retry_at = NOW(),
 *       is_retryable = false,       -- finalize will re-set this if needed
 *       next_retry_at = NULL        -- will be re-computed by finalize
 *   WHERE id = :id
 *     AND is_retryable = true
 *     AND next_retry_at <= NOW()
 *     AND retry_count < max_retries
 *   RETURNING id, gmail_message_id, retry_count;
 *
 * If the UPDATE returns a row, we own this retry slot. We call
 * processMessage(gmail_message_id), which eventually calls finalizeEmailLog —
 * which reads the (now-incremented) retry_count and recomputes is_retryable /
 * next_retry_at / last_retry_outcome per the policy in errorClassification.ts.
 *
 * If the UPDATE returns NO row, another worker got it first or the row's
 * state changed between our SELECT and UPDATE. Skip silently.
 *
 * Manual "Retry Now" click: uses a different atomic claim that doesn't
 * require next_retry_at <= NOW() — see runRetryNow() below.
 */

import cron from 'node-cron';
import { supabase } from './supabase.js';
import { processMessage } from './emailPoller.js';

/** Column-set we need back from email_log when claiming or enumerating. */
const CLAIM_RETURN_COLS = 'id, gmail_message_id, retry_count, max_retries, subject, sender';

interface ClaimedRow {
  id: string;
  gmail_message_id: string | null;
  retry_count: number;
  max_retries: number;
  subject: string | null;
  sender: string | null;
}

/**
 * Returns the email_log rows currently eligible for retry. Useful for
 * dashboards / debug endpoints. This is a READ — it does not claim anything.
 */
export async function listDueRetries(limit = 50): Promise<ClaimedRow[]> {
  const { data, error } = await supabase
    .from('email_log')
    .select(CLAIM_RETURN_COLS)
    .eq('is_retryable', true)
    .lte('next_retry_at', new Date().toISOString())
    .order('next_retry_at', { ascending: true })
    .limit(limit);

  if (error) {
    console.error('[retryWorker] listDueRetries failed:', error.message);
    return [];
  }
  return (data ?? []) as ClaimedRow[];
}

/**
 * Atomically claim a single row for retry. Returns the claimed row, or null
 * if nothing is due / another worker got it / the row's state changed.
 *
 * The claim mutates: retry_count += 1, is_retryable=false (finalize will
 * flip back on if the retry fails transiently), next_retry_at=null.
 */
async function claimOne(): Promise<ClaimedRow | null> {
  // Supabase-js doesn't expose a WHERE-clause RETURNING in a single call
  // against arbitrary predicates, but .update().eq().select() does return
  // the updated rows. We use a guarded two-step that is still race-safe:
  //
  //   1. SELECT one due row (ordered by next_retry_at ASC) to get a candidate id.
  //   2. UPDATE ... WHERE id = :id AND is_retryable = true AND retry_count < max_retries
  //      → returns the row if WE won the race, empty array if someone else did.
  //
  // This is race-safe because only the UPDATE with is_retryable=true in the
  // predicate can "win" the slot — any second caller sees is_retryable=false
  // and gets nothing back.

  // Step 1: pick a candidate
  const { data: candidates, error: selErr } = await supabase
    .from('email_log')
    .select(CLAIM_RETURN_COLS)
    .eq('is_retryable', true)
    .lte('next_retry_at', new Date().toISOString())
    .order('next_retry_at', { ascending: true })
    .limit(1);

  if (selErr) {
    console.error('[retryWorker] claim select failed:', selErr.message);
    return null;
  }
  if (!candidates || candidates.length === 0) return null;

  const candidate = candidates[0] as ClaimedRow;
  if (candidate.retry_count >= candidate.max_retries) {
    // Shouldn't happen if finalize did its job, but defend anyway.
    await supabase
      .from('email_log')
      .update({
        is_retryable: false,
        next_retry_at: null,
        last_retry_outcome: 'exhausted',
      })
      .eq('id', candidate.id);
    return null;
  }

  // Step 2: atomic claim-by-update
  const { data: claimed, error: updErr } = await supabase
    .from('email_log')
    .update({
      retry_count: candidate.retry_count + 1,
      last_retry_at: new Date().toISOString(),
      is_retryable: false,
      next_retry_at: null,
    })
    .eq('id', candidate.id)
    .eq('is_retryable', true) // race guard
    .select(CLAIM_RETURN_COLS)
    .single();

  if (updErr) {
    // PGRST116 = no rows returned (= another worker claimed first). Quiet.
    if ((updErr as { code?: string }).code !== 'PGRST116') {
      console.error('[retryWorker] claim update failed:', updErr.message);
    }
    return null;
  }
  return claimed as ClaimedRow;
}

/**
 * Run one retry pass — claim and re-run up to `maxPerPass` emails.
 * Called by the 15-minute cron AND by the admin endpoint.
 */
export async function runRetryPass(maxPerPass = 10): Promise<{
  claimed: number;
  succeeded: number;
  failed: number;
}> {
  let claimed = 0;
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < maxPerPass; i++) {
    const row = await claimOne();
    if (!row) break; // queue drained (or nothing due)
    claimed++;

    if (!row.gmail_message_id) {
      console.warn(
        `[retryWorker] email_log ${row.id} has no gmail_message_id; skipping retry`
      );
      continue;
    }

    console.log(
      `[retryWorker] Retry attempt ${row.retry_count}/${row.max_retries} for email ` +
        `${row.id} (gmail ${row.gmail_message_id}) — "${row.subject ?? '—'}" from ${row.sender ?? '—'}`
    );

    try {
      await processMessage(row.gmail_message_id);
      succeeded++;
    } catch (err) {
      failed++;
      console.error(
        `[retryWorker] processMessage threw on retry of ${row.id}: ${
          (err as Error).message
        }`
      );
      // processMessage catches its own errors and writes them to email_log,
      // so landing in THIS catch means something above the message-processing
      // layer blew up (e.g. an unexpected import error). Finalize didn't run,
      // so we need to manually re-arm the retry window to avoid the row
      // getting permanently stuck with is_retryable=false.
      try {
        // Re-arm with a 30-min cooldown so an unrecoverable bug doesn't
        // hammer the cron.
        await supabase
          .from('email_log')
          .update({
            is_retryable: row.retry_count < row.max_retries,
            next_retry_at:
              row.retry_count < row.max_retries
                ? new Date(Date.now() + 30 * 60_000).toISOString()
                : null,
            last_retry_outcome:
              row.retry_count < row.max_retries ? 'transient_failure' : 'exhausted',
          })
          .eq('id', row.id);
      } catch (reArmErr) {
        console.error(
          `[retryWorker] Failed to re-arm retry state for ${row.id}:`,
          (reArmErr as Error).message
        );
      }
    }
  }

  if (claimed > 0) {
    console.log(
      `[retryWorker] Pass complete — claimed=${claimed} succeeded=${succeeded} failed=${failed}`
    );
  }
  return { claimed, succeeded, failed };
}

/**
 * Admin "Retry Now" path. Bypasses the next_retry_at gate but still
 * respects retry_count <= max_retries. Mutates the row the same way
 * the cron claim does so the attempt counter stays honest.
 *
 * Returns the updated retry_count, or throws if the row isn't eligible.
 */
export async function runRetryNow(emailLogId: string): Promise<{
  attempted: number;
  maxRetries: number;
}> {
  // Fetch current bookkeeping
  const { data: row, error: selErr } = await supabase
    .from('email_log')
    .select('id, gmail_message_id, retry_count, max_retries, status, is_retryable')
    .eq('id', emailLogId)
    .single();

  if (selErr || !row) {
    throw new Error(`email_log ${emailLogId} not found`);
  }
  if (!row.gmail_message_id) {
    throw new Error(`email_log ${emailLogId} has no gmail_message_id`);
  }
  if (row.retry_count >= row.max_retries) {
    throw new Error(
      `email_log ${emailLogId} has exhausted retries ` +
        `(${row.retry_count}/${row.max_retries})`
    );
  }

  // Claim — increment retry_count and mark in-flight
  const { error: updErr } = await supabase
    .from('email_log')
    .update({
      retry_count: row.retry_count + 1,
      last_retry_at: new Date().toISOString(),
      is_retryable: false,
      next_retry_at: null,
    })
    .eq('id', row.id)
    .lt('retry_count', row.max_retries); // guard against a racing cron claim

  if (updErr) {
    throw new Error(`Failed to claim retry slot: ${updErr.message}`);
  }

  // Actually re-run. processMessage catches internal errors and records
  // them in email_log; finalize will set new is_retryable / next_retry_at.
  await processMessage(row.gmail_message_id);

  return {
    attempted: row.retry_count + 1,
    maxRetries: row.max_retries,
  };
}

/**
 * Start the retry-worker cron. Called once from src/index.ts on boot,
 * alongside startEmailPollerCron().
 *
 * Schedule: every 15 minutes, offset 7 from the poller so they don't
 * stomp on the same Gmail quota window. (Poller runs at :00/:15/:30/:45;
 * retry worker runs at :07/:22/:37/:52.)
 */
export function startRetryWorkerCron(): void {
  console.log('[retryWorker] Starting cron — every 15 minutes (offset :07)');
  cron.schedule('7,22,37,52 * * * *', async () => {
    try {
      await runRetryPass();
    } catch (err) {
      console.error('[retryWorker] Retry pass failed:', (err as Error).message);
    }
  });
}
