/**
 * Admin Route Handlers
 * ---------------------
 * Operational tools for Caleb (and future support). None of these are
 * routinely called by the UI's normal flows — they exist so we can
 * recover from failures without manually poking the database.
 *
 * Endpoints:
 *
 *   POST /api/admin/reprocess-email
 *     Body: { emailLogId?: string } | { gmailMessageId?: string }
 *     Re-runs processMessage() for a single email by either our internal
 *     email_log UUID or the underlying Gmail message id. Returns the
 *     updated email_log row so the caller can see the new status.
 *
 *     Idempotency contract (already guaranteed by the pipeline):
 *       • createEmailLogRow catches the unique-constraint conflict on
 *         gmail_message_id and returns the existing row id, so the same
 *         log row is UPDATEd in place.
 *       • Storage upload uses upsert:true.
 *       • storeMonthlyRecords / storeDailyRecords upsert on
 *         (well_id, prod_date) — no duplicate rows.
 *       • Parsed records are safe to re-insert.
 *
 *   POST /api/admin/reprocess-failed
 *     Body: { statuses?: string[], limit?: number }
 *       statuses defaults to ['failed']. Accepts any subset of
 *         ['failed', 'partial', 'skipped', 'ignored', 'completed'].
 *       limit defaults to 50 — a safety rail so an accidental click
 *         doesn't re-run thousands of messages at once.
 *
 *     Finds email_log rows matching those statuses (most recent first)
 *     and replays each via processMessage(). Returns a per-row summary
 *     of old → new status so we can see at a glance which ones recovered.
 *
 * WHY this exists:
 * ------------------
 * We got burned by a deploy-timing race: the email poller processed
 * messages BEFORE a parser fix shipped, then Railway redeployed with
 * the fix — but those messages had already been marked read and flagged
 * 'failed'. Without this endpoint, the only recovery path was to ask
 * the senders to re-forward each email (impractical). This endpoint
 * lets us click "reprocess" and have the pipeline re-run against the
 * current (fixed) code path.
 *
 * NOTE on auth: like the rest of /api/*, this is currently unauthenticated
 * at the route level. The frontend gates access via Supabase Auth, and
 * the API itself is protected by Railway's project-level access controls.
 * When we add JWT middleware later, it will apply uniformly.
 */

import { Router, type Request, type Response } from 'express';
import { supabase } from '../services/supabase.js';
import { processMessage } from '../services/emailPoller.js';
import { runRetryNow, runRetryPass, listDueRetries } from '../services/retryWorker.js';

const router = Router();

/* ────────────────────────────────────────────────────────────────
 * Small helper: fetch the email_log row so the response shows the
 * caller what actually changed. Returns null if the row doesn't
 * exist (e.g. was manually deleted after the reprocess call).
 * ──────────────────────────────────────────────────────────────── */
interface EmailLogSummary {
  id: string;
  gmail_message_id: string;
  sender: string | null;
  subject: string | null;
  received_at: string | null;
  status: string;
  attachments_found: number | null;
  attachments_processed: number | null;
  error_messages: string[] | null;
  processing_started_at: string | null;
  processing_completed_at: string | null;
}

async function fetchLogRow(gmailMessageId: string): Promise<EmailLogSummary | null> {
  const { data, error } = await supabase
    .from('email_log')
    .select(
      'id, gmail_message_id, sender, subject, received_at, status, ' +
        'attachments_found, attachments_processed, error_messages, ' +
        'processing_started_at, processing_completed_at'
    )
    .eq('gmail_message_id', gmailMessageId)
    .single();
  if (error) return null;
  return (data ?? null) as unknown as EmailLogSummary | null;
}

/* ────────────────────────────────────────────────────────────────
 * POST /api/admin/reprocess-email
 *
 * Accepts EITHER emailLogId (our UUID) or gmailMessageId (Gmail's id).
 * Most dashboard flows will pass emailLogId since that's what the UI
 * has in hand; the Gmail id path is a back-stop in case the log row
 * was manually deleted.
 * ──────────────────────────────────────────────────────────────── */
