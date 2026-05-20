# 02 · Auth & Tenant Context

How users sign in, how their tenant is determined, and how the frontend enforces super-admin-only routes.

## The big picture

```
1. User opens the app, hits any path.
2. <AuthProvider> mounts. It reads localStorage for a Supabase session and
   subscribes to auth state changes.
3. <ProtectedRoute> wraps every authenticated page. If no user, redirect to /login.
4. <SuperAdminRoute> wraps /admin. If user.is_super_admin !== true, redirect to /dashboard.
5. Every Supabase query the page makes is auto-scoped by RLS to the user's tenant.
```

## The JWT carries auth.uid(), not tenant_id

When a user signs in via Supabase Auth, the JWT issued includes the standard claims:

```json
{
  "sub": "<user_uuid>",
  "email": "user@frio.example",
  "role": "authenticated"
}
```

**No `tenant_id` claim. No custom access-token hook.** This was a deliberate simplification: registering a JWT hook requires a Supabase Auth dashboard step that's hard to codify in a migration. Instead, the Postgres helper `current_tenant_id()` runs as `SECURITY DEFINER` and looks up the user's tenant from `user_tenants` at query time, keyed on `auth.uid()` (which IS in every JWT).

## How RLS uses it

```sql
public.current_tenant_id() → uuid          -- looks up user_tenants by auth.uid()
public.is_super_admin()    → boolean       -- TRUE if user has the flag in user_tenants
```

Both functions are `SECURITY DEFINER` so they can read `user_tenants` without triggering RLS recursion. See [database/02-rls-and-tenancy.md](../database/02-rls-and-tenancy.md) for the full mechanics.

Every data table has the policy:

```sql
USING (is_super_admin() OR tenant_id = current_tenant_id())
```

So when the frontend runs `supabase.from('production_monthly').select(...)`, RLS automatically filters to the user's tenant. The frontend doesn't pass `tenant_id` anywhere.

## `<AuthProvider>` — the frontend session context

Source: `web/src/auth/AuthProvider.tsx`.

```typescript
// Exposes via useAuth() hook:
{
  user: User | null,          // Supabase user object
  session: Session | null,    // Current session with JWT
  tenantId: string | null,    // Decoded from JWT claims
  isSuperAdmin: boolean,      // Decoded from JWT claims
  signOut: () => Promise<void>,
}
```

Implementation:
- On mount: `supabase.auth.getSession()` → set initial state
- Subscribe to `supabase.auth.onAuthStateChange()` for live updates (sign-in, sign-out, token refresh)
- Decode JWT claims via `jwtDecode` to extract `tenant_id` and the super-admin flag

## `<ProtectedRoute>`

Source: `web/src/auth/ProtectedRoute.tsx`. Simple gate:

```typescript
const { user, isLoading } = useAuth();
if (isLoading) return <Spinner />;
if (!user) return <Navigate to="/login" replace />;
return <Outlet />;
```

## `<SuperAdminRoute>`

Source: `web/src/auth/SuperAdminRoute.tsx`. Stricter:

```typescript
const { isSuperAdmin, isLoading } = useAuth();
if (isLoading) return <Spinner />;
if (!isSuperAdmin) return <Navigate to="/dashboard" replace />;
return <Outlet />;
```

**This is UI-level only.** The backend ALSO enforces super-admin via the `requireSuperAdmin` middleware on every `/api/admin/*` route. Defense in depth. Never trust the frontend.

## Sign-up vs. invite-only

The app is **invite-only**. There is no public sign-up form. The flow for a new tenant user:

1. Super-admin opens `/admin` → "Invite user" card.
2. Enters email + selects tenant.
3. Backend calls `supabase.auth.admin.inviteUserByEmail()` and inserts `user_tenants` row.
4. Supabase emails the user a magic-link onboarding URL.
5. User clicks the link → `OnboardingPage.tsx` → sets initial password.
6. Subsequent logins use email/password.

Source: `api/src/routes/onboarding.ts`.

## Sign-out

`supabase.auth.signOut()` clears the local session and revokes the refresh token server-side. Frontend redirects to `/login`.

## Open question: tenant switcher

There is currently no UI for a user to switch between tenants. If `user_tenants` has multiple rows for the same user, `current_tenant_id()` returns whichever row Postgres picks first (no `ORDER BY`, no `LIMIT`), which is undefined behavior. In practice every user today has exactly one `user_tenants` row, so this never triggers. If we ever support multi-tenant users, we'd need to either add an `ORDER BY is_super_admin DESC, created_at ASC LIMIT 1` to the function OR introduce a tenant-switcher UI.

This is fine for now because:
- Super-admin is the only user who'd realistically need multiple-tenant access, and super-admin's RLS predicate is `is_super_admin() OR …`, so they see everything anyway.
- Regular tenant users belong to one company.

If we add a customer relationship like "advisor manages 3 client tenants," we'll need a switcher. Until then: YAGNI.

## Token refresh

Supabase JWTs expire after 1 hour by default. The Supabase JS client automatically refreshes them using the refresh token (stored in localStorage). The frontend doesn't have to do anything for this to work.

If the refresh token itself is revoked (super-admin signs the user out, password is changed), the next refresh attempt fails. `onAuthStateChange` fires with `SIGNED_OUT`. The user is redirected to `/login`.

## Bypassing RLS in development

Don't. Even in development. If you need to inspect cross-tenant data, use the Supabase dashboard SQL editor (which runs as service_role and bypasses RLS) — not the app.

If a frontend bug seems to be RLS-related, log into the Supabase dashboard, run the query as the actual user (impersonation via the `Run as` selector in SQL editor), and confirm whether RLS is the issue.

## What to do if a user can't log in

1. Check Supabase Auth dashboard: does the user exist? Is the email confirmed?
2. Check `user_tenants`: is there a row linking this user to a tenant?
3. Check the JWT: log in as the user, copy the access token, paste it into jwt.io. The `sub` claim should be the user's UUID.
4. Run as super-admin: `SELECT * FROM user_tenants WHERE user_id = '<sub claim>';`. If zero rows, the user has no tenant — assign one via the Admin UI.

See [runbooks](../runbooks/) for fuller troubleshooting.
