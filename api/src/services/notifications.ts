/**
 * Failure-Alert Notifications
 * ----------------------------
 * Task #63 (2026-04-21). When an email_log row reaches a TERMINAL
 * failure state (permanent_failure or exhausted), we send Caleb a
 * heads-up email so he knows to investigate. Transient errors that
 * auto-recover via the retry worker stay silent — no inbox spam.
 *
 * DESIGN
 * ──────
 * • Channel: Gmail (same OAuth we already have; scope gmail.modify
 *   includes send). Sent FROM the monitored alias (e.g.
 *   S.IS_AD_Prod@stewardship.is) TO the operator address in
 *   NOTIFICATIONS_TO_EMAIL.
 *
 * • Trigger: emailPoller.finalizeEmailLog() calls maybeSendFailureAlert
 *   after writing the retry state. We only send if:
 *     - last_retry_outcome IN ('permanent_failure', 'exhausted'), AND
 *     - alert_sent_at IS NULL (dedupe — one alert per email_log row).
 *
 * • Body: HTML + plain-text multipart. Includes:
 *     - Email identity (sender, subject, received_at)
 *     - Outcome tag + retry count
 *     - First N error messages (truncated)
 *     - Last-24h row-level rejections (top 5 from flagged_records)
 *     - Dashboard link for drilling in
 *
 * • Env-gated:
 *     NOTIFICATIONS_ENABLED=true|false  (default: false — off in dev)
 *     NOTIFICATIONS_TO_EMAIL=c@...       (required when enabled)
 *     NOTIFICATIONS_FROM_EMAIL=...       (optional; defaults to
 *                                         GMAIL_MONITORED_EMAIL)
 *     DASHBOARD_URL=https://...          (optional; used in the email body)
 *
 * If disabled or misconfigured, we log a note and return — never throw.
 * A notification failure must NEVER poison the parent processMessage
 * run.
 */

import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { supabase } from './supabase.js';

/* ────────────────────────────────────────────────────────────────
 * Config
 * ──────────────────────────────────────────────────────────────── */

function isEnabled(): boolean {
  return (process.env.NOTIFICATIONS_ENABLED ?? '').toLowerCase() === 'true';
}

function getToEmail(): string | null {
  const v = process.env.NOTIFICATIONS_TO_EMAIL;
  return v && v.trim().length > 0 ? v.trim() : null;
}

function getFromEmail(): string | null {
  const v = process.env.NOTIFICATIONS_FROM_EMAIL || process.env.GMAIL_MONITORED_EMAIL;
  return v && v.trim().length > 0 ? v.trim() : null;
}

function getDashboardUrl(): string {
  // Sensible default — the custom domain we know is live. Overrideable via env
  // for local testing.
  return process.env.DASHBOARD_URL || 'https://productionaggregator.stewardship.is';
}

/* ────────────────────────────────────────────────────────────────
 * Public types
 * ──────────────────────────────────────────────────────────────── */

/** Minimal shape needed by the alert composer. Matches email_log. */
export interface EmailLogForAlert {
  id: string;
  gmail_message_id: string | null;
  sender: string | null;
  subject: string | null;
  received_at: string | null;
  status: string;
  attachments_found: number | null;
  attachments_processed: number | null;
  error_messages: string[] | null;
  retry_count: number | null;
  max_retries: number | null;
  last_retry_outcome: string | null;
  alert_sent_at: string | null;
}

/* ────────────────────────────────────────────────────────────────
 * Gmail send — uses the SAME OAuth refresh token the poller uses.
 * gmail.modify scope includes gmail.send so no re-auth needed.
 * Kept local to this file (not in gmail.ts) because "read inbox" and
 * "send alert" are different concerns and we don't want to pollute
 * the poller with outbound plumbing.
 * ──────────────────────────────────────────────────────────────── */

let cachedOauth: OAuth2Client | null = null;

function getOauthClient(): OAuth2Client {
  if (cachedOauth) return cachedOauth;
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    throw new Error(
      'Missing Gmail credentials for notifications (GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN).'
    );
  }
  cachedOauth = new google.auth.OAuth2(
    GMAIL_CLIENT_ID,
    GMAIL_CLIENT_SECRET,
    'http://localhost:53682/callback'
  );
  cachedOauth.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  return cachedOauth;
}

/**
 * Send a multipart (text + html) email via Gmail.
 * Returns the Gmail message id on success.
 */
