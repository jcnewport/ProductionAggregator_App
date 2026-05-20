-- ============================================================================
-- Multi-Tenancy — Phase 1: Schema + Backfill
-- ============================================================================
-- Purpose:
--   Introduce per-tenant data isolation by adding a `tenants` table and
--   stamping every existing row in the 8 tenant-scoped tables with the
--   tenant_id of the initial tenant ("Frio Energy Holdings").
--
-- What this migration does NOT do:
--   • No RLS policies (those land in Phase 2).
--   • No parser changes — ingests keep working exactly as-is; every new row
--     stamps with the Frio tenant_id because it's the only one that exists.
--   • No auth changes — Caleb (super-admin) still sees everything because
--     RLS isn't active yet.
--
-- Tables touched (8 tenant-scoped + 1 new):
--   NEW:           tenants
--   ALTER:         wells, production_daily, production_monthly,
--                  email_log, exports, flagged_records,
--                  well_name_aliases, format_mappings
--
-- Operators are NOT tenant-scoped — they're shared reference data (same OXY,
-- EOG, Mewbourne entities reported to multiple clients).
--
-- Baseline row counts at migration time (2026-04-22):
--     wells               493
--     production_daily    47,574
--     production_monthly  1,870
--     email_log           30
--     exports             2
--     flagged_records     154
--     well_name_aliases   46
--     format_mappings     0
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Create tenants table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tenants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL UNIQUE,
  name          text NOT NULL,
  email_alias   text NOT NULL UNIQUE,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  notes         text
);

COMMENT ON TABLE  public.tenants             IS 'Client companies using the production aggregator. Each tenant has isolated data via tenant_id columns on scoped tables.';
COMMENT ON COLUMN public.tenants.slug        IS 'Internal short identifier (lowercase, no spaces). Used in email alias: s.is_<slug>_prod@stewardship.is.';
COMMENT ON COLUMN public.tenants.email_alias IS 'The inbound Gmail address for this tenants production reports. Router reads To: header to determine tenant_id.';
COMMENT ON COLUMN public.tenants.is_active   IS 'Kill switch. When false, the tenants email is ignored and their users cannot log in.';

-- ---------------------------------------------------------------------------
-- 2. Seed the first tenant: Frio Energy Holdings
-- ---------------------------------------------------------------------------
-- Historically this migration seeded a "Frio Energy Holdings" tenant
-- so the live system had something to attach the multi-tenancy backfill
-- to. That seed is preserved (default) for re-applies against the
-- original Stewardship.IS deployment.
--
-- FOR A FRESH INSTALL FOR A DIFFERENT CUSTOMER:
--   Set the Postgres setting `pa.bootstrap_frio` to 'false' BEFORE
--   running this migration:
--     SET pa.bootstrap_frio = 'false';
--     \i 0001_multitenancy_phase1.sql
--   Then use api/scripts/bootstrap-first-tenant.ts to create your
--   real first tenant.
--
-- The backfill in step 4 below grabs whatever tenant exists; if no
-- tenant exists at that point (because you skipped the Frio seed AND
-- haven't bootstrapped your own yet), the migration still runs but
-- the backfill is a no-op (no rows to backfill on a fresh install).
DO $$
BEGIN
  IF COALESCE(current_setting('pa.bootstrap_frio', true), 'true') <> 'false' THEN
    INSERT INTO public.tenants (slug, name, email_alias, is_active, notes)
    VALUES (
      'frio',
      'Frio Energy Holdings',
      's.is_ad_prod@stewardship.is',
      true,
      'Initial tenant; all data ingested before 2026-04-22 belongs here. Keeps the original ingestion alias for backwards compatibility.'
    )
    ON CONFLICT (slug) DO NOTHING;
  ELSE
    RAISE NOTICE 'Skipping Frio tenant seed (pa.bootstrap_frio is false).';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Add tenant_id columns (nullable at first so we can backfill)
-- ---------------------------------------------------------------------------
ALTER TABLE public.wells              ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenants(id) ON DELETE RESTRICT;
ALTER TABLE public.production_daily   ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenants(id) ON DELETE RESTRICT;
ALTER TABLE public.production_monthly ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenants(id) ON DELETE RESTRICT;
ALTER TABLE public.email_log          ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenants(id) ON DELETE RESTRICT;
ALTER TABLE public.exports            ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenants(id) ON DELETE RESTRICT;
ALTER TABLE public.flagged_records    ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenants(id) ON DELETE RESTRICT;
ALTER TABLE public.well_name_aliases  ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenants(id) ON DELETE RESTRICT;
ALTER TABLE public.format_mappings    ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenants(id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- 4. Backfill — every existing row belongs to Frio
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_frio uuid;
BEGIN
  SELECT id INTO v_frio FROM public.tenants WHERE slug = 'frio';
  IF v_frio IS NULL THEN
    RAISE EXCEPTION 'Frio tenant row missing — cannot backfill';
  END IF;

  UPDATE public.wells              SET tenant_id = v_frio WHERE tenant_id IS NULL;
  UPDATE public.production_daily   SET tenant_id = v_frio WHERE tenant_id IS NULL;
  UPDATE public.production_monthly SET tenant_id = v_frio WHERE tenant_id IS NULL;
  UPDATE public.email_log          SET tenant_id = v_frio WHERE tenant_id IS NULL;
  UPDATE public.exports            SET tenant_id = v_frio WHERE tenant_id IS NULL;
  UPDATE public.flagged_records    SET tenant_id = v_frio WHERE tenant_id IS NULL;
  UPDATE public.well_name_aliases  SET tenant_id = v_frio WHERE tenant_id IS NULL;
  UPDATE public.format_mappings    SET tenant_id = v_frio WHERE tenant_id IS NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Lock it down: NOT NULL + indexes on tenant_id for read perf
-- ---------------------------------------------------------------------------
ALTER TABLE public.wells              ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE public.production_daily   ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE public.production_monthly ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE public.email_log          ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE public.exports            ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE public.flagged_records    ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE public.well_name_aliases  ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE public.format_mappings    ALTER COLUMN tenant_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wells_tenant_id              ON public.wells(tenant_id);
CREATE INDEX IF NOT EXISTS idx_production_daily_tenant_id   ON public.production_daily(tenant_id);
CREATE INDEX IF NOT EXISTS idx_production_monthly_tenant_id ON public.production_monthly(tenant_id);
CREATE INDEX IF NOT EXISTS idx_email_log_tenant_id          ON public.email_log(tenant_id);
CREATE INDEX IF NOT EXISTS idx_exports_tenant_id            ON public.exports(tenant_id);
CREATE INDEX IF NOT EXISTS idx_flagged_records_tenant_id    ON public.flagged_records(tenant_id);
CREATE INDEX IF NOT EXISTS idx_well_name_aliases_tenant_id  ON public.well_name_aliases(tenant_id);
CREATE INDEX IF NOT EXISTS idx_format_mappings_tenant_id    ON public.format_mappings(tenant_id);

COMMIT;
