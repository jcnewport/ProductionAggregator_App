# 03 · RPC Functions

Postgres functions in the `public` schema that the application calls directly (via `supabase.rpc(...)`).

Excludes built-in helpers from Postgres extensions (`pg_trgm`, etc.) and the RLS support functions (those are documented in [02-rls-and-tenancy.md](02-rls-and-tenancy.md)).

## `monthly_production_totals(p_start, p_end, p_operator)`

Returns monthly aggregates of oil/gas/water for the Monthly Export overview chart.

**Signature:**
```sql
monthly_production_totals(
  p_start    date DEFAULT NULL,
  p_end      date DEFAULT NULL,
  p_operator uuid DEFAULT NULL
)
RETURNS TABLE (
  month       date,
  oil_total   numeric,
  gas_total   numeric,
  water_total numeric,
  row_count   bigint
)
LANGUAGE sql
SECURITY INVOKER
STABLE
```

**Behavior:**
- Aggregates `production_monthly` by `date_trunc('month', prod_date)`.
- `p_start` / `p_end` are inclusive bounds; pass `NULL` to mean "no bound on that side".
- `p_operator` is optional; pass `NULL` to include all operators.
- Returns one row per month with summed oil/gas/water + the underlying row count.
- Months are normalized to first-of-month so the chart's x-axis keys are predictable.

**Why SECURITY INVOKER:** the function runs as the calling user, so RLS still scopes the result to the caller's tenant. A super-admin sees all rows; a tenant user sees only their own.

**Where it's called:** `web/src/components/MonthlyProductionChart.tsx` (the Monthly Production Overview chart on the Monthly Export page).

**Migration:** `supabase/migrations/004_monthly_production_totals_rpc.sql`.

## `exec_sql_json(q text)`

Internal admin utility for running arbitrary SQL and returning JSON. Restricted to super-admin via RLS on the calling table; not exposed in normal application code paths.

**Use with caution.** Only the admin retry/reprocess routes call this, and only with hardcoded queries.

## RLS-support functions (already documented elsewhere)

- `current_tenant_id()` — see [02-rls-and-tenancy.md](02-rls-and-tenancy.md)
- `is_super_admin()` — see [02-rls-and-tenancy.md](02-rls-and-tenancy.md)
- `update_updated_at()` — trigger function used by tables with `updated_at` columns; sets the column to `NOW()` on UPDATE

## Adding a new RPC

1. Write the migration file in `supabase/migrations/00X_<descriptive_name>.sql`.
2. Apply locally to your Supabase project via the dashboard or the Supabase MCP (see [04-migrations.md](04-migrations.md)).
3. Add an entry in this doc.
4. Frontend usage: `const { data } = await supabase.rpc('<function_name>', { p_foo: 'bar' });`

**RLS:** unless you have a specific reason to use `SECURITY DEFINER`, always use `SECURITY INVOKER` (the default). DEFINER bypasses RLS — a common source of accidental cross-tenant data leaks.

**`GRANT EXECUTE`** to `authenticated, anon, service_role` if the function should be callable from the frontend. RLS still controls what data the function sees.
