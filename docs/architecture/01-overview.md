# 01 · Overview

## What this is

Stewardship.IS's Production Aggregator is a **multi-tenant SaaS** that solves one problem: every oil & gas operator sends production data in a slightly different file format, and the customer (the working-interest owner / royalty holder) has to consolidate it into a single standardized spreadsheet for their reserves software (ComboCurve).

Before this app: the customer had a person manually copy-pasting cells across 10+ operator file formats every month, spending 6–8 hours per month per portfolio.

After this app: the operator emails the production report to a dedicated address. Within minutes, the app downloads it, identifies the format, normalizes the data, and stores it. The customer logs in, picks a date range, and downloads one consolidated Excel that matches the ComboCurve template exactly.

## Who uses it

| Role | What they do | Where they live |
|---|---|---|
| **Operator** (Anadarko, EOG, BTA, …) | Emails production reports to a per-tenant alias | External, not a user of the app |
| **Tenant user** (e.g. Frio Energy Partners) | Logs in, downloads consolidated Excel | Web app, scoped to their tenant via RLS |
| **Super-admin** (Caleb / Stewardship.IS) | Creates tenants, invites users, manages mappings, reviews flagged records | Web app, sees all tenants |

## The "happy path" in 60 seconds

```
Operator sends an email to clientA@stewardship.is
            │
            ▼  ─── Gmail Workspace receives it as an alias on S.IS_AD_Prod@
            │
Email poller (Railway cron, every 5 min) sees the new message
            │
            ▼
Pulls attachments via Gmail API
            │
            ▼
For each attachment:
  1. Run non-production filters (drilling reports, ComboCurve templates → routed to non_production_files)
  2. Run parser dispatcher — every adapter's detect() is tried in order
  3. Matched adapter parses the file into ProductionRecord[]
  4. Records are upserted into production_monthly OR production_daily (NEVER both)
            │
            ▼
Status flips email_log.status → 'completed'. Tenant user opens the web app.
            │
            ▼
Web app: pick start/end month, optional operator filter, click "Generate & Download"
            │
            ▼
Backend builds an XLSX matching the 16-column ComboCurve template, streams to browser
```

## The "unhappy path"

Anything the dispatcher cannot route lands in `flagged_records` (a row per problem row) or `email_log.status = 'failed'` (when the whole attachment can't be parsed). The dashboard surfaces both. The retry worker picks up retryable failures automatically; permanent failures wait for a human.

## Multi-tenancy in one paragraph

A **tenant** is a paying customer. Each tenant has its own Gmail alias on the shared `S.IS_AD_Prod@stewardship.is` inbox (e.g. `frio.prod@…`, `clientB.prod@…`). When the poller reads a message, it inspects the `To:` header, looks up the matching tenant, and tags every downstream row with `tenant_id`. RLS enforces that a user can only see rows where `tenant_id = current_tenant_id()` — they can never see another tenant's data, regardless of what they query.

## Repo at a glance

```
ProductionAggregator_App/
├── api/                ← Express + TypeScript backend (Railway service)
│   ├── src/
│   │   ├── index.ts                  ← server entry, route registration
│   │   ├── middleware/security.ts    ← auth, RLS, rate-limit
│   │   ├── routes/                   ← HTTP endpoints
│   │   ├── services/                 ← email poller, retry worker, export builder, Supabase client
│   │   └── parsers/                  ← one adapter per operator format + registry
│   ├── migrations/                   ← multi-tenancy migrations (applied via Supabase MCP)
│   └── scripts/                      ← one-off tools, debug peekers, parser tests
├── web/                ← React + Vite frontend (served by api in prod)
│   └── src/
│       ├── App.tsx                   ← route tree
│       ├── pages/                    ← Dashboard, Monthly Export, Daily Export, Admin, etc.
│       ├── components/               ← shared UI
│       ├── auth/                     ← Supabase Auth wrapper, route guards
│       └── theme.ts                  ← brand palette + design tokens
├── supabase/migrations/              ← core schema, RLS, RPCs
├── mappings/                         ← per-operator JSON config (future — code-based today)
├── templates/                        ← reference for the ComboCurve master template
├── design_mockups/                   ← static design refs
└── docs/                             ← this directory
```

Two backend deploy targets share the same Railway service: **the API** and **the email-poller cron**. They run in the same Node process (the cron is registered in `api/src/index.ts` at startup).

## Key external dependencies

- **Supabase** (Postgres + Auth + Storage) — project ID `sdnpvclmfezesgqeudzu`
- **Railway** — single service, single environment (`production`); auto-deploys on push to `main`
- **Google Workspace / Gmail API** — monitors `S.IS_AD_Prod@stewardship.is`
- **GitHub** — repo `jcnewport/ProductionAggregator_App`, private

See [03-tech-stack.md](03-tech-stack.md) for why each was chosen.
