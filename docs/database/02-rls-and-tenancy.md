# 02 · RLS and Multi-Tenancy

How tenant isolation actually works at the database level. If you change anything in this file's logic, double-test in staging because the failure mode is "tenant A sees tenant B's data" — a P0 incident.

## The two functions every policy depends on

```sql
-- Returns the calling user's tenant_id by looking it up from user_tenants.
-- Uses auth.uid() which Supabase populates from every authenticated JWT.
CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $$
  SELECT tenant_id FROM public.user_tenants WHERE user_id = auth.uid();
$$;

-- Returns TRUE if the calling user has the super-admin flag in user_tenants.
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $$
  SELECT COALESCE(
    (SELECT is_super_admin FROM public.user_tenants WHERE user_id = auth.uid()),
    false
  );
$$;
```

**SECURITY DEFINER** here is important and intentional:
- The functions need to SELECT from `user_tenants`, which itself has RLS that limits a user to their own rows
- Without DEFINER, calling `current_tenant_id()` would invoke RLS on `user_tenants`, which is a circular dependency in some paths
- DEFINER means the function runs as the owner (`postgres` role), bypassing RLS just for this lookup
- The function still only returns the calling user's own tenant_id because the WHERE clause uses `auth.uid()` (which is always the calling user, even under DEFINER)

`auth.uid()` is Supabase's built-in helper that extracts the `sub` claim from the JWT — every authenticated user has one. **No custom access-token hook is required.** This is the key simplification: we don't have to register a JWT-claims-injecting function in the Supabase Auth dashboard.

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

## How a user's tenant_id is determined

```
1. User authenticates via Supabase Auth (email/password or magic link).
2. Supabase issues a JWT with the standard claims:
     - sub: <user_id>   ← this is auth.uid()
     - email: <user_email>
   No tenant_id claim is needed. No custom hook required.
3. Frontend sends the JWT on every PostgREST call (supabase-js handles this automatically).
4. Postgres exposes auth.uid() to RLS policies via the JWT's sub claim.
5. RLS calls current_tenant_id(), which does:
     SELECT tenant_id FROM user_tenants WHERE user_id = auth.uid()
6. The lookup returns the user's tenant. RLS uses it to filter rows.
```

The frontend ALSO decodes the user_id from the JWT to determine super-admin status for UI gating (see `frontend/02-auth-and-tenants.md`), but that's a UI convenience — the security enforcement is in RLS, not in the frontend.

## Why "ALL" instead of separate SELECT/INSERT/UPDATE/DELETE policies?

Because the predicate is the same for every operation. Having one policy named `tenant_isolation` is easier to audit than four policies with the same body.

## Super-admin: testing tip

When acting as a super-admin in the app and you want to *see* what a regular tenant user would see for tenant X, **don't temporarily flip your `is_super_admin` flag**. Instead, set up a sandbox tenant + sandbox user and log in as that user in a separate browser session. Flipping flags is the easiest way to lock yourself out.

## What happens if a user has no `user_tenants` row?

`current_tenant_id()` returns NULL. Every `tenant_id = current_tenant_id()` predicate then evaluates to NULL (because `anything = NULL` is NULL, not TRUE). NULL is not TRUE, so RLS denies the row.

In practice this means: **a user who exists in `auth.users` but is missing from `user_tenants` sees nothing**. They can log in, but every page is empty until super-admin assigns them to a tenant via the Admin UI.

## What `service_role` is and why we have a policy for it

Supabase issues a `service_role` JWT alongside the `anon` key. The service role bypasses RLS entirely — it's intended for trusted server-side code (our Railway API).

The `non_production_files` table has an explicit `service_role` policy because the email poller (which runs as service_role) needs to INSERT rows. For most data tables, we don't need a separate service_role policy: when the poller inserts a production row, it explicitly passes the tenant_id from the resolved tenant.

## The "I just deployed and now every query returns nothing" failure mode

Symptom: a new feature ships, queries that should return rows return zero rows.

Possible causes:
1. **Missing `tenant_id` in the INSERT path.** Always include `tenant_id` explicitly in write payloads — RLS's `WITH CHECK` rejects writes where the column is NULL.
2. **The user is not in `user_tenants`.** Verify with `SELECT * FROM user_tenants WHERE user_id = '<user_uuid>';` as super-admin.
3. **The user IS in `user_tenants` but `current_tenant_id()` returns the wrong value.** This can happen if a single user has multiple `user_tenants` rows — the query has no `LIMIT 1`, so it'll error or return a random row. Check: `SELECT COUNT(*) FROM user_tenants WHERE user_id = '<user_uuid>';` — should be 1.

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
