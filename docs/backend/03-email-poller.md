# 03 · Email Poller

The Gmail integration. Source: `api/src/services/emailPoller.ts` + `api/src/services/gmail.ts`.

## What it does

Pulls emails from `S.IS_AD_Prod@stewardship.is`, identifies which tenant they belong to via the `To:` header (using aliases), and hands every attachment to the parser dispatcher.

## Schedule

- **Cron:** `*/5 * * * *` (every 5 minutes)
- Registered in `api/src/index.ts` at server startup via `startEmailPollerCron()`
- Runs in the same Node process as the HTTP API (no separate deploy)

## Manual trigger

`POST /api/poll` runs one pass immediately. Useful for development and when you just want to see if the system is alive.

## Gmail API setup

The poller authenticates as `S.IS_AD_Prod@stewardship.is` via OAuth refresh token.

**Environment variables:**
- `GMAIL_CLIENT_ID` — from the Google Cloud Console OAuth client
- `GMAIL_CLIENT_SECRET` — same
- `GMAIL_REFRESH_TOKEN` — long-lived refresh token issued during first-time OAuth consent
- `GMAIL_MONITORED_EMAIL` — `S.IS_AD_Prod@stewardship.is`

**How the refresh token was obtained:** see `api/scripts/get-gmail-refresh-token.ts`. Procedure:
1. Set up OAuth client in Google Cloud Console (Workspace project), authorize the `gmail.readonly` and `gmail.modify` scopes.
2. Run the script locally — it prints a URL.
3. Visit the URL while logged into `S.IS_AD_Prod@`, click "Allow."
4. Paste the redirected code back into the script. It prints the refresh token.
5. Store the refresh token in Railway env vars.

**Rotation:** if the refresh token is ever revoked or expires, repeat the procedure. Revocation can happen if you change the OAuth scopes or if the token sits idle for too long (rare in normal operation since the poller runs every 5 min).

## What one polling pass does

```
1. Compute watermark = max(received_at) from email_log (per tenant). Fall back to "1 day ago" on cold start.

2. Gmail API: messages.list with query
     `in:inbox after:<watermark>` AND `has:attachment`

3. For each message:
   a. Resolve tenant:
      - Read To: and Cc: headers
      - Find the first address that matches a tenants.email_alias
      - If none match → log and SKIP (this is mail to the inbox that isn't for any tenant)

   b. INSERT into email_log:
        gmail_message_id, sender, subject, received_at, tenant_id, status='processing'
      ON CONFLICT (gmail_message_id, tenant_id) DO NOTHING
      (Idempotent — if we already processed this email, the unique constraint stops a second insert.)

   c. Download attachments:
        messages.get with format='full'; for each part with attachmentId, fetch the bytes

   d. For each attachment:
      i.   Build a ParserContext: { filename, mimeType, fileBytes, sender, lazy pdfText, lazy workbook }
      ii.  Run nonProductionFilters chain:
            - If any filter matches → INSERT non_production_files row, upload bytes to non-production-files bucket, mark this attachment 'ignored'
            - Else → continue to dispatcher
      iii. Run parser dispatcher (see parsers.md):
            - First adapter whose detect() returns true wins
            - If no adapter matches: INSERT flagged_record(reason='unknown_format'); set this email's status = 'failed'
            - If a stub adapter matches: INSERT flagged_record(reason='not_yet_implemented'); status = 'failed'
            - If a real adapter matches: call adapter.parse() → ProductionRecord[]
      iv.  Upload the original attachment to production-files bucket (for audit/replay)
      v.   Call productionStorage.upsertBatch(records, ctx)
            - Resolves well_id (by api10 → name alias → fuzzy)
            - Sets tenant_id
            - UPSERTs into production_monthly OR production_daily

   e. Compute final status for this email_log row:
      - all attachments parsed → 'completed'
      - some parsed, some failed → 'partial'
      - all failed → 'failed'
      - all attachments ignored (non-production) → 'ignored'

   f. UPDATE email_log SET status=?, processing_completed_at=NOW(), error_messages=?

4. (Optional, controlled by config) Mark messages as read via messages.modify with label changes.
```

## What it does NOT do

- **Does not delete emails** from the inbox.
- **Does not modify** the original email body.
- **Does not respond** automatically (the notifications service is a separate concern — it sends alerts to Caleb when a permanent failure happens).

## Failure modes

| Failure | Symptom | Recovery |
|---|---|---|
| Gmail API rate limit | Polling pass logs `Rate limit exceeded`, next_retry_at gets set, retry worker picks up | Automatic — retry worker reschedules with backoff |
| Refresh token revoked | All polling passes fail with `invalid_grant` | Manual — regenerate the refresh token (see above) |
| Supabase DB down | Polling pass logs Supabase 5xx; emails not inserted into email_log | Automatic — next pass re-fetches the same Gmail messages and tries again (Gmail watermark is `received_at`, not "fetched_at") |
| Attachment too large | `partial` status, error message captured | Manual — pull the email manually, parse offline, insert rows directly |

## Watermark logic

The watermark is `MAX(received_at)` from `email_log` per tenant. We use `received_at` instead of `created_at` because:
- `received_at` is the Gmail timestamp — stable across our system's downtime
- `created_at` is when we wrote the row — would skip emails that arrived during downtime

On a cold start (no `email_log` rows at all), the watermark falls back to "24 hours ago" to avoid trying to ingest the entire history of the inbox.

## Backfill / catching up

If the poller was down for a while and you need to catch up beyond the 24-hour cold-start window:
1. Manually set the watermark by inserting a placeholder `email_log` row with the desired `received_at`.
2. Or call `POST /api/poll` repeatedly — each pass advances the watermark by one message at a time.
3. For very long gaps, see [runbooks/gmail-poller-stopped.md](../runbooks/gmail-poller-stopped.md).

## Why we don't use Gmail Pub/Sub push

Caleb's project_instructions list Pub/Sub as an open option ("polling frequency — Every 5 min? 15 min? Hourly? Google Pub/Sub push?"). We chose polling because:
- 5-minute latency is fine for monthly production reports (they arrive once a month).
- Pub/Sub requires a public push endpoint with verification, GCP Pub/Sub topic setup, and IAM grants — overhead that doesn't pay off at our message volume (~130 emails ingested total since launch).
- Polling is debuggable: hit `POST /api/poll` and watch what happens.

**When to revisit:** if real-time delivery becomes a customer requirement (e.g. a SaaS feature where operators want acknowledgment within seconds).
