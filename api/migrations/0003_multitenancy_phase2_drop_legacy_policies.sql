-- ============================================================================
-- Multi-Tenancy — Phase 2 follow-up: Drop legacy permissive RLS policies
-- ============================================================================
-- Purpose:
--   Phase 2 enabled tenant_isolation policies, but every tenant-scoped table
--   already had a pre-existing "Authenticated users can read <table>" SELECT
--   policy with `USING (true)`. Postgres OR's multiple permissive policies
--   together — so those legacy policies defeated tenant_isolation entirely:
--   any authenticated user saw every tenant's rows.
--
--   The exports table also had an older INSERT/SELECT pair that pre-dated
--   tenant scoping. Operators had a duplicate SELECT policy. All removed.
--
-- Post-condition:
--   • Only `tenant_isolation` (and super-admin write) remain on the 8
--     tenant-scoped tables.
--   • operators retains `operators_read_all` (shared reference data) +
--     `operators_super_admin_write`.
--   • Smoke test: simulated authenticated user with no user_tenants row sees
--     0 rows across the board. Caleb (super_admin) sees full counts.
-- ============================================================================

BEGIN;

-- Exports legacy pair
DROP POLICY IF EXISTS "Authenticated users can create own exports" ON public.exports;
DROP POLICY IF EXISTS "Authenticated users can read exports"       ON public.exports;

-- Operators duplicate SELECT
DROP POLICY IF EXISTS "Authenticated users can read operators" ON public.operators;

-- The 7 legacy "read all" SELECT policies on tenant-scoped tables
DROP POLICY IF EXISTS "Authenticated users can read email_log"           ON public.email_log;
DROP POLICY IF EXISTS "Authenticated users can read flagged_records"    ON public.flagged_records;
DROP POLICY IF EXISTS "Authenticated users can read format_mappings"    ON public.format_mappings;
DROP POLICY IF EXISTS "Authenticated users can read production_daily"   ON public.production_daily;
DROP POLICY IF EXISTS "Authenticated users can read production_monthly" ON public.production_monthly;
DROP POLICY IF EXISTS "Authenticated users can read well_name_aliases"  ON public.well_name_aliases;
DROP POLICY IF EXISTS "Authenticated users can read wells"              ON public.wells;

COMMIT;