router.post('/reprocess-email', async (req: Request, res: Response) => {
  const { emailLogId, gmailMessageId } = req.body || {};

  if (!emailLogId && !gmailMessageId) {
    return res.status(400).json({
      ok: false,
      error:
        'Missing identifier. Provide either "emailLogId" (our UUID from the email_log table) or "gmailMessageId" (the underlying Gmail message id).',
    });
  }

  // Resolve to a Gmail message id — that's what processMessage() needs.
  let resolvedGmailId: string | null = null;

  if (gmailMessageId) {
    resolvedGmailId = String(gmailMessageId);
  } else {
    const { data, error } = await supabase
      .from('email_log')
      .select('gmail_message_id')
      .eq('id', emailLogId)
      .single();
    if (error || !data) {
      return res.status(404).json({
        ok: false,
        error: `No email_log row found for id="${emailLogId}".`,
      });
    }
    resolvedGmailId = data.gmail_message_id;
  }

  if (!resolvedGmailId) {
    return res.status(500).json({
      ok: false,
      error: 'Could not resolve a Gmail message id to reprocess.',
    });
  }

  const before = await fetchLogRow(resolvedGmailId);

  try {
    await processMessage(resolvedGmailId);
  } catch (err) {
    // processMessage() is already defensive and writes failures to
    // email_log — but if it somehow throws, surface it to the caller.
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({
      ok: false,
      error: `processMessage threw: ${msg}`,
      gmailMessageId: resolvedGmailId,
      before,
    });
  }

  const after = await fetchLogRow(resolvedGmailId);

  return res.json({
    ok: true,
    gmailMessageId: resolvedGmailId,
    before: before && {
      status: before.status,
      attachmentsProcessed: before.attachments_processed,
      errorMessages: before.error_messages,
    },
    after,
  });
});

/* ────────────────────────────────────────────────────────────────
 * POST /api/admin/reprocess-failed
 *
 * Bulk-replay. Use cases:
 *   • Recover from a deploy-timing race (ship a parser fix, then
 *     replay the emails that failed against the old code).
 *   • Recover from a transient Supabase/Gmail hiccup.
 *
 * Safety rails:
 *   • Hard cap of 200 per call. Default 50. If you want more, call
 *     it multiple times (the oldest-first ordering means successive
 *     calls keep draining the queue).
 *   • Only non-'completed' statuses allowed by default — passing
 *     'completed' requires an explicit opt-in flag to prevent
 *     accidentally re-running thousands of good rows.
 * ──────────────────────────────────────────────────────────────── */
