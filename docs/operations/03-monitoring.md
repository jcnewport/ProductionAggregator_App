# 03 · Monitoring

How to know whether the system is healthy. The app is small enough that "monitoring" today is mostly "look at the dashboard, look at Railway logs, look at Supabase counts." This doc records the routines that catch problems before customers do.

## The four signals that matter

1. **Email poller is alive** — emails are being ingested every 5 minutes
2. **Parsers are succeeding** — `email_log.status` is mostly `completed`, not `failed`/`partial`
3. **Flagged records are not piling up** — `flagged_records` count is near zero
4. **The web app responds** — `/health` returns 200 OK

If any of those is wrong, something needs human attention.

## Daily 2-minute check

(Adapted from `STABILIZATION_PLAYBOOK.md`.)

1. Open `productionaggregator.stewardship.is/dashboard`
2. Look at the LIVE indicator in the top bar — should be pulsing
3. Look at the recent email log section — should show new entries with status `completed`
4. Look at the flagged records section — should show 0 or a small number with reasons you recognize
5. If anything is off, dig in.

Total: 2 minutes.

## Weekly 10-minute check

1. **Generate an export for the last month.** Pick a date range, click Generate & Download, open the file in Excel.
   - Row count matches roughly what you'd expect
   - Spot-check 3 random wells against the operator's original report
   - Date format is M/D/YYYY
   - Negative values present (if any exist for the range)
2. **Review the email log on the dashboard** for the past 7 days. Anything not `completed`/`ignored`? Investigate.
3. **Pick one random well.** Run:
   ```sql
   SELECT prod_date, oil_prod, gas_prod, water_prod, source_file_name
   FROM production_monthly
   WHERE well_name ILIKE '%<part-of-name>%'
   ORDER BY prod_date DESC LIMIT 12;
   ```
   Look for gaps in dates, suspicious zeros, or duplicate entries.

## What "healthy" looks like — live metrics

(Numbers as of 2026-05-19, single-tenant operation.)

| Metric | Healthy range | Where to check |
|---|---|---|
| Recent emails processed (last 7 days) | 5–30 | Dashboard recent activity, or `SELECT COUNT(*) FROM email_log WHERE received_at > NOW() - INTERVAL '7 days'` |
| Email status mix | `completed` dominant | `SELECT status, COUNT(*) FROM email_log WHERE received_at > NOW() - INTERVAL '7 days' GROUP BY 1` |
| Flagged records (open / not resolved) | 0–5 | Dashboard, or `SELECT COUNT(*) FROM flagged_records WHERE created_at > NOW() - INTERVAL '7 days'` |
| Production rows growing | New rows visible in `production_monthly`, `production_daily` | `SELECT MAX(created_at) FROM production_monthly` |
| `/health` endpoint | 200 OK | `curl productionaggregator.stewardship.is/health` |
| Railway service status | Green dot, no recent restarts | Railway dashboard |

## What "unhealthy" looks like — paging signals

These should trigger immediate investigation:

| Signal | Likely cause | First step |
|---|---|---|
| `email_log` rows haven't grown in > 30 min during a known operator's send-window | Poller is stuck or Gmail auth is broken | [runbooks/gmail-poller-stopped.md](../runbooks/gmail-poller-stopped.md) |
| One operator's emails consistently end up `failed` | Operator changed their format | [runbooks/parser-failing.md](../runbooks/parser-failing.md) |
| `flagged_records` count jumped overnight | Either new format arrived OR existing parser is misrouting | [runbooks/flagged-records-buildup.md](../runbooks/flagged-records-buildup.md) |
| `/health` returns 5xx or times out | Railway service crashed | Railway dashboard → Logs |
| Export endpoint returns 0 rows when it shouldn't | RLS bug or missing tenant_id in JWT | [frontend/02-auth-and-tenants.md](../frontend/02-auth-and-tenants.md#what-to-do-if-a-user-cant-log-in) |

## Logs

### Railway logs

- Railway dashboard → `ProductionAggregator_App` → Logs tab
- Live tail by default. Use the filter to search.
- Cron logs are interleaved with HTTP request logs. Look for `[email-poller]` or `[retry-worker]` prefixes.

### Supabase logs

- Supabase dashboard → Logs → choose `Postgres` or `API`
- Useful for tracking slow queries, RLS denials, and PostgREST errors
- 24-hour retention on free tier; 7-day on Pro

### Gmail audit log

- Google Workspace Admin Console → Reports → Email Log Search
- Filter by recipient `S.IS_AD_Prod@stewardship.is` or by sender
- Useful when you suspect a message was sent but never made it into our poller

## Alerts (current state)

There are **no automated alerts** today. The notifications service (`api/src/services/notifications.ts`) sends an email to Caleb when an email_log row hits permanent failure (retry_count >= max_retries with is_retryable=true), but nothing pings him for the broader signals listed above.

**Backlog item:** wire a daily digest email that summarizes the four signals — see `notifications.ts` for the existing email-sending plumbing.

## Why we're not doing more

The app is in a stabilization period (see `STABILIZATION_PLAYBOOK.md`). The goal is to *catch edge cases that only production shows*, not to ship more features. Adding observability infrastructure (Datadog, Sentry, etc.) is on the deferred list until traffic justifies the cost and learning curve.

## What to do during a sustained issue

1. Read the relevant runbook
2. If the runbook doesn't cover it, document what you find as you fix it — that becomes a new runbook section
3. Resist the urge to "just rebuild it cleaner" — make the smallest change that resolves the issue, push, verify, then revisit
