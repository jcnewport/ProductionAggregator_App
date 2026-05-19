# 04 · Data Handling Rules — Monthly vs Daily vs Weekly

## The single most important rule

> **Daily production data is NEVER rolled up into monthly.**
> **Weekly production data is NEVER rolled up into monthly.**
> Monthly data comes from operator monthly production statements. Period.

This is a domain constraint, not a tech preference. Reasoning is in [architecture/04-decisions.md](../architecture/04-decisions.md#why-daily-and-monthly-production-live-in-separate-tables).

## Three buckets

| Type | Priority | Where it lands | How it's exported |
|---|---|---|---|
| **Monthly production reports** | Primary | `production_monthly` (one row per well per month) | `/api/export/monthly` |
| **Daily production reports** | Secondary (FYI / detail) | `production_daily` (one row per well per day) | `/api/export/daily` |
| **Weekly production reports** | Edge case | `production_daily` — divided by 7 (or actual day count) and stored as daily rows on the corresponding dates | `/api/export/daily` |

## Why daily ≠ rolled-up monthly

If you SUM(oil_prod) over a month's worth of daily rows, you will get a number that is **close to but not equal to** the operator's monthly report for the same well/month. Reasons:

1. **Allocation true-ups.** Multi-well leases redistribute production at month-end based on tank gauges and metering. Daily allocations are estimates; monthly is the reconciled truth.
2. **BS&W corrections.** Daily reports show raw wellhead numbers; monthly reports include after-the-fact water content corrections.
3. **Tank lag.** A daily report covers what was produced by 24:00 that day; the monthly statement reflects when oil was sold from the tank, which may be days later.
4. **Operator policy.** Some operators publish daily only for the first 2 years of well life (Mewbourne explicitly states this in their footer), so a sum of dailies for older wells would be incomplete.

**For reserves accounting** (ComboCurve's purpose), the operator's monthly statement is the official number. Daily data is operational color, not financial truth.

## Weekly handling

Some smaller operators send weekly summaries (rare, but they exist). Rules:

1. **Divide by 7** (or by the explicit day count if provided in the report). For a 7-day report covering `2026-03-15` through `2026-03-21`:
   - `oil_prod / 7` becomes the daily value
2. **Insert as 7 daily rows** in `production_daily`, one per day in the range.
3. **Never insert as a single monthly row.**

If a weekly report covers fewer than 7 days (e.g., a partial week at month-start), use the actual day count as the divisor.

## "Same well, same date, two reports" — precedence

Sometimes the same well appears in two different reports for the same date. Examples:
- Aftermath CSV daily + ConocoPhillips PDS PDF daily (both cover the same wells)
- An operator sends a re-issued monthly report after correcting an error

**Rule:** newer-arrived data overwrites older-arrived data, scoped by `(well_id, prod_date)`. The unique constraints in the DB enforce this:
- `production_monthly UNIQUE (well_id, prod_date)` — upsert overwrites
- `production_daily UNIQUE (well_id, prod_date)` — upsert overwrites

**Exception:** the **Aftermath rule.** Aftermath CSV is the authoritative source for ConocoPhillips/Concho wells. If both arrive, the parser dispatcher gives Aftermath precedence. See [backend/02-parsers.md](../backend/02-parsers.md#precedence-and-the-aftermath-rule).

## What gets flagged vs. silently failed

There is **no silent failure path.** Every row that can't be normalized produces a `flagged_records` entry with `reason` describing why.

| Situation | Outcome |
|---|---|
| Unknown file format (no adapter matched) | `email_log.status = 'failed'`, no flagged_records |
| Adapter matched but extraction failed mid-file | `email_log.status = 'partial'`, each failed row → flagged_records |
| Row extracted but no well could be resolved | flagged_records (reason = `unresolvable_well`) |
| Row extracted, well resolved, but date couldn't be parsed | flagged_records (reason = `bad_date`) |
| Row extracted, well resolved, but ALL volumes are null | flagged_records (reason = `no_data`) — possibly intentional, review |
| Row extracted, well resolved, dates OK, volumes OK | upsert to production_monthly or production_daily |

See `api/src/services/productionStorage.ts` for the implementation.

## Idempotency

The system is designed to be **safely re-runnable.** If an email is re-processed (manual replay, retry-worker pickup, redeploy mid-flight), the result is the same:

- `email_log` is keyed on `gmail_message_id` — duplicate inserts are no-ops
- `production_monthly` and `production_daily` UPSERT on `(well_id, prod_date)` — re-processing overwrites with identical data
- `flagged_records` may produce duplicate rows on re-process; dedup is done client-side when displaying

If you need to clear and re-ingest a single email's data, see [runbooks/parser-failing.md](../runbooks/parser-failing.md#wiping-and-reprocessing-one-email).
