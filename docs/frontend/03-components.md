# 03 · Shared Components

The shared building blocks used across pages. All live in `web/src/components/`.

## `<Layout>` — shell with sidebar + top bar

Source: `Layout.tsx`. Used by every authenticated route.

Provides:
- Sidebar nav (Dashboard, Monthly Export, Daily Export, Export History, Admin (if super-admin))
- Top bar with the brand logo, "LIVE" pulsing indicator, current user email, sign-out button
- Main content area where the active page renders via `<Outlet />`

The pulsing-glow LIVE indicator uses the `liveGlow` keyframe in `index.css` and is for vibes — it doesn't reflect actual liveness. Future: tie it to a `/health` ping every 30s.

## `<ExportPanel>` — shared form for Monthly + Daily exports

Source: `ExportPanel.tsx`. The single source of truth for the export download UI.

Props:
- `pageTitle` (string): "Monthly Export" or "Daily Export"
- `pageSubtitle` (string): the line under the title
- `inputType`: `'month'` (renders `<input type="month">`) or `'date'`
- `apiPath`: `/api/export/monthly` or `/api/export/daily`
- `startPlaceholder`, `endPlaceholder`
- `helpText`: the body of the green info callout

Behavior:
- Loads the list of operators on mount (`supabase.from('operators').select('id, name, wells!inner(id)')`) — filters out operators with no wells so the dropdown stays clean
- On submit, fetches the export endpoint with the user's JWT, triggers a browser download via blob URL
- Shows success/error states
- Renders the green info callout at the bottom

If you want to add anything below the callout on the Monthly page only (like the production overview chart), wrap `<ExportPanel>` in a flex column and append the new component as a sibling — see `pages/MonthlyExportPage.tsx`.

## `<MonthlyProductionChart>` — Oil/Gas/Water overview

Source: `MonthlyProductionChart.tsx`. Used only on `MonthlyExportPage`.

Behavior:
- On mount, calls `supabase.rpc('monthly_production_totals', { p_start, p_end: null, p_operator: null })` with `p_start` = first-of-month, 24 months ago
- Renders three side-by-side bar charts: Oil (BBL), Gas (MCF), Water (BBL)
- Hover on a bar shows a tooltip with the month name and value (compact format: `1.2M`, `850K`)
- "Nice ceil" function rounds the y-axis max to a clean number (1, 2, 2.5, 5, 10 × 10^n)
- X-axis labels are first, middle, last only — to stay legible

Props:
- `monthsBack` (default 24)

Why inline SVG: see [architecture/04-decisions.md](../architecture/04-decisions.md#why-the-chart-is-inline-svg-not-recharts).

## `<LogoMark>` — the brand mark

Inline SVG. Used in the Layout sidebar. Two props: `size`, `color` (defaults to `colors.electricTeal`).

## Component conventions

- **No CSS-in-JS library**. Use inline `style={{}}` for one-off styling, `className` for shared utility classes from `index.css`.
- **No `localStorage`** in components. Use React state. (Supabase JS uses localStorage for sessions — that's fine; it's outside our component code.)
- **No `useMemo` for trivial computations.** Add it only when there's a measurable perf issue.
- **Loading and error states are explicit.** Never silently fail; always render something the user can act on (`Loading...`, error message, retry button).
- **Strings are inline.** No i18n. Single-tenant, English-only for now.
- **Pull state up.** If two siblings need the same data, lift state to the parent. We don't have a state library.

## Adding a new shared component

1. File: `web/src/components/<PascalCase>.tsx`
2. Export a single default component.
3. Top-of-file JSDoc explaining what it is and where it's used.
4. Inline styles or `className` from `index.css`. No new dependencies.
5. Wire it into the page(s) that need it.
6. If the component takes data fetched from Supabase, do the fetch inside the component (not in the page) — keeps the page lean.
