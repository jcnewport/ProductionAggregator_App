# 04 · Architectural Decisions

A record of non-obvious choices, so a future maintainer doesn't waste cycles re-litigating them. Each item: **what we chose**, **why**, and **when we'd revisit**.

## Why Railway, not Vercel

**Decision:** All backend code runs on Railway. The frontend is built and served by the same Railway service (Express static-serves the Vite `dist/` directory in production).

**Why:**
- Operator monthly statements can be 100+ MB PDFs. Vercel's serverless function payload limit (4.5 MB request body, 5 MB response on Hobby; ~50 MB on Pro) makes file streaming awkward.
- Vercel's function timeout caps at 60s on Hobby, 900s on Pro Edge. A bulk historical import can run for several minutes.
- node-cron must run in a long-lived process. Vercel Cron is fine for triggering an HTTP endpoint, but the endpoint itself would still hit timeout.

**When to revisit:** if traffic patterns change (parsing moved to a queued background job, etc.) and the bulk of HTTP routes become quick.

## Why Supabase, not RDS / Neon / PlanetScale

**Decision:** Postgres lives on Supabase.

**Why:**
- Auth + DB + Storage in one place. Onboarding a new tenant means inviting a user via Supabase Auth, no separate identity provider.
- RLS is first-class. We rely on it heavily for multi-tenant isolation. RLS in Postgres is just Postgres; there is no Supabase lock-in here.
- PostgREST gives the React app a typed REST API for the boring read/write paths for free.

**When to revisit:** if Supabase pricing becomes uneconomic at scale (multi-tenant data growth pushing storage costs). Migration to self-hosted Postgres is straightforward because we use raw SQL migrations and standard `@supabase/supabase-js` (which works against any Postgres + PostgREST).

## Why one Node process, not a worker fleet

**Decision:** HTTP API, email poller cron, and retry worker cron all live in the same Node process (`api/src/index.ts`).

**Why:**
- Two services = two Railway deploys = two sets of env vars = two log streams. The current system is small enough that this overhead is real.
- node-cron is reliable in-process. The cron callbacks are idempotent (every job checks "did I already do this for this email/message id?" via `email_log.gmail_message_id`).
- Pollers running in the same memory space as the HTTP API means hot code reloads pick them up too.

**When to revisit:**
- If polling starts impacting HTTP response times (CPU contention).
- If we add a second tenant that wants its own polling cadence.
- If retry-worker work gets heavy enough that it deserves backpressure.

## Why raw SQL migrations, not Supabase CLI / dbmate / sqitch

**Decision:** Migrations are plain `.sql` files in two directories:
- `supabase/migrations/` — original schema and the post-launch additions
- `api/migrations/` — multi-tenancy migrations (added during the Phase-3 tenancy rollout)

**Why:**
- Tooling-agnostic. Any Postgres client can apply them.
- No lock-in to a specific migration framework.
- Easy to read in PRs.

**The cost:** there are TWO migration directories, which is a foot-gun. Always check both when applying changes. See [database/04-migrations.md](../database/04-migrations.md).

**When to revisit:** if we hit migration ordering bugs that the dual-directory layout caused. The fix is to consolidate into one directory and renumber — straightforward but a one-day chore.

## Why parsers live in TypeScript, not in `format_mappings` JSON

**Decision:** Every operator format has its own `.ts` file in `api/src/parsers/`, plus a registry entry. The `format_mappings` table exists but is unused for now.

**Why:**
- Each operator format has quirks that don't fit a generic JSON schema cleanly (hierarchical row structures, multi-sheet workbooks, compound well-site fields, scientific-notation IDs, negative production values, …). Coding them in TypeScript gives us the full language to handle each quirk.
- The dispatcher (`parsers/registry.ts`) supports both code-based adapters and "stub" adapters that detect but don't yet parse — useful when we know a format exists but haven't built the parser.
- A `format_mappings`-table-driven approach is described in `parsers/dataDriven/` as a partial sketch. The plan is to migrate the *simple* formats (Aftermath CSV, Arlo XLSX) to data-driven once the rough edges of the data-driven engine are proven.

**When to revisit:** when adding the 25th operator. The breakeven point is somewhere between 10–20 parsers — at that count, configuration-driven parsers start saving more time than they cost in flexibility.

## Why daily and monthly production live in separate tables

**Decision:** Two tables, `production_monthly` and `production_daily`. We never roll daily up into monthly.

**Why:**
- Per the project's domain rules: operators publish their own monthly statements (computed differently from a daily sum — they include adjustments, true-ups, allocation changes). Rolling up daily to monthly would produce a *different* number from what the operator reports as "monthly," which is the source of truth for ComboCurve reserves accounting.
- Weekly reports are divided by 7 (or actual day count) and stored as daily — never as monthly — for the same reason.

**When to revisit:** never. This is a domain constraint, not a tech decision.

## Why we store API10 as TEXT, not BIGINT

**Decision:** `production_monthly.api10` and `production_daily.api10` are `TEXT`. Same for `wells.api10`.

**Why:**
- API numbers have leading zeros (`"0422301368"`). BIGINT would lose them.
- Some operators send 8-digit, 10-digit, 12-digit, or 14-digit API numbers. Normalizing all to a 10-digit string (left-padded with zeros when needed) is the cleanest representation.

**When to revisit:** never.

## Why the chart is inline SVG, not Recharts

**Decision:** The Monthly Production Overview chart on `/export/monthly` is hand-rolled inline SVG.

**Why:**
- Recharts is ~150 KB minified. Our entire JS bundle is 432 KB total — a chart library would be a third of that just for two charts.
- The chart's behavior (three small bar charts side-by-side, hover tooltip, no zoom/pan) is simple enough to render in ~250 lines.
- Matches the existing inline-SVG sparkline pattern on the Dashboard.

**When to revisit:** if we add a 4th or 5th distinct chart on the app. At that point a library starts paying for itself.

## Why super-admin uses an `is_super_admin` boolean on `user_tenants`, not a separate role table

**Decision:** `user_tenants.is_super_admin` is a per-user flag. A super-admin has it set to `true` for their primary tenant; the `is_super_admin()` Postgres function checks the current user's row.

**Why:**
- We have one super-admin (Caleb). YAGNI on a full role/permission system.
- Most policies are of the form `(is_super_admin() OR tenant_id = current_tenant_id())`, which is readable and easy to audit.

**When to revisit:** when we have 3+ super-admins, or when we want a finer-grained role (e.g. "read-only super-admin"). At that point introduce a `roles` table and migrate.

## Why we ignore certain file types instead of erroring on them

**Decision:** `nonProductionFilters.ts` proactively classifies a set of file patterns as `non-production` (drilling reports, the ComboCurve template echo, well-tracking spreadsheets, ConocoPhillips workover reports) and routes them to the `non_production_files` table + bucket. They never hit the parser dispatcher.

**Why:**
- Operators copy a wide audience on production reports. We were getting drilling AFEs, lease operating statements, and well-tracking summaries flagged as "unknown format," cluttering the flagged-records queue.
- A categorical filter is much cheaper to add than a parser stub for every non-production document type.

**When to revisit:** if a non-production filter starts matching legitimate production data. Diagnose by reviewing `non_production_files` rows manually.
