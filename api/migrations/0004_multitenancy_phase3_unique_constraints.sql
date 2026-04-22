-- ============================================================================
-- Multi-Tenancy — Phase 3 prep: Tenant-scope unique constraints
-- ============================================================================
-- Purpose:
--   Before Phase 3 (alias routing + tenant stamping) can go live, two unique
--   constraints need to become tenant-scoped:
--
--     • public.wells.api10           — currently GLOBAL UNIQUE
--     • public.well_name_aliases.alias — currently GLOBAL UNIQUE
--
--   With the old globals in place, a second tenant that happened to have the
--   same physical well (same API10) would collide on upsert — even though
--   Caleb's design (locked in 2026-04-22) is that each tenant owns its own
--   scoped copy of a well. Same for aliases.
--
-- What changes here:
--   • Drop unique(api10)           → create unique(tenant_id, api10).
--   • Drop unique(alias)           → create unique(tenant_id, alias).
--
-- Safety:
--   All existing rows belong to the seed Frio tenant (per Phase 1 backfill),
--   so there is zero chance of a duplicate-detection error during this
--   migration. The new indexes are a strict superset of the old — any pair
--   that was globally unique is still unique within its (single) tenant.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- wells.api10  →  (tenant_id, api10)
-- ---------------------------------------------------------------------------
ALTER TABLE public.wells DROP CONSTRAINT IF EXISTS unique_api10;

ALTER TABLE public.wells
  ADD CONSTRAINT wells_tenant_api10_unique UNIQUE (tenant_id, api10);

-- Helpful lookup index if we ever want to find "the Frio copy of api10 X"
-- without specifying the tenant in code — Postgres automatically adds the
-- unique index for the constraint above, but a standalone tenant_id index
-- is also worth keeping for filtered scans.
CREATE INDEX IF NOT EXISTS idx_wells_tenant_id ON public.wells(tenant_id);

-- ---------------------------------------------------------------------------
-- well_name_aliases.alias  →  (tenant_id, alias)
-- ---------------------------------------------------------------------------
ALTER TABLE public.well_name_aliases DROP CONSTRAINT IF EXISTS unique_alias;

ALTER TABLE public.well_name_aliases
  ADD CONSTRAINT well_name_aliases_tenant_alias_unique UNIQUE (tenant_id, alias);

CREATE INDEX IF NOT EXISTS idx_well_name_aliases_tenant_id
  ON public.well_name_aliases(tenant_id);

COMMIT;
