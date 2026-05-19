# 04 · Migrations

How database migrations work in this repo. There are TWO migration directories — read this whole file before adding one.

## The two directories

| Path | Purpose | Numbering |
|---|---|---|
| **`supabase/migrations/`** | Core schema, RLS, RPCs, and post-launch additions | `001_` to `004_` so far |
| **`api/migrations/`** | Multi-tenancy migrations applied during the Phase-3 tenancy rollout | `0001_` to `0004_` |

**This is a foot-gun.** The dual layout is a historical artifact from when the multi-tenancy rollout was a separate workstream. We have not consolidated.

**Rule of thumb when adding a new migration:**
- Schema changes, indexes, RPCs, RLS policies, new tables → `supabase/migrations/` with the next `00X_` number
- Anything touching tenancy primitives (the `tenants` / `user_tenants` tables, the `current_tenant_id()` / `is_super_admin()` functions) → still go in `supabase/migrations/`. Do NOT add to `api/migrations/` anymore — that directory is treated as historical / archive.

When in doubt, add to `supabase/migrations/`.

## Current migration ledger

### `supabase/migrations/`

| # | File | What it does |
|---|---|---|
| 001 | `001_create_core_tables.sql` | Initial schema — operators, wells, well_name_aliases, production_monthly, production_daily, email_log, format_mappings, exports |
| 002 | `002_setup_rls_and_storage.sql` | Enables RLS, creates initial policies, creates Storage buckets |
| 003 | `003_non_production_files.sql` | Adds `non_production_files` table + storage bucket for filtered attachments |
| 004 | `004_monthly_production_totals_rpc.sql` | Adds the `monthly_production_totals()` RPC for the export-page overview chart |

### `api/migrations/`

| # | File | What it does |
|---|---|---|
| 0001 | `0001_multitenancy_phase1.sql` | Adds `tenants`, `user_tenants` tables; adds `tenant_id` columns to all data tables; backfills tenant_id |
| 0002 | `0002_multitenancy_phase2_rls.sql` | Adds the `tenant_isolation` RLS policies, `current_tenant_id()`, `is_super_admin()` functions |
| 0003 | `0003_multitenancy_phase2_drop_legacy_policies.sql` | Removes the old single-tenant RLS policies that the previous schema had |
| 0004 | `0004_multitenancy_phase3_unique_constraints.sql` | Adds composite unique constraints `(tenant_id, well_id, prod_date)` etc. |

## How migrations are applied

There is **no automated migration runner**. The flow is manual:

1. Write the SQL in a new migration file in the appropriate directory.
2. Apply to the Supabase project either via:
   - The Supabase dashboard SQL editor (paste the file), OR
   - The Supabase MCP (`mcp__supabase__apply_migration`) when working through Cowork.
3. Commit the migration file to the repo so the history is captured.

**Important:** **the migration file is the record. The Supabase project is the live state.** They must stay in sync. If you apply something to Supabase that isn't in the repo, you've broken the "the repo is canonical" invariant.

## How to verify the live state matches the repo

```sql
-- List all functions in public schema (compare against rpc-functions.md)
SELECT proname, pg_get_function_identity_arguments(oid)
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
ORDER BY proname;

-- List all RLS policies (compare against rls-and-tenancy.md)
SELECT schemaname, tablename, policyname, cmd, pg_get_expr(polqual, polrelid) AS using_expr
FROM pg_policies WHERE schemaname = 'public'
ORDER BY tablename, policyname;

-- List all tables (compare against schema.md)
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' ORDER BY table_name;
```

If any of these return something the repo doesn't have, either:
- The Supabase project drifted (someone applied SQL outside the migration system) — capture it as a new migration file and commit
- The repo is missing a documented migration — investigate via `git log` on `supabase/migrations/` and `api/migrations/`

## Adding a new migration: recipe

1. **Pick the next number.** Look at `ls supabase/migrations/ | sort -n | tail -1`. Increment by 1.
2. **Name it descriptively.** `005_add_well_basin_column.sql` is good; `005_changes.sql` is not.
3. **Write idempotent SQL.** Use `CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, `ADD COLUMN IF NOT EXISTS`. This protects against the case where someone partially applied the migration manually before merging.
4. **Include a header comment** with the date, the purpose, and any caveats. Pattern:

```sql
-- ============================================================
-- Migration 005: Add basin column to wells
-- Applied: 2026-MM-DD
--
-- Purpose:
--   Track which basin (Permian, Eagle Ford, etc.) each well sits in.
--   Used for the new basin-filter on the Daily Export page.
--
-- Risk: very low (additive column with NULL default).
-- Rollback: ALTER TABLE wells DROP COLUMN basin;
-- ============================================================

ALTER TABLE wells
  ADD COLUMN IF NOT EXISTS basin text;

CREATE INDEX IF NOT EXISTS idx_wells_basin ON wells(basin);
```

5. **Apply via Supabase dashboard or MCP.**
6. **Verify** with one of the queries above.
7. **Commit and push.** Railway redeploys; the application code referencing the new column or function should already be on the same commit.

## What to do when a migration is wrong

You have two options:

1. **Forward-fix.** Write a new migration that corrects the previous one. Cleaner long-term; preserves history.
2. **Revert.** Only safe if no production data depends on the migration. Drop the artifacts manually in Supabase, then `git revert` the commit.

**Never** edit an applied migration file in place. The repo would say one thing; the database would have another. Lying file = chaos.