router.post('/reprocess-failed', async (req: Request, res: Response) => {
  const body = req.body || {};
  const rawStatuses: unknown = body.statuses;
  const rawLimit: unknown = body.limit;
  const allowCompleted = body.allowCompleted === true;

  // Validate statuses
  const ALLOWED = new Set([
    'failed',
    'partial',
    'skipped',
    'ignored',
    'processing',
    'completed',
  ]);
  let statuses: string[] = ['failed'];
  if (Array.isArray(rawStatuses) && rawStatuses.length > 0) {
    statuses = rawStatuses.map(String);
    for (const s of statuses) {
      if (!ALLOWED.has(s)) {
        return res.status(400).json({
          ok: false,
          error: `Unknown status "${s}". Allowed: ${[...ALLOWED].join(', ')}.`,
        });
      }
    }
    if (statuses.includes('completed') && !allowCompleted) {
      return res.status(400).json({
        ok: false,
        error:
          'Reprocessing "completed" rows requires "allowCompleted": true — this is an intentional speed bump to prevent accidental mass re-runs.',
      });
    }
  }

  // Validate limit — default 50, hard cap 200.
  let limit = 50;
  if (rawLimit !== undefined) {
    const n = Number(rawLimit);
    if (!Number.isFinite(n) || n < 1) {
      return res
        .status(400)
        .json({ ok: false, error: `Invalid limit "${rawLimit}" — must be a positive integer.` });
    }
    limit = Math.min(Math.floor(n), 200);
  }

  // Pull the candidate rows. Oldest-first so successive calls drain the backlog
  // predictably (and so a reprocess of a large batch doesn't flap newer ones).
  const { data: rows, error } = await supabase
    .from('email_log')
    .select('id, gmail_message_id, status, sender, subject, received_at')
    .in('status', statuses)
    .order('received_at', { ascending: true })
    .limit(limit);

  if (error) {
    return res.status(500).json({ ok: false, error: `Query failed: ${error.message}` });
  }
  if (!rows || rows.length === 0) {
    return res.json({
      ok: true,
      matched: 0,
      summary: [],
      note: `No email_log rows with status in [${statuses.join(', ')}].`,
    });
  }

  // Run them sequentially so we don't slam Gmail/Supabase rate limits.
  // Each processMessage() is self-contained and writes its own log row.
  const summary: Array<{
    id: string;
    gmailMessageId: string;
    subject: string;
    oldStatus: string;
    newStatus: string;
    recovered: boolean;
    note?: string;
  }> = [];

  for (const row of rows) {
    const oldStatus = row.status as string;
    try {
      await processMessage(row.gmail_message_id);
      const after = await fetchLogRow(row.gmail_message_id);
      const newStatus = (after?.status as string) || 'unknown';
      summary.push({
        id: row.id,
        gmailMessageId: row.gmail_message_id,
        subject: row.subject || '(no subject)',
        oldStatus,
        newStatus,
        // "Recovered" = moved from a bad state to a good state.
        recovered:
          (oldStatus === 'failed' || oldStatus === 'partial' || oldStatus === 'processing') &&
          (newStatus === 'completed' || newStatus === 'ignored'),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      summary.push({
        id: row.id,
        gmailMessageId: row.gmail_message_id,
        subject: row.subject || '(no subject)',
        oldStatus,
        newStatus: 'threw',
        recovered: false,
        note: msg,
      });
    }
  }

  const recoveredCount = summary.filter((s) => s.recovered).length;
  return res.json({
    ok: true,
    matched: rows.length,
    recovered: recoveredCount,
    stillBroken: summary.length - recoveredCount,
    summary,
  });
});

/* ────────────────────────────────────────────────────────────────
 * POST /api/admin/retry-now
 *
 * Task #62 — manual retry trigger. The dashboard's "Retry Now"
 * button POSTs here with { emailLogId } to re-run a single email
 * immediately, bypassing the next_retry_at cooldown window.
 *
 * Respects retry_count < max_retries (can't override the budget),
 * and atomically claims the retry slot the same way the cron does,
 * so a user clicking the button at :06:59 doesn't collide with the
 * :07 cron.
 *
 * On success returns the updated email_log row + the new attempt
 * count, so the UI can immediately reflect what changed.
 * ──────────────────────────────────────────────────────────────── */
router.post('/retry-now', async (req: Request, res: Response) => {
  const { emailLogId } = req.body || {};
  if (!emailLogId || typeof emailLogId !== 'string') {
    return res.status(400).json({
      ok: false,
      error: 'Missing "emailLogId" in request body.',
    });
  }

  // Capture "before" state so the UI can show a diff if it wants.
  const { data: beforeRow } = await supabase
    .from('email_log')
    .select(
      'id, gmail_message_id, status, retry_count, max_retries, is_retryable, last_retry_outcome, next_retry_at'
    )
    .eq('id', emailLogId)
    .single();

  try {
    const result = await runRetryNow(emailLogId);

    // Fetch the post-retry state by email_log id (not gmail id — that
    // way the UI's row-level update doesn't depend on the gmail lookup).
    const { data: afterRow } = await supabase
      .from('email_log')
      .select(
        'id, gmail_message_id, sender, subject, received_at, status, ' +
          'attachments_found, attachments_processed, error_messages, ' +
          'processing_started_at, processing_completed_at, ' +
          'retry_count, max_retries, is_retryable, last_retry_outcome, ' +
          'next_retry_at, last_retry_at'
      )
      .eq('id', emailLogId)
      .single();

    return res.json({
      ok: true,
      attempted: result.attempted,
      maxRetries: result.maxRetries,
      before: beforeRow
        ? {
            status: beforeRow.status,
            retryCount: beforeRow.retry_count,
            lastOutcome: beforeRow.last_retry_outcome,
          }
        : null,
      after: afterRow,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 400 because the typical "error" here is "exhausted retries" or
    // "missing gmail_message_id" — caller-side data problems, not 5xx.
    return res.status(400).json({
      ok: false,
      error: msg,
      emailLogId,
    });
  }
});

/* ────────────────────────────────────────────────────────────────
 * POST /api/admin/retry-pass
 *
 * Task #62 — operator hook to kick the retry worker on demand.
 * Same as what the 15-minute cron does, but we can call it during
 * debugging or after a deploy that fixed a transient-error cause.
 *
 * Body: { max?: number }  // default 10, hard cap 50
 * ──────────────────────────────────────────────────────────────── */
router.post('/retry-pass', async (req: Request, res: Response) => {
  const raw = req.body?.max;
  let max = 10;
  if (raw !== undefined) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1) {
      return res
        .status(400)
        .json({ ok: false, error: `Invalid max "${raw}" — must be a positive integer.` });
    }
    max = Math.min(Math.floor(n), 50);
  }
  try {
    const result = await runRetryPass(max);
    return res.json({ ok: true, max, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ ok: false, error: `runRetryPass threw: ${msg}` });
  }
});

/* ────────────────────────────────────────────────────────────────
 * GET /api/admin/retries-due
 *
 * Task #62 — read-only peek at the retry queue. Useful for
 * "why hasn't this retried yet?" debugging.
 * ──────────────────────────────────────────────────────────────── */
router.get('/retries-due', async (req: Request, res: Response) => {
  const raw = req.query.limit;
  let limit = 50;
  if (raw !== undefined) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1) {
      return res
        .status(400)
        .json({ ok: false, error: `Invalid limit "${raw}" — must be a positive integer.` });
    }
    limit = Math.min(Math.floor(n), 200);
  }
  try {
    const rows = await listDueRetries(limit);
    return res.json({ ok: true, count: rows.length, rows });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ ok: false, error: `listDueRetries threw: ${msg}` });
  }
});

export default router;
