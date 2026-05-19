# 02 · RLS and Multi-Tenancy

How tenant isolation actually works at the database level. If you change anything in this file's logic, double-test in staging because the failure mode is "tenant A sees tenant B's data" — a P0 incident.

## The two functions every policy depends on

```sql
-- Returns the calling user's tenant_id, from their JWT claims.
CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(
    current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id',
    ''
  )::uuid;
$$;

-- Returns TRUE if the calling user has the super-admin flag on any tenant row.
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_tenants
    WHERE user_id = auth.uid()
      AND is_super_admin = true
  );
$$;
```

Both are `STABLE` (Postgres can cache within a single query) but **not** `SECURITY DEFINER` — they run as the calling user, so a malicious user can't trick them into returning someone else's tenant.

## The standard policy pattern

Every data table has this exact policy:

```sql
CREATE POLICY tenant_isolation
ON public.<table_name>
FOR ALL
USING (is_super_admin() OR tenant_id = current_tenant_id())
WITH CHECK (is_super_admin() OR tenant_id = current_tenant_id());
```

- `USING` filters what rows are visible to SELECT/UPDATE/DELETE
- `WITH CHECK` enforces what rows can be written by INSERT/UPDATE
- Both clauses are identical: a user can read and write rows for their tenant; a super-admin can read and write any row

## Live policies (as of 2026-05-19)

| Table | Policy name | Command | Predicate |
|---|---|---|---|
| `email_log` | tenant_isolation | ALL | `is_super_admin() OR tenant_id = current_tenant_id()` |
| `exports` | tenant_isolation | ALL | same |
| `flagged_records` | tenant_isolation | ALL | same |
| `format_mappings` | tenant_isolation | ALL | same |
| `production_daily` | tenant_isolation | ALL | same |
| `production_monthly` | tenant_isolation | ALL | same |
| `well_name_aliases` | tenant_isolation | ALL | same |
| `wells` | tenant_isolation | ALL | same |
| `non_production_files` | Authenticated users read own tenant non_production_files | SELECT | `is_super_admin() OR tenant_id = current_tenant_id()` |
| `non_production_files` | Service role manages non_production_files | ALL | `auth.role() = 'service_role'` |
| `tenants` | tenant_self_view | SELECT | User can see own tenant rows |
| `tenants` | tenant_super_admin_write | ALL | Super-admin only |
| `user_tenants` | user_tenants_self | SELECT | User can see their own rows |
| `user_tenants` | user_tenants_super_admin_write | ALL | Super-admin only |
| `operators` | operators_read_all | SELECT | Authenticated users |
| `operators` | operators_super_admin_write | ALL | Super-admin only |
| `combocurve_wells` | combocurve_wells authenticated read | SELECT | Authenticated |
| `combocurve_wells` | combocurve_wells service write | ALL | service_role |

## How `tenant_id` reaches `current_tenant_id()`

```
1. User authenticates via Supabase Auth (email/password or magic link).
2. Supabase issues a JWT with claims:
     - sub: <user_id>
     - email: <user_email>
     - tenant_id: <tenant_uuid>      ← THIS is the critical claim
3. The `tenant_id` claim is set by an auth-hook function (see migration 0001_multitenancy_phase1.sql)
   that reads user_tenants when the user logs in.
4. Frontend sends the JWT on every PostgREST call (supabase-js handles this automatically).
5. Postgres has access to the JWT via `current_setting('request.jwt.claims', true)`.
6. `current_tenant_id()` extracts the claim. Done.
```

Backend express middleware does the same thing in `api/src/middleware/security.ts` for routes that aren't PostgREST: parse the Bearer token, resolve `tenant_id`, attach to `req.user`.

## Why "ALL" instead of separate SELECT/INSERT/UPDATE/DELETE policies?

Because the predicate is the same for every operation. Having one policy named `tenant_isolation` is easier to audit than four policies with the same body.

## Super-admin: testing tip

When acting as a super-admin in the app and you want to *see* what a regular tenant user would see for tenant X, **don't temporarily flip your `is_super_admin` flag**. Instead, set up a sandbox tenant + sandbox user and log in as that user in a separate browser session. Flipping flags is the easiest way to lock yourself out.

## What happens if `tenant_id` is NULL in the JWT?

`current_tenant_id()` returns NULL. Every `tenant_id = current_tenant_id()` predicate then evaluates to NULL (because `anything = NULL` is NULL, not TRUE). NULL is not TRUE, so RLS denies the row.

In practice this means: **a user with no tenant assignment sees nothing**. They can log in, but every page is empty until super-admin assigns them to a tenant.

## What `service_role` is and why we have a policy for it

Supabase issues a `service_role` JWT alongside the `anon` key. The service role bypasses RLS entirely — it's intended for trusted server-side code (our Railway API).

The `non_production_files` table has an explicit `service_role` policy because the email poller (which runs as service_role) needs to INSERT rows. The Postgres RLS check still runs for service_role, so we make the policy permissive for that role.

For most data tables, we don't need a separate service_role policy: when the poller inserts a production row, it explicitly passes the tenant_id from the resolved tenant, and the standard `tenant_isolation` policy accepts it because the service_role bypasses RLS in practice. But the explicit policy on `non_production_files` is belt-and-suspenders.

## The "I just deployed and now every query returns nothing" failure mode

Symptom: a new feature ships, queries that should return rows return zero rows.

Most likely cause: missing `tenant_id` in the INSERT path. If you write a row without a `tenant_id`, it's still inserted (the column is NOT NULL — INSERT will actually error), but if a migration ever loosened the constraint, the row would exist but RLS would hide it.

Always check: `SELECT * FROM <table> WHERE tenant_id IS NULL;` as super-admin. If anything comes back, that's a bug.

## Adding RLS to a NEW table

Template (use this verbatim when creating a new tenant-scoped table):

```sql
CREATE TABLE public.<new_table> (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- ... your columns ...
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_<new_table>_tenant ON public.<new_table>(tenant_id);

ALTER TABLE public.<new_table> ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation
  ON public.<new_table>
  FOR ALL
  USING (is_super_admin() OR tenant_id = current_tenant_id())
  WITH CHECK (is_super_admin() OR tenant_id = current_tenant_id());
```

Do NOT forget the index on `tenant_id`. Without it, the RLS predicate filters by full table scan on every query.
