-- ============================================================================
-- Multi-Tenancy — Phase 2: Row-Level Security + Super-Admin
-- ============================================================================
-- Purpose:
--   Enforce tenant isolation at the database level. After this migration, any
--   authenticated user hitting Supabase directly (browser client) only sees
--   rows where tenant_id matches their tenant. Super-admins bypass.
--
-- The service_role key used by our Railway backend bypasses RLS by Supabase
-- default, so parsers, cron jobs, and /api/* routes continue to work unchanged.
-- Only direct-from-browser queries (operator dropdown, dashboard counts) feel
-- RLS.
--
-- What this migration adds:
--   • user_tenants  — maps auth.users.id → tenants.id + is_super_admin flag
--   • current_tenant_id()  — SECURITY DEFINER helper used in policies
--   • is_super_admin()     — SECURITY DEFINER helper used in policies
--   • RLS policies on 10 tables (8 tenant-scoped + tenants + operators)
--   • user_tenants row for Caleb (super_admin=true) so Dashboard/ExportPanel
--     keep showing all rows after RLS goes live.
--
-- What this migration does NOT do:
--   • No parser changes — parsers still write via service_role (bypasses RLS).
--   • No backend route changes — /api/* routes still use service_role.
--   • No frontend changes — Dashboard/ExportPanel direct queries still work
--     because Caleb is flagged super_admin.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. user_tenants: the "who belongs to which tenant" mapping
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_tenants (
  user_id        uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id      uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  is_super_admin boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_tenants_tenant_id ON public.user_tenants(tenant_id);

COMMENT ON TABLE  public.user_tenants                IS 'Links each auth.users row to exactly one tenant. is_super_admin users bypass all tenant scoping.';
COMMENT ON COLUMN public.user_tenants.is_super_admin IS 'When true, RLS policies allow reading/writing any tenants data. Reserved for Caleb and future S.IS staff.';

-- ---------------------------------------------------------------------------
-- 2. Helper functions used by every RLS policy
--
--    SECURITY DEFINER so the function can read user_tenants regardless of the
--    calling user's policies. STABLE so Postgres can inline/cache within a
--    single query. search_path is pinned to prevent hijacking.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT tenant_id FROM public.user_tenants WHERE user_id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT COALESCE(
    (SELECT is_super_admin FROM public.user_tenants WHERE user_id = auth.uid()),
    false
  );
$$;

GRANT EXECUTE ON FUNCTION public.current_tenant_id()  TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_super_admin()     TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Seed super-admin row for Caleb BEFORE enabling RLS on user_tenants
--     (id c@stewardship.is → fbf66d6a-94db-4b7f-b28f-4b4a3a17c200, Frio tenant)
-- ---------------------------------------------------------------------------
INSERT INTO public.user_tenants (user_id, tenant_id, is_super_admin)
SELECT
  u.id,
  t.id,
  true
FROM auth.users u
CROSS JOIN public.tenants t
WHERE u.email = 'c@stewardship.is'
  AND t.slug  = 'frio'
ON CONFLICT (user_id) DO UPDATE
  SET is_super_admin = true,
      tenant_id      = EXCLUDED.tenant_id;

-- ---------------------------------------------------------------------------
-- 4. Enable RLS on all tenant-scoped tables and add identical policies.
--
--    Policy logic is always:
--       super-admin  OR  tenant_id matches the caller's tenant.
--
--    Grant for the `authenticated` role only — anon users are locked out
--    entirely. service_role bypasses RLS so backend writes still work.
-- ---------------------------------------------------------------------------

-- wells
ALTER TABLE public.wells ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.wells;
CREATE POLICY tenant_isolation ON public.wells
  FOR ALL TO authenticated
  USING     (public.is_super_admin() OR tenant_id = public.current_tenant_id())
  WITH CHECK (public.is_super_admin() OR tenant_id = public.current_tenant_id());

-- production_daily
ALTER TABLE public.production_daily ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.production_daily;
CREATE POLICY tenant_isolation ON public.production_daily
  FOR ALL TO authenticated
  USING     (public.is_super_admin() OR tenant_id = public.current_tenant_id())
  WITH CHECK (public.is_super_admin() OR tenant_id = public.current_tenant_id());

-- production_monthly
ALTER TABLE public.production_monthly ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.production_monthly;
CREATE POLICY tenant_isolation ON public.production_monthly
  FOR ALL TO authenticated
  USING     (public.is_super_admin() OR tenant_id = public.current_tenant_id())
  WITH CHECK (public.is_super_admin() OR tenant_id = public.current_tenant_id());

-- email_log
ALTER TABLE public.email_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.email_log;
CREATE POLICY tenant_isolation ON public.email_log
  FOR ALL TO authenticated
  USING     (public.is_super_admin() OR tenant_id = public.current_tenant_id())
  WITH CHECK (public.is_super_admin() OR tenant_id = public.current_tenant_id());

-- exports
ALTER TABLE public.exports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.exports;
CREATE POLICY tenant_isolation ON public.exports
  FOR ALL TO authenticated
  USING     (public.is_super_admin() OR tenant_id = public.current_tenant_id())
  WITH CHECK (public.is_super_admin() OR tenant_id = public.current_tenant_id());

-- flagged_records
ALTER TABLE public.flagged_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.flagged_records;
CREATE POLICY tenant_isolation ON public.flagged_records
  FOR ALL TO authenticated
  USING     (public.is_super_admin() OR tenant_id = public.current_tenant_id())
  WITH CHECK (public.is_super_admin() OR tenant_id = public.current_tenant_id());

-- well_name_aliases
ALTER TABLE public.well_name_aliases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.well_name_aliases;
CREATE POLICY tenant_isolation ON public.well_name_aliases
  FOR ALL TO authenticated
  USING     (public.is_super_admin() OR tenant_id = public.current_tenant_id())
  WITH CHECK (public.is_super_admin() OR tenant_id = public.current_tenant_id());

-- format_mappings
ALTER TABLE public.format_mappings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.format_mappings;
CREATE POLICY tenant_isolation ON public.format_mappings
  FOR ALL TO authenticated
  USING     (public.is_super_admin() OR tenant_id = public.current_tenant_id())
  WITH CHECK (public.is_super_admin() OR tenant_id = public.current_tenant_id());

-- ---------------------------------------------------------------------------
-- 5. tenants + operators + user_tenants policies
--
--    operators    = shared reference data, any authenticated user can SELECT;
--                   only super-admin can write.
--    tenants      = users see only their own tenant row (plus super-admin).
--    user_tenants = users see only their own row (plus super-admin).
-- ---------------------------------------------------------------------------

-- tenants
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_self_view ON public.tenants;
CREATE POLICY tenant_self_view ON public.tenants
  FOR SELECT TO authenticated
  USING (public.is_super_admin() OR id = public.current_tenant_id());
DROP POLICY IF EXISTS tenant_super_admin_write ON public.tenants;
CREATE POLICY tenant_super_admin_write ON public.tenants
  FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

-- operators
ALTER TABLE public.operators ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operators_read_all ON public.operators;
CREATE POLICY operators_read_all ON public.operators
  FOR SELECT TO authenticated
  USING (true);
DROP POLICY IF EXISTS operators_super_admin_write ON public.operators;
CREATE POLICY operators_super_admin_write ON public.operators
  FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

-- user_tenants
ALTER TABLE public.user_tenants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_tenants_self ON public.user_tenants;
CREATE POLICY user_tenants_self ON public.user_tenants
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_super_admin());
DROP POLICY IF EXISTS user_tenants_super_admin_write ON public.user_tenants;
CREATE POLICY user_tenants_super_admin_write ON public.user_tenants
  FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

COMMIT;
