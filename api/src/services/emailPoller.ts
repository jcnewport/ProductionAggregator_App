/**
 * Email Poller Service
 * ---------------------
 * Every 15 minutes:
 *   1. List unread messages-with-attachments in S.IS_AD_Prod@stewardship.is
 *   2. For each message:
 *      a. Create an email_log row (status=processing)
 *      b. Download each attachment → upload to Supabase Storage
 *      c. Dispatch to the right parser based on format signature
 *      d. Write parsed rows to production_monthly (or production_daily)
 *      e. Update email_log status (completed / partial / failed / skipped)
 *      f. Mark the Gmail message as read
 *
 * Failure is isolated per message: one bad email never blocks others.
 */

import cron from 'node-cron';
import {
  listUnreadMessagesWithAttachments,
  getMessageWithAttachments,
  markMessageRead,
  verifyGmailConnection,
  EmailMessage,
  EmailAttachment,
} from './gmail.js';
import { supabase } from './supabase.js';
import { dispatchParser, ParserOutcome } from '../parsers/index.js';
import { storeMonthlyRecords, storeDailyRecords } from './productionStorage.js';
import { computeRetryState, DEFAULT_MAX_RETRIES } from './errorClassification.js';
import { maybeSendFailureAlert } from './notifications.js';

const STORAGE_BUCKET = 'production-files';

/**
 * Upload a raw attachment to Supabase Storage. Returns the storage path used.
 * Path convention: {YYYY}/{MM}/{messageId}_{safeFilename}
 */
async function uploadAttachmentToStorage(
  message: EmailMessage,
  attachment: EmailAttachment
): Promise<string> {
  const year = message.receivedAt.getUTCFullYear();
  const month = String(message.receivedAt.getUTCMonth() + 1).padStart(2, '0');
  // Replace characters that are awkward in storage keys
  const safeName = attachment.filename.replace(/[^A-Za-z0-9._-]/g, '_');
  const path = `${year}/${month}/${message.id}_${safeName}`;

  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(path, attachment.data, {
      contentType: attachment.mimeType,
      upsert: true, // Allow re-processing same message without error
    });

  if (error) {
    throw new Error(`Supabase Storage upload failed: ${error.message}`);
  }
  return path;
}

/**
 * Create an email_log row at the start of processing.
 * Returns the row's UUID so downstream parsed records can reference it as source_email_id.
 */