async function sendGmail(args: {
  from: string;
  to: string;
  subject: string;
  textBody: string;
  htmlBody: string;
}): Promise<string> {
  const { from, to, subject, textBody, htmlBody } = args;
  const gmail = google.gmail({ version: 'v1', auth: getOauthClient() });

  const boundary = '=_Boundary_' + Math.random().toString(36).slice(2);
  // RFC822 encoded message. Subject is encoded-word in case it contains
  // non-ASCII (e.g. em-dash).
  const encodedSubject =
    '=?UTF-8?B?' + Buffer.from(subject, 'utf8').toString('base64') + '?=';

  const raw = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    textBody,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    htmlBody,
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n');

  // Gmail expects a base64url-encoded raw message.
  const rawB64 = Buffer.from(raw, 'utf8').toString('base64url');

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: rawB64 },
  });
  return res.data.id || '';
}

/* ────────────────────────────────────────────────────────────────
 * Alert body composition
 * ──────────────────────────────────────────────────────────────── */

interface FlaggedRecordSummary {
  file: string;
  reason: string;
  created_at: string;
}

/**
 * Pull the most recent row-level rejections from flagged_records for
 * the email body's footer section. Best-effort — returns [] on error
 * so a flagged_records hiccup never blocks the alert.
 */
async function fetchRecentFlaggedRecords(
  limit = 5
): Promise<FlaggedRecordSummary[]> {
  try {
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const { data, error } = await supabase
      .from('flagged_records')
      .select('source_file_name, reason, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) {
      console.warn(
        `[notifications] flagged_records query failed: ${error.message}. ` +
          'Continuing without footer.'
      );
      return [];
    }
    return (data ?? []).map(
      (r: { source_file_name: string; reason: string; created_at: string }) => ({
        file: r.source_file_name,
        reason: r.reason,
        created_at: r.created_at,
      })
    );
  } catch (err) {
    console.warn(
      `[notifications] flagged_records lookup threw: ${(err as Error).message}`
    );
    return [];
  }
}

