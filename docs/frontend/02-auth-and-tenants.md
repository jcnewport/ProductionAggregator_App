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

## The JWT carries the tenant_id

When a user signs in via Supabase Auth, the JWT issued includes a custom claim:

```json
{
  "sub": "<user_uuid>",
  "email": "user@frio.example",
  "tenant_id": "<tenant_uuid>"
}
```

The `tenant_id` claim is injected by an auth-hook function that reads `user_tenants` at sign-in. Source: `api/migrations/0001_multitenancy_phase1.sql`.

If a user has multiple `user_tenants` rows (rare; theoretical multi-tenant case), the hook picks one deterministically (usually the most recently created, or `is_super_admin` first if any are flagged). The frontend currently does NOT offer a tenant switcher — see "Open question" at end of file.

## How RLS uses it

The JWT claims are available to Postgres via `current_setting('request.jwt.claims', true)`. Two helper functions:

```sql
public.current_tenant_id() → uuid          -- the JWT's tenant_id claim
public.is_super_admin()    → boolean       -- TRUE if user has the flag on any tenant row
```

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

There is currently no UI for a user to switch between tenants. If `user_tenants` has multiple rows for the same user, the auth hook picks one and that's what they see. We don't surface the others.

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
3. Check the JWT: log in as the user, copy the access token, paste it into jwt.io. Does it have a `tenant_id` claim? If not, the auth hook didn't fire.
4. If the auth hook didn't fire: it's likely a Supabase-side issue. The auth hook is set as a "custom access token hook" in the Supabase project's Auth settings → Hooks. Verify it's enabled and pointed at the right function.

See [runbooks](../runbooks/) for fuller troubleshooting.
