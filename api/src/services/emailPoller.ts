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
  await supabase
    .from('email_log')
    .update({
      status,
      attachments_processed: attachmentsProcessed,
      error_messages: errors.length > 0 ? errors : null,
      processing_completed_at: new Date().toISOString(),
    })
    .eq('id', emailLogId);
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

        if (outcome.dataType === 'monthly') {
          await storeMonthlyRecords(outcome.records, context);
        } else if (outcome.dataType === 'daily') {
          await storeDailyRecords(outcome.records, context);
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
