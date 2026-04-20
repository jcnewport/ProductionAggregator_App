/**
 * Gmail API Service
 * ------------------
 * Wraps the Google Gmail API for the ProductionAggregator backend.
 *
 * Responsibilities:
 *   - Authenticate via OAuth2 with a stored refresh token
 *   - List unread messages with attachments in the monitored inbox
 *   - Download attachment bytes
 *   - Mark messages as read after processing
 *
 * Env vars required:
 *   GMAIL_CLIENT_ID       — from Google Cloud Console OAuth credentials
 *   GMAIL_CLIENT_SECRET   — from Google Cloud Console OAuth credentials
 *   GMAIL_REFRESH_TOKEN   — obtained once via scripts/get-gmail-refresh-token.ts
 *   GMAIL_MONITORED_EMAIL — e.g. S.IS_AD_Prod@stewardship.is (identifies the inbox)
 */

import { google, gmail_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

export interface EmailAttachment {
  filename: string;
  mimeType: string;
  data: Buffer;
  sizeBytes: number;
}

export interface EmailMessage {
  id: string;                 // Gmail message ID
  threadId: string;
  sender: string;             // "From" header
  subject: string;
  receivedAt: Date;           // Internal timestamp from Gmail
  attachments: EmailAttachment[];
}

let oauthClient: OAuth2Client | null = null;
let gmailClient: gmail_v1.Gmail | null = null;

/**
 * Lazily build the authenticated Gmail client. Reuses a single instance across calls.
 */
function getGmailClient(): gmail_v1.Gmail {
  if (gmailClient) return gmailClient;

  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    throw new Error(
      'Missing Gmail credentials. Required env vars: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN.'
    );
  }

  oauthClient = new google.auth.OAuth2(
    GMAIL_CLIENT_ID,
    GMAIL_CLIENT_SECRET,
    'http://localhost:53682/callback' // Matches the loopback redirect used by get-gmail-refresh-token.ts
  );
  oauthClient.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });

  gmailClient = google.gmail({ version: 'v1', auth: oauthClient });
  return gmailClient;
}

/**
 * Fetch a single header value from a Gmail message headers array.
 * Case-insensitive on the header name.
 */
function headerValue(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string
): string {
  if (!headers) return '';
  const lower = name.toLowerCase();
  const h = headers.find((x) => (x.name || '').toLowerCase() === lower);
  return h?.value || '';
}

/**
 * List unread messages that were addressed to the monitored alias AND have attachments.
 *
 * IMPORTANT: GMAIL_MONITORED_EMAIL (e.g. S.IS_AD_Prod@stewardship.is) is an ALIAS that
 * delivers to the real authenticated mailbox (c@stewardship.is). All mail lives in the
 * real mailbox, so we filter by the "to:" header to pick out only the production reports.
 * This keeps the poller from ever touching personal mail in the same inbox.
 *
 * Gmail search query:  to:{alias} is:unread has:attachment
 */
export async function listUnreadMessagesWithAttachments(
  maxResults = 25
): Promise<string[]> {
  const monitored = process.env.GMAIL_MONITORED_EMAIL;
  if (!monitored) {
    throw new Error(
      'GMAIL_MONITORED_EMAIL env var is required — set it to the alias you want to monitor (e.g. S.IS_AD_Prod@stewardship.is).'
    );
  }
  const gmail = getGmailClient();
  const q = `to:${monitored} is:unread has:attachment`;
  const res = await gmail.users.messages.list({
    userId: 'me',
    q,
    maxResults,
  });
  return (res.data.messages || []).map((m) => m.id!).filter(Boolean);
}

/**
 * Fetch a full message (with attachment bodies) by ID, and normalize into our internal
 * EmailMessage shape.
 */
export async function getMessageWithAttachments(
  messageId: string
): Promise<EmailMessage> {
  const gmail = getGmailClient();
  const res = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });

  const payload = res.data.payload;
  const headers = payload?.headers;
  const sender = headerValue(headers, 'From');
  const subject = headerValue(headers, 'Subject');
  const internalDate = res.data.internalDate
    ? new Date(Number(res.data.internalDate))
    : new Date();

  // Walk the MIME tree and collect any part with a filename
  const attachments: EmailAttachment[] = [];

  async function walk(part: gmail_v1.Schema$MessagePart | undefined): Promise<void> {
    if (!part) return;
    if (part.filename && part.filename.length > 0 && part.body?.attachmentId) {
      const att = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId,
        id: part.body.attachmentId,
      });
      if (att.data.data) {
        // Gmail returns base64url-encoded data; convert to a Buffer
        const data = Buffer.from(att.data.data, 'base64url');
        attachments.push({
          filename: part.filename,
          mimeType: part.mimeType || 'application/octet-stream',
          data,
          sizeBytes: data.length,
        });
      }
    }
    if (part.parts) {
      for (const child of part.parts) {
        await walk(child);
      }
    }
  }

  await walk(payload);

  return {
    id: messageId,
    threadId: res.data.threadId || '',
    sender,
    subject,
    receivedAt: internalDate,
    attachments,
  };
}

/**
 * Mark a message as read by removing the UNREAD label.
 * Called after successful processing so we don't re-process the same email.
 */
export async function markMessageRead(messageId: string): Promise<void> {
  const gmail = getGmailClient();
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { removeLabelIds: ['UNREAD'] },
  });
}

/**
 * Sanity check for startup: tries to fetch the authenticated user's profile.
 * Logs the email address on success (useful for verifying the refresh token is valid
 * and is bound to the correct inbox).
 */
export async function verifyGmailConnection(): Promise<string> {
  const gmail = getGmailClient();
  const res = await gmail.users.getProfile({ userId: 'me' });
  return res.data.emailAddress || '(unknown)';
}
