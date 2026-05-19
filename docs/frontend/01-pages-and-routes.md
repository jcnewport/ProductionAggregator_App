# 01 · Frontend Pages and Routes

React Single-Page App built with Vite. Source: `web/src/`. Entry: `web/src/main.tsx` → `App.tsx`.

## Route map

| Path | Page | Auth | Notes |
|---|---|---|---|
| `/login` | `LoginPage.tsx` | Public | Supabase Auth — email/password + magic link |
| `/onboarding` | `OnboardingPage.tsx` | First-time user | Sets initial password if invited |
| `/` (default) | redirects to `/dashboard` | Authenticated | |
| `/dashboard` | `DashboardPage.tsx` | Authenticated | Email processing log, flagged records, non-production files |
| `/export/monthly` | `MonthlyExportPage.tsx` | Authenticated | Month-range picker + Generate & Download + production overview chart |
| `/export/daily` | `DailyExportPage.tsx` | Authenticated | Same but date-range, no chart |
| `/export/history` | `ExportHistoryPage.tsx` | Authenticated | Past exports with re-download |
| `/admin` | (in App.tsx) | Super-admin | Tenant management, user invites, mapping management |

Routing library: `react-router-dom` v6.

## Component shape

```
App.tsx
├── <AuthProvider />               ← Supabase session context
│   └── <Routes />
│       ├── <Route /login>         → LoginPage
│       ├── <ProtectedRoute>       ← Wraps any authenticated route
│       │   └── <Layout>           ← Sidebar + top bar
│       │       ├── Outlet ...
│       │       └── (each page)
│       └── <SuperAdminRoute>      ← Stricter than ProtectedRoute
│           └── <AdminPage>
```

Route guards:
- `auth/ProtectedRoute.tsx` — redirects to /login if not signed in
- `auth/SuperAdminRoute.tsx` — also requires `user_tenants.is_super_admin = true`

## Shared components

| Component | Used by | Purpose |
|---|---|---|
| `components/Layout.tsx` | Every authenticated page | Sidebar nav, top bar, live indicator |
| `components/ExportPanel.tsx` | Monthly + Daily Export pages | Date-range picker, operator filter, Generate button, error/success states |
| `components/MonthlyProductionChart.tsx` | Monthly Export page | Oil/Gas/Water 24-month bar charts (inline SVG, see [03-components.md](03-components.md)) |
| `components/LogoMark.tsx` | Layout sidebar | Inline-SVG Stewardship.IS logo |

## Design tokens

Source: `web/src/theme.ts`. Three exports:
- `colors` — every palette color (midnightNavy, electricTeal, etc.) plus status colors
- `shadows` — `card`, `cardHover`, `tealGlow`
- `radii` — `sm`, `md`, `lg`, `xl`, `pill`
- `transitions` — `card`, `snappy`

Brand direction: "Enterprise Confident" — dark-navy primary actions, electric-teal accents, white surfaces on warm-white canvas. See `theme.ts` for the full palette commentary.

**Class-based styles** like `sis-input`, `sis-btn`, `sis-btn-primary`, `sis-hover-lift`, `sis-stagger` live in `web/src/index.css`. Tailwind is NOT installed.

## Data access patterns

| Pattern | When to use |
|---|---|
| `supabase.from('table').select(...)` | Simple read with RLS scoping (typical case) |
| `supabase.rpc('function_name', { args })` | Pre-aggregated reads or anything PostgREST can't express |
| `fetch('/api/...')` with Supabase JWT | Streaming downloads, multi-step operations |

Frontend Supabase client: `web/src/utils/supabase.ts`. Uses `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` env vars (built into the bundle at compile time).

## Auth lifecycle

1. User hits any route.
2. `<AuthProvider>` mounts. On mount, it calls `supabase.auth.getSession()` and `supabase.auth.onAuthStateChange()`.
3. If no session: `<ProtectedRoute>` redirects to `/login`.
4. On login: `supabase.auth.signInWithPassword({ email, password })`. Supabase returns a JWT with `tenant_id` claim baked in (via the auth-hook function in migration 0001).
5. Frontend stores the session in localStorage (Supabase JS does this automatically).
6. Subsequent `supabase.from(...)` calls automatically send the JWT.
7. RLS scopes every query.

Session persistence: Supabase JS uses `localStorage` by default. **Caleb's project_instructions forbid localStorage in *Artifacts* — that restriction is for the embedded code-as-message product, not for the production React app.** Localstorage is fine here.

## Building and serving

In dev:
```bash
cd web
npm install
npm run dev   # Vite dev server on http://localhost:5173
```

In production: the API process serves the built frontend from `web/dist/` as static files. The build step is in `api/package.json` → `build:web` (cd ../web && npm install && npm run build). Railway's build command runs the full `build` script, then `start` runs `node dist/index.js`.

This means there's no separate frontend deploy — `git push` builds and serves both.

## Environment variables

| Var | Purpose | Where |
|---|---|---|
| `VITE_SUPABASE_URL` | Supabase project URL | Railway env vars (compile-time) |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon public key | Railway env vars (compile-time) |

VITE_ prefix means Vite inlines them into the bundle at build time. These are safe to expose because the anon key is gated by RLS.
