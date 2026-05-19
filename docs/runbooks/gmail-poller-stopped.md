# Runbook · Gmail Poller Stopped

**Symptom:** `email_log` hasn't gained new rows in > 30 minutes during a known operator's send-window. The LIVE indicator may still be pulsing (it doesn't actually monitor the poller).

## Step 1 · Confirm the symptom

```sql
SELECT MAX(received_at), MAX(created_at) FROM email_log;
```

If `MAX(received_at)` is well in the past AND you have reason to believe new emails should have arrived, the poller is stuck.

## Step 2 · Check Railway logs

Railway dashboard → `ProductionAggregator_App` → Logs.

Look for any of these recent log lines:
- `[email-poller] starting pass`
- `[email-poller] error:`
- `invalid_grant`
- `RATE_LIMIT_EXCEEDED`
- `ECONNREFUSED` to googleapis

The pass should fire every 5 minutes. If you don't see any `[email-poller]` lines in the last 10 minutes, the cron itself isn't firing → likely a Railway service issue.

## Step 3 · If `invalid_grant`

The Gmail OAuth refresh token is dead. Regenerate it.

1. Locally, with your Google Workspace creds for `S.IS_AD_Prod@stewardship.is`:
   ```bash
   cd api
   npx tsx scripts/get-gmail-refresh-token.ts
   ```
2. The script prints a URL. Open it, sign in as `S.IS_AD_Prod@`, approve the scopes.
3. Paste the redirected code back into the script. It prints the new refresh token.
4. Railway dashboard → Variables → update `GMAIL_REFRESH_TOKEN`
5. Trigger a redeploy (Railway → Restart, or push an empty commit)
6. Verify: hit `POST /api/poll` and check logs

## Step 4 · If `RATE_LIMIT_EXCEEDED`

Gmail's quotas: 250 quota units/user/second, 1B quota units/day. We're nowhere near these. Hitting rate limits means a runaway loop somewhere.

Action:
1. Restart the Railway service (this kills the runaway in-process state)
2. Check logs for what was happening just before the rate limit hit
3. If it recurs, narrow it down to a specific email_log id and run `/api/admin/reprocess-email` manually instead of letting the poller retry

## Step 5 · If the cron is not firing at all

Railway service might have crashed silently.

1. Hit `productionaggregator.stewardship.is/health` — should return JSON. If timeout, service is down.
2. Railway dashboard → service → Restart
3. Watch logs for startup sequence:
   - `Server listening on port 3001` (or 3000)
   - `[email-poller] cron registered`
   - `[retry-worker] cron registered`
4. If any of those are missing, something in `api/src/index.ts` is throwing on startup. Look for the stack trace in logs.

## Step 6 · If the cron is firing but no messages

Poller is running, Gmail API is happy, but no new emails are showing up.

Possibilities:
- Operators genuinely sent nothing in this window (check Gmail directly: log in to `S.IS_AD_Prod@`, look at the inbox)
- The `To:` header doesn't match any `tenants.email_alias` → poller skips with a log line. Check: `SELECT email_alias FROM tenants;` — does the recipient match any?
- The watermark logic is stuck. Check: `SELECT MAX(received_at) FROM email_log` — has it advanced this hour?

## Step 7 · Backfill after extended downtime

If the poller was down for > 24 hours, the cold-start watermark won't reach back far enough to catch up.

```sql
-- Manually set the watermark by inserting a placeholder
INSERT INTO email_log (gmail_message_id, sender, received_at, tenant_id, status)
VALUES ('placeholder-' || gen_random_uuid(), 'placeholder@stewardship.is',
        '2026-05-15 00:00:00+00',  -- the date you want to start from
        '<tenant_uuid>', 'ignored');
```

Then trigger a poll: `POST /api/poll`.

## When the poller stops being the problem

If logs are clean and emails ARE arriving but downstream parsing is failing, that's a different problem — see [parser-failing.md](parser-failing.md).
