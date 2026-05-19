# 03 · Tech Stack

Every tool we use, what it costs, and why we picked it over alternatives.

## Application code

| Layer | Tool | Version | Why |
|---|---|---|---|
| **Language** | TypeScript | 5.5+ | Strict types catch the bulk of "operator file has a slightly different shape" bugs at compile time. Same language across api and web. |
| **Backend framework** | Express | 4.21 | Boring. Well-understood. Plenty of middleware. We're not running at a scale that needs Fastify or Hono. |
| **Cron** | node-cron | 3.0 | In-process scheduling. No second deploy target. See [decisions: one process not worker fleet](04-decisions.md#why-one-process-not-a-worker-fleet). |
| **Frontend framework** | React | 18.3 | Familiar. Caleb can read it. Plenty of AI training data when something needs fixing. |
| **Frontend bundler** | Vite | 5.4 | Fast dev server, fast prod build, no config needed for a small SPA. |
| **Routing** | react-router-dom | 6.26 | Standard. |
| **Styling** | Inline styles + theme tokens | n/a | No CSS-in-JS library, no Tailwind. The app is small enough that `web/src/theme.ts` exporting `colors / shadows / radii` is sufficient, and it keeps the bundle tiny. |
| **PDF parsing** | pdf-parse | 1.1.1 | Pure-JS, text extraction only (no OCR — we don't need it because every operator's PDFs are text-extractable, not scanned). |
| **Excel parsing** | xlsx (SheetJS) | 0.18.5 | Industry standard. Handles multi-sheet workbooks and weird cell types (scientific notation IDs, dates as serials). |

## Infrastructure

| Layer | Tool | Why this and not the obvious alternative |
|---|---|---|
| **Hosting** | Railway | Vercel's serverless functions cap at 60s and ~50MB request bodies. Some operator monthly statements push 200MB. Railway gives us a long-lived Node process with plenty of memory. |
| **Database** | Supabase (managed Postgres) | Free-tier-friendly for early days. RLS works out of the box. Auth + Storage + DB in one console. We use raw SQL migrations, not Supabase CLI, so we are not locked in. |
| **Auth** | Supabase Auth | Email/password + magic link out of the box. JWTs carry our custom `tenant_id` claim via an `on_auth_user_created` trigger. |
| **File storage** | Supabase Storage | Private buckets: `production-files` (original attachments + generated exports), `non-production-files` (ignored files). Signed URLs for ad-hoc download. |
| **Source control** | GitHub | Repo: `jcnewport/ProductionAggregator_App`. Railway watches `main`. |
| **Email** | Google Workspace (Gmail API) | Caleb already had a Workspace tenant for `stewardship.is`. Aliases on a single mailbox is the cheapest way to give every tenant a unique destination. |

## What we explicitly do NOT use (and why)

- **No ORM** (no Prisma, no Drizzle). We use `@supabase/supabase-js` for typical reads/writes and raw SQL for migrations. An ORM would obscure RLS behavior and add a second source of truth for schema.
- **No charting library** (no Recharts, no Chart.js). The Monthly Production Overview chart is inline SVG (see `web/src/components/MonthlyProductionChart.tsx`). Saves ~200KB of bundle for two charts.
- **No state library** (no Redux, no Zustand). React's built-in `useState`/`useEffect` is plenty for this app's complexity.
- **No worker queue** (no BullMQ, no Inngest, no Trigger.dev). Cron in-process plus a `next_retry_at` column on `email_log` is enough — see [retry worker](../backend/02-parsers.md#retry-worker).
- **No GraphQL**. Plain REST. PostgREST (Supabase's auto-API) handles the bulk of read/write from the frontend; Express handles the things PostgREST can't do (file streaming, multi-step transactions).
- **No CSS framework**. The brand palette is in `web/src/theme.ts`. Inline styles only.

## Why the stack will remain this way unless something breaks

The system is in a stabilization period (see `STABILIZATION_PLAYBOOK.md`). The bar to add a dependency is high: it has to solve a problem that the existing stack can't solve cleanly. "It would be nicer" is not enough. "This bug recurs and the dependency would prevent it" is enough.

## Dependency cost summary

Add up the moving parts:

- 1 Railway service (≈ $5–20/mo at our scale)
- 1 Supabase project (free tier; will hit $25/mo Pro once storage exceeds free tier)
- 1 Google Workspace user for the shared inbox (already paid for)
- 1 GitHub private repo (free)

Total monthly run cost: under $50 while traffic stays in current ballpark.
