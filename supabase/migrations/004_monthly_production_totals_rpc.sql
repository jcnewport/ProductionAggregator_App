-- ============================================================
-- Migration 004: Monthly Production Totals RPC
-- Applied: 2026-05-19
--
-- Purpose:
--   The Monthly Export page renders a small overview chart below the
--   help callout (Oil / Gas / Water by month). The chart needs a
--   GROUP-BY-month aggregate. Doing that on the client would require
--   pulling thousands of raw production_monthly rows over the wire just
--   to throw most of them away after summing.
--
--   This migration adds a SECURITY INVOKER function:
--
--     monthly_production_totals(p_start DATE, p_end DATE, p_operator UUID)
--
--   • SECURITY INVOKER — RLS still applies, callers only see their own
--     tenant's rows (or all rows if super_admin).
--   • p_start / p_end are inclusive month boundaries; pass NULL to mean
--     "all data on that side".
--   • p_operator is optional; pass NULL to include all operators.
--   • Returns one row per month with summed oil / gas / water and the
--     underlying row count.
--   • Months are normalized to first-of-month so the chart's x-axis
--     keys are predictable.
-- ============================================================

CREATE OR REPLACE FUNCTION monthly_production_totals(
  p_start DATE DEFAULT NULL,
  p_end   DATE DEFAULT NULL,
  p_operator UUID DEFAULT NULL
)
RETURNS TABLE (
  month       DATE,
  oil_total   NUMERIC,
  gas_total   NUMERIC,
  water_total NUMERIC,
  row_count   BIGINT
)
LANGUAGE sql
SECURITY INVOKER
STABLE
AS $$
  SELECT
    date_trunc('month', prod_date)::date AS month,
    COALESCE(SUM(oil_prod),   0)::numeric AS oil_total,
    COALESCE(SUM(gas_prod),   0)::numeric AS gas_total,
    COALESCE(SUM(water_prod), 0)::numeric AS water_total,
    COUNT(*)::bigint AS row_count
  FROM production_monthly
  WHERE (p_start    IS NULL OR prod_date >= p_start)
    AND (p_end      IS NULL OR prod_date <= p_end)
    AND (p_operator IS NULL OR operator_id = p_operator)
  GROUP BY 1
  ORDER BY 1;
$$;

-- Allow the application roles to call it (RLS still enforces row visibility).
GRANT EXECUTE ON FUNCTION monthly_production_totals(DATE, DATE, UUID) TO authenticated, anon, service_role;

COMMENT ON FUNCTION monthly_production_totals(DATE, DATE, UUID) IS
  'Monthly aggregates of oil/gas/water for the Monthly Export overview chart. SECURITY INVOKER so RLS scopes the result to the caller''s tenant.';
