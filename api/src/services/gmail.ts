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
  /**
   * The tenant alias this message was addressed to, lowercased. Sourced first
   * from Google Workspace's `Delivered-To` header (authoritative), then falling
   * back to scanning the `To` header for any known alias. Used to route the
   * message to the correct tenant (phase 3 multi-tenancy).
   *
   * Empty string when no match could be determined.
   */
  deliveredTo: string;
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
 * Escape an alias for use inside a Gmail `to:` search clause.
 *
 * Gmail's query language does not need shell-style escaping for typical email
 * addresses, but we wrap any alias containing whitespace in quotes to be safe.
 */
function formatToClause(alias: string): string {
  const trimmed = alias.trim();
  if (!trimmed) return '';
  if (/\s/.test(trimmed)) return `to:"${trimmed}"`;
  return `to:${trimmed}`;
}

/**
 * List unread messages that were addressed to ANY of the supplied tenant
 * aliases AND have attachments.
 *
 * Each tenant in the product is configured with a unique alias of the form
 * `s.is_<slug>_prod@stewardship.is`. All aliases deliver to the same real
 * mailbox (`c@stewardship.is`), so we build a single OR query:
 *
 *     to:(alias1 OR alias2 OR ...) is:unread has:attachment
 *
 * This keeps the poller from ever touching personal mail in the same inbox
 * and lets us route each message to the correct tenant via `Delivered-To`.
 */
export async function listUnreadMessagesWithAttachments(
  aliases: string[],
  maxResults = 25
): Promise<string[]> {
  const cleaned = aliases
    .map((a) => (a ?? '').trim())
    .filter((a) => a.length > 0);
  if (cleaned.length === 0) {
    throw new Error(
      'listUnreadMessagesWithAttachments requires at least one tenant alias — pass the set of active tenant email_alias values.'
    );
  }

  const clauses = cleaned.map(formatToClause).filter((c) => c.length > 0);
  const toPart =
    clauses.length === 1 ? clauses[0] : `(${clauses.join(' OR ')})`;
  const q = `${toPart} is:unread has:attachment`;

  const gmail = getGmailClient();
  const res = await gmail.users.messages.list({
    userId: 'me',
    q,
    maxResults,
  });
  return (res.data.messages || []).map((m) => m.id!).filter(Boolean);
}

/**
 * Resolve which tenant alias this message was delivered to.
 *
 * Google Workspace sets the `Delivered-To` header to the alias that actually
 * received the message — this is the authoritative source. If for any reason
 * that header is missing, fall back to scanning the `To` header (and `Cc`)
 * for any alias we know about. If nothing matches, return `''`.
 *
 * All comparisons are lowercased since email addresses are case-insensitive.
 */
function resolveDeliveredTo(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  knownAliases: Set<string>
): string {
  const rawDelivered = headerValue(headers, 'Delivered-To').trim().toLowerCase();
  if (rawDelivered && knownAliases.has(rawDelivered)) {
    return rawDelivered;
  }

  const scan = [
    headerValue(headers, 'To'),
    headerValue(headers, 'Cc'),
    headerValue(headers, 'X-Original-To'),
  ]
    .filter(Boolean)
    .join(',')
    .toLowerCase();

  for (const alias of knownAliases) {
    if (alias && scan.includes(alias)) return alias;
  }

  // Last resort — return whatever Delivered-To said, even if not in the
  // known set. The caller will treat an unknown alias as a skip.
  return rawDelivered;
}

/**
 * Fetch a full message (with attachment bodies) by ID, and normalize into our internal
 * EmailMessage shape.
 *
 * `knownAliases` is the set of currently-active tenant aliases (lowercased).
 * Used to resolve the message's `Delivered-To` for tenant routing.
 */
export async function getMessageWithAttachments(
  messageId: string,
  knownAliases: Set<string>
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
  const deliveredTo = resolveDeliveredTo(headers, knownAliases);
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
    deliveredTo,
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