function formatOutcomeBadge(outcome: string | null): string {
  switch (outcome) {
    case 'permanent_failure':
      return 'PERMANENT FAILURE (parser or format problem — retrying will not help)';
    case 'exhausted':
      return 'RETRIES EXHAUSTED (transient errors on all attempts — needs manual investigation)';
    default:
      return String(outcome ?? 'unknown');
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncateMsg(s: string, n = 240): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Build the human-readable text + HTML bodies. Exposed for the test script. */
export function composeAlertEmail(args: {
  row: EmailLogForAlert;
  flagged: FlaggedRecordSummary[];
  dashboardUrl: string;
}): { subject: string; textBody: string; htmlBody: string } {
  const { row, flagged, dashboardUrl } = args;
  const subjectSuffix = row.subject ? ` — ${truncateMsg(row.subject, 60)}` : '';
  const outcomeTag =
    row.last_retry_outcome === 'permanent_failure' ? 'permanent' : 'exhausted';
  const subject = `[ProductionAggregator] ${outcomeTag} failure${subjectSuffix}`;

  const errs = (row.error_messages ?? []).slice(0, 5);
  const retryLine =
    row.retry_count != null
      ? `Attempts: ${row.retry_count}/${row.max_retries ?? 5}`
      : 'Attempts: —';

  /* ── plain-text body ── */
  const textParts: string[] = [];
  textParts.push('Production email processing needs attention.');
  textParts.push('');
  textParts.push(`Outcome: ${formatOutcomeBadge(row.last_retry_outcome)}`);
  textParts.push(`Status: ${row.status}`);
  textParts.push(retryLine);
  textParts.push('');
  textParts.push('EMAIL');
  textParts.push(`  From: ${row.sender ?? '—'}`);
  textParts.push(`  Subject: ${row.subject ?? '—'}`);
  textParts.push(`  Received: ${row.received_at ?? '—'}`);
  textParts.push(
    `  Attachments: ${row.attachments_processed ?? 0} processed / ${row.attachments_found ?? 0} found`
  );
  textParts.push('');
  textParts.push('ERRORS');
  if (errs.length === 0) {
    textParts.push('  (none recorded)');
  } else {
    for (const e of errs) textParts.push(`  • ${truncateMsg(e)}`);
  }
  textParts.push('');
  textParts.push('DASHBOARD');
  textParts.push(`  ${dashboardUrl}`);

  if (flagged.length > 0) {
    textParts.push('');
    textParts.push('ROW-LEVEL REJECTIONS (last 24 hr, most recent first)');
    for (const f of flagged) {
      textParts.push(`  • [${f.file}] ${truncateMsg(f.reason, 160)}`);
    }
  }
  textParts.push('');
  textParts.push('—');
  textParts.push(
    'This is an automated alert from ProductionAggregator. ' +
      'Transient errors that auto-recover are never emailed; you only see this ' +
      'when a parser or format problem has blocked processing.'
  );

  const textBody = textParts.join('\n');

  /* ── HTML body (inline-styled so Gmail/Outlook renders without CSS) ── */
  const NAVY = '#0A1628';
  const TEAL = '#00BFA6';
  const STEEL = '#4A6FA5';
  const RED = '#F14124';
  const MUTED = '#6A7280';
  const BORDER = '#E5E7EB';

  const outcomeColor =
    row.last_retry_outcome === 'permanent_failure' ? RED : '#FF8021';

  const errHtml =
    errs.length === 0
      ? `<li style="color:${MUTED};">(none recorded)</li>`
      : errs.map((e) => `<li>${escapeHtml(truncateMsg(e))}</li>`).join('');

  const flaggedHtml =
    flagged.length === 0
      ? ''
      : `
    <h3 style="margin:28px 0 8px;color:${NAVY};font-size:14px;">
      Row-level rejections <span style="color:${MUTED};font-weight:400;">(last 24 hr)</span>
    </h3>
    <ul style="margin:0;padding-left:18px;color:#374151;font-size:13px;line-height:1.5;">
      ${flagged
        .map(
          (f) =>
            `<li><strong>${escapeHtml(f.file)}</strong><br><span style="color:${MUTED};">${escapeHtml(truncateMsg(f.reason, 200))}</span></li>`
        )
        .join('')}
    </ul>`;

  const htmlBody = `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#F2F2F2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:640px;margin:24px auto;background:#FFFFFF;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">
    <div style="background:${NAVY};color:#FFFFFF;padding:20px 24px;">
      <div style="font-size:12px;color:${TEAL};letter-spacing:.5px;text-transform:uppercase;">
        ProductionAggregator
      </div>
      <div style="font-size:20px;font-weight:600;margin-top:4px;">
        Email processing needs attention
      </div>
    </div>
    <div style="padding:24px;color:#1F2937;font-size:14px;line-height:1.5;">
      <div style="display:inline-block;padding:4px 10px;border-radius:4px;background:${outcomeColor}22;color:${outcomeColor};font-size:12px;font-weight:600;letter-spacing:.3px;text-transform:uppercase;">
        ${escapeHtml(row.last_retry_outcome ?? 'failure')}
      </div>
      <div style="margin-top:8px;color:${MUTED};font-size:13px;">${escapeHtml(retryLine)}</div>

      <table role="presentation" style="margin:20px 0 0;width:100%;border-collapse:collapse;font-size:13px;">
        <tr>
          <td style="padding:6px 0;color:${MUTED};width:110px;">From</td>
          <td style="padding:6px 0;color:${NAVY};">${escapeHtml(row.sender ?? '—')}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;color:${MUTED};">Subject</td>
          <td style="padding:6px 0;color:${NAVY};">${escapeHtml(row.subject ?? '—')}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;color:${MUTED};">Received</td>
          <td style="padding:6px 0;color:${NAVY};">${escapeHtml(row.received_at ?? '—')}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;color:${MUTED};">Attachments</td>
          <td style="padding:6px 0;color:${NAVY};">${row.attachments_processed ?? 0} processed / ${row.attachments_found ?? 0} found</td>
        </tr>
      </table>

      <h3 style="margin:24px 0 8px;color:${NAVY};font-size:14px;">Errors</h3>
      <ul style="margin:0;padding-left:18px;color:#374151;font-size:13px;line-height:1.5;">
        ${errHtml}
      </ul>

      ${flaggedHtml}

      <div style="margin-top:28px;">
        <a href="${dashboardUrl}" style="display:inline-block;background:${STEEL};color:#FFFFFF;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600;font-size:14px;">
          Open dashboard →
        </a>
      </div>

      <p style="margin-top:24px;padding-top:18px;border-top:1px solid ${BORDER};color:${MUTED};font-size:12px;line-height:1.5;">
        Automated alert from ProductionAggregator. Transient errors that
        auto-recover are never emailed — you only see this when a parser or
        format problem has blocked processing.
      </p>
    </div>
  </div>
</body>
</html>`;

  return { subject, textBody, htmlBody };
}

/* ────────────────────────────────────────────────────────────────
 * Public API
 * ──────────────────────────────────────────────────────────────── */

/**
 * Idempotent alert trigger.
 *
 * Precondition: the email_log row already has its retry state written.
 * Behavior:
 *   1. If notifications are disabled or misconfigured → log + return (no throw)
 *   2. If the row isn't in a terminal-failure state → return
 *   3. If alert_sent_at is already set → return
 *   4. Compose + send the email, then stamp alert_sent_at
 *
 * Callable from:
 *   • emailPoller.finalizeEmailLog (the main trigger point)
 *   • admin endpoints (e.g. "resend alert")
 *   • test scripts
 *
 * Never throws — notification failures must NEVER poison the parent
 * processMessage run. All errors are logged.
 */
export async function maybeSendFailureAlert(emailLogId: string): Promise<{
  sent: boolean;
  reason: string;
  gmailMessageId?: string;
}> {
  try {
    if (!isEnabled()) {
      return { sent: false, reason: 'NOTIFICATIONS_ENABLED is not "true"' };
    }
    const to = getToEmail();
    if (!to) {
      console.warn(
        '[notifications] NOTIFICATIONS_TO_EMAIL not set — cannot send failure alert.'
      );
      return { sent: false, reason: 'NOTIFICATIONS_TO_EMAIL not set' };
    }
    const from = getFromEmail();
    if (!from) {
      console.warn(
        '[notifications] No From address (set NOTIFICATIONS_FROM_EMAIL or GMAIL_MONITORED_EMAIL).'
      );
      return { sent: false, reason: 'No From address configured' };
    }

    // Fetch the row. We use maybeSingle semantics (via .single + try/catch)
    // so a missing row is a warning, not a crash.
    const { data: row, error } = await supabase
      .from('email_log')
      .select(
        'id, gmail_message_id, sender, subject, received_at, status, ' +
          'attachments_found, attachments_processed, error_messages, ' +
          'retry_count, max_retries, last_retry_outcome, alert_sent_at'
      )
      .eq('id', emailLogId)
      .single();

    if (error || !row) {
      console.warn(
        `[notifications] Could not load email_log row ${emailLogId}: ${error?.message ?? 'not found'}`
      );
      return { sent: false, reason: 'email_log row not found' };
    }

    const r = row as unknown as EmailLogForAlert;
    if (
      r.last_retry_outcome !== 'permanent_failure' &&
      r.last_retry_outcome !== 'exhausted'
    ) {
      return {
        sent: false,
        reason: `outcome="${r.last_retry_outcome}" — not a terminal failure`,
      };
    }
    if (r.alert_sent_at) {
      return { sent: false, reason: 'already alerted' };
    }

    const flagged = await fetchRecentFlaggedRecords(5);
    const { subject, textBody, htmlBody } = composeAlertEmail({
      row: r,
      flagged,
      dashboardUrl: getDashboardUrl(),
    });

    const gmailId = await sendGmail({ from, to, subject, textBody, htmlBody });

    // Stamp alert_sent_at so we don't double-notify. Best-effort — if this
    // write fails we'd rather risk a rare duplicate than re-throw and
    // possibly lose the alert altogether.
    const { error: stampErr } = await supabase
      .from('email_log')
      .update({ alert_sent_at: new Date().toISOString() })
      .eq('id', emailLogId);
    if (stampErr) {
      console.warn(
        `[notifications] Sent alert for ${emailLogId} but failed to stamp alert_sent_at: ${stampErr.message}`
      );
    }

    console.log(
      `[notifications] Sent failure alert for email_log ${emailLogId} (gmail=${gmailId}, outcome=${r.last_retry_outcome})`
    );
    return { sent: true, reason: 'ok', gmailMessageId: gmailId };
  } catch (err) {
    console.error(
      `[notifications] Failed to send alert for ${emailLogId}:`,
      (err as Error).message
    );
    return { sent: false, reason: `error: ${(err as Error).message}` };
  }
}

/**
 * Admin helper — resend a previously-sent alert by clearing alert_sent_at
 * and calling maybeSendFailureAlert. Useful when the recipient's inbox
 * rules silently moved the original alert to trash.
 */
export async function resendFailureAlert(emailLogId: string): Promise<{
  sent: boolean;
  reason: string;
  gmailMessageId?: string;
}> {
  const { error } = await supabase
    .from('email_log')
    .update({ alert_sent_at: null })
    .eq('id', emailLogId);
  if (error) {
    return { sent: false, reason: `clear alert_sent_at: ${error.message}` };
  }
  return maybeSendFailureAlert(emailLogId);
}