async function createEmailLogRow(message: EmailMessage): Promise<string> {
  const { data, error } = await supabase
    .from('email_log')
    .insert({
      gmail_message_id: message.id,
      sender: message.sender,
      subject: message.subject,
      received_at: message.receivedAt.toISOString(),
      attachments_found: message.attachments.length,
      status: 'processing',
      processing_started_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (error) {
    // Handle the unique-constraint case (we've seen this message before)
    if (error.code === '23505') {
      const { data: existing } = await supabase
        .from('email_log')
        .select('id')
        .eq('gmail_message_id', message.id)
        .single();
      if (existing) return existing.id;
    }
    throw new Error(`Failed to insert email_log row: ${error.message}`);
  }
  return data!.id;
}

async function finalizeEmailLog(
  emailLogId: string,
  status: 'completed' | 'partial' | 'failed' | 'skipped' | 'ignored',
  attachmentsProcessed: number,
  errors: string[]
): Promise<void> {
  // Read current retry bookkeeping so we can compute the next state.
  // Task #62 (2026-04-21): finalize now also sets the retry columns —
  // is_retryable / next_retry_at / last_retry_outcome — based on whether
  // this run produced a transient error and how many attempts we've had.
  // See services/errorClassification.ts for the rules.
  let retryCountSoFar = 0;
  let maxRetries = DEFAULT_MAX_RETRIES;
  try {
    const { data, error } = await supabase
      .from('email_log')
      .select('retry_count, max_retries')
      .eq('id', emailLogId)
      .single();
    if (error) {
      console.warn(
        `[emailPoller] Failed to read retry bookkeeping for email ${emailLogId}: ${error.message}. ` +
          'Using defaults.'
      );
    } else if (data) {
      retryCountSoFar = data.retry_count ?? 0;
      maxRetries = data.max_retries ?? DEFAULT_MAX_RETRIES;
    }
  } catch (err) {
    console.warn(
      `[emailPoller] Unexpected error reading retry state for email ${emailLogId}: ${
        (err as Error).message
      }. Using defaults.`
    );
  }

  const retryState = computeRetryState(status, errors, retryCountSoFar, maxRetries);

  await supabase
    .from('email_log')
    .update({
      status,
      attachments_processed: attachmentsProcessed,
      error_messages: errors.length > 0 ? errors : null,
      processing_completed_at: new Date().toISOString(),
      is_retryable: retryState.is_retryable,
      next_retry_at: retryState.next_retry_at,
      last_retry_outcome: retryState.last_retry_outcome,
      // Note: retry_count is NOT written here — the retry worker owns that
      // counter. It increments atomically when claiming a retry slot (see
      // retryWorker.ts). This way finalize never races with the worker.
    })
    .eq('id', emailLogId);

  // Task #63 (2026-04-21). Fire a notification email IFF this run ended
  // in a terminal failure state. maybeSendFailureAlert is self-gating:
  //   • returns early if NOTIFICATIONS_ENABLED != "true"
  //   • returns early if outcome != permanent_failure/exhausted
  //   • returns early if alert_sent_at is already set (dedupe)
  //   • swallows every error so a notification hiccup can never poison
  //     the parent processMessage run
  // We do NOT await the function's failure — fire-and-log is enough.
  if (
    retryState.last_retry_outcome === 'permanent_failure' ||
    retryState.last_retry_outcome === 'exhausted'
  ) {
    try {
      await maybeSendFailureAlert(emailLogId);
    } catch (err) {
      // Defense-in-depth: maybeSendFailureAlert catches its own errors,
      // but if somehow one escapes we log rather than propagate.
      console.error(
        `[emailPoller] Notification pathway threw for ${emailLogId}: ${
          (err as Error).message
        }`
      );
    }
  }
}

/**
 * Process a single email message end-to-end. Never throws — all errors are caught
 * and written to email_log so the poller loop keeps going.
 */
export async function processMessage(messageId: string): Promise<void> {
  let emailLogId: string | null = null;
  const errors: string[] = [];
  const ignoredNotes: string[] = [];
  let attachmentsProcessed = 0;
  let attachmentsIgnored = 0;

  try {
    const message = await getMessageWithAttachments(messageId);
    emailLogId = await createEmailLogRow(message);

    // Clean slate for re-runs. If this is a reprocess (or a poller retry of
    // a message whose previous attempt failed), wipe any prior flagged rows
    // so the dashboard only reflects the current run's outcome. Without
    // this, successful rescues leave stale flagged_records behind — which
    // is exactly what bit us on 2026-04-21 with the 9 TREME 21H rows.
    // Best-effort: a failure here must not block the import.
    try {
      const { error: clearErr } = await supabase
        .from('flagged_records')
        .delete()
        .eq('email_log_id', emailLogId);
      if (clearErr) {
        console.warn(
          `[emailPoller] Failed to clear prior flagged_records for email ${emailLogId}: ${clearErr.message}`
        );
      }
    } catch (err) {
      console.warn(
        `[emailPoller] Unexpected error clearing flagged_records for email ${emailLogId}: ${
          (err as Error).message
        }`
      );
    }

    if (message.attachments.length === 0) {
      await finalizeEmailLog(emailLogId, 'skipped', 0, ['No attachments found']);
      await markMessageRead(messageId);
      return;
    }

    for (const attachment of message.attachments) {
      try {
        // 1. Store the raw file
        const storagePath = await uploadAttachmentToStorage(message, attachment);

        // 2. Try to parse it
        const outcome: ParserOutcome = await dispatchParser(attachment, message.sender);

        if (outcome.kind === 'ignored') {
          // Known-non-production file (tracking sheet, template, etc.) —
          // this is a clean success, not an error. Note it for the log,
          // but don't push to errors[] and don't count as "processed".
          attachmentsIgnored++;
          ignoredNotes.push(
            `[${attachment.filename}] Ignored as ${outcome.category} (${outcome.filterName}): ${outcome.reason}`
          );
          console.log(
            `[emailPoller] Ignored attachment ${attachment.filename}: ${outcome.category} (${outcome.filterName})`
          );
          continue;
        }

        if (outcome.kind === 'unrecognized') {
          errors.push(
            `[${attachment.filename}] Unrecognized format — flagged for manual review. ` +
              `Details: ${outcome.reason}`
          );
          continue;
        }

        if (outcome.kind === 'error') {
          // When the dispatcher identified the format but the parser is a stub
          // or failed, include the format name so the dashboard can show exactly
          // what was detected.
          const formatTag = outcome.matchedFormatName ? `[${outcome.matchedFormatName}] ` : '';
          errors.push(
            `[${attachment.filename}] ${formatTag}Parser error: ${outcome.message}`
          );
          continue;
        }

        // 3. Write parsed rows
        const context = {
          sourceEmailId: emailLogId,
          sourceFileName: attachment.filename,
          sourceStoragePath: storagePath,
          operatorName: outcome.operatorName,
        };

        let storeResult: { inserted: number; skipped: number; operatorId: string };
        if (outcome.dataType === 'monthly') {
          storeResult = await storeMonthlyRecords(outcome.records, context);
        } else if (outcome.dataType === 'daily') {
          storeResult = await storeDailyRecords(outcome.records, context);
        } else {
          // Weekly should be divided into daily rows by the parser BEFORE
          // reaching here (per project rules). If we ever see dataType='weekly'
          // at this point, the parser didn't do its job — flag loudly.
          errors.push(
            `[${attachment.filename}] Parser returned dataType='${outcome.dataType}' — ` +
              `weekly data must be pre-divided into daily rows by the parser.`
          );
          continue;
        }
        // Soft warning: storage skipped some records due to invalid api10.
        // Doesn't fail the attachment (most rows still inserted); surfaces
        // in the dashboard so Caleb can see that something needs attention.
        if (storeResult.skipped > 0) {
          ignoredNotes.push(
            `[${attachment.filename}] ${storeResult.inserted} rows inserted, ` +
              `${storeResult.skipped} skipped (invalid/missing API — check parser output).`
          );
        }
        attachmentsProcessed++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`[${attachment.filename}] ${msg}`);
      }
    }

    // Status decision tree:
    //   • All attachments parsed → completed
    //   • At least one parsed, rest ignored, no errors → completed
    //   • Nothing parsed, everything ignored, no errors → ignored (quiet success)
    //   • Some parsed + some errored → partial
    //   • Nothing parsed, everything errored or unrecognized → failed
    //   • Some parsed + some errored + some ignored → partial (errors trump ignores)
    const total = message.attachments.length;
    const hasErrors = errors.length > 0;
    let status: 'completed' | 'partial' | 'failed' | 'ignored';
    if (attachmentsProcessed === total) {
      status = 'completed';
    } else if (attachmentsProcessed + attachmentsIgnored === total && !hasErrors) {
      // Every attachment was either parsed successfully or cleanly ignored.
      status = attachmentsProcessed > 0 ? 'completed' : 'ignored';
    } else if (attachmentsProcessed > 0) {
      status = 'partial';
    } else {
      status = 'failed';
    }

    // Ignored notes are written into the error_messages column too — NOT as
    // errors (the UI filters by status), but so we have a breadcrumb of why
    // we skipped each file. Keep them at the END so real errors surface first.
    const finalMessages = [...errors, ...ignoredNotes];
    await finalizeEmailLog(emailLogId, status, attachmentsProcessed, finalMessages);
    await markMessageRead(messageId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[emailPoller] Fatal error processing message ${messageId}:`, msg);
    if (emailLogId) {
      await finalizeEmailLog(emailLogId, 'failed', attachmentsProcessed, [
        ...errors,
        `Fatal: ${msg}`,
      ]);
    }
    // Don't mark as read — we want to retry on next poll
  }
}

/**
 * Run one polling pass. Exported for manual triggering (e.g. admin route / CLI).
 */
export async function runPollingPass(): Promise<{ messagesProcessed: number }> {
  const ids = await listUnreadMessagesWithAttachments(50);
  console.log(`[emailPoller] Found ${ids.length} unread messages with attachments`);
  for (const id of ids) {
    await processMessage(id);
  }
  return { messagesProcessed: ids.length };
}

/**
 * Start the cron schedule. Call once from src/index.ts on server boot.
 * Schedule: every 15 minutes (at :00, :15, :30, :45).
 */
export function startEmailPollerCron(): void {
  console.log('[emailPoller] Starting cron — every 15 minutes');
  cron.schedule('*/15 * * * *', async () => {
    try {
      await runPollingPass();
    } catch (err) {
      console.error('[emailPoller] Polling pass failed:', err);
    }
  });

  // Also run once immediately on startup so we pick up anything that queued while we were down
  setTimeout(async () => {
    try {
      const who = await verifyGmailConnection();
      console.log(`[emailPoller] Connected to Gmail as: ${who}`);
      await runPollingPass();
    } catch (err) {
      console.error('[emailPoller] Startup polling pass failed:', err);
    }
  }, 5000);
}
