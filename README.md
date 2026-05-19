# ProductionAggregator_App

**Stewardship.IS Production Data Aggregator** — a multi-tenant SaaS that ingests oil & gas operator production reports from a shared Gmail inbox, parses 10+ distinct file formats, and exports a consolidated ComboCurve-formatted Excel.

Live URL: [productionaggregator.stewardship.is](https://productionaggregator.stewardship.is)

---

## The 60-second pitch

Operators send production reports (Excel and PDF) to a tenant-specific Gmail alias. Within minutes, the system:

1. Downloads the attachments via Gmail API
2. Identifies the operator's format (PDS PDF? Aftermath CSV? BTA multi-sheet XLSX? Hierarchical allocated XLSX?)
3. Maps to the standard 16-column ComboCurve template
4. Stores parsed rows in Supabase Postgres

A tenant user logs in, picks a date range, and downloads a single Excel that matches their reserves software's import spec exactly. **No copy-paste. No reformatting. No spreadsheet gymnastics.**

---

## Where to start reading

> **The full documentation lives in [`docs/`](docs/).** Start with [docs/README.md](docs/README.md) — it's the index.

- **First time here?** Read [docs/architecture/01-overview.md](docs/architecture/01-overview.md) (10 min).
- **Need to fix a broken parser?** [docs/runbooks/parser-failing.md](docs/runbooks/parser-failing.md).
- **Adding a new operator?** [docs/backend/05-adding-a-new-parser.md](docs/backend/05-adding-a-new-parser.md).
- **Understanding the database?** [docs/database/01-schema.md](docs/database/01-schema.md) and [docs/database/02-rls-and-tenancy.md](docs/database/02-rls-and-tenancy.md).
- **Onboarding a new client?** [docs/operations/04-onboarding-new-client.md](docs/operations/04-onboarding-new-client.md) and [`ONBOARDING_NEW_CLIENT.md`](ONBOARDING_NEW_CLIENT.md).

The documentation is structured so a competent developer can pick up this codebase **using only what is in this repo**, without access to the original author. If you find a gap, please add to the docs and PR it.

---

## Quick start (local dev)

Requires Node 20+ and access to a Supabase project (read-only is fine for most work; service-role key needed for parser tests).

```bash
git clone https://github.com/jcnewport/ProductionAggregator_App.git
cd ProductionAggregator_App

npm install
cd api && npm install && cd ..
cd web && npm install && cd ..

# Fill in env vars (see docs/operations/02-secrets-and-env.md):
cp api/.env.example api/.env
cp web/.env.example web/.env

# Run frontend (Vite dev server, http://localhost:5173):
cd web && npm run dev

# In a second terminal, run api (tsx watch, http://localhost:3001):
cd api && npm run dev
```

Full deployment notes: [docs/operations/01-deployment.md](docs/operations/01-deployment.md).

---

## Repo layout

```
ProductionAggregator_App/
├── api/                                 ← Express + TypeScript backend
│   ├── src/
│   │   ├── index.ts                     ← server entry, route registration, cron setup
│   │   ├── middleware/                  ← auth, RLS, CORS, rate-limit
│   │   ├── routes/                      ← HTTP endpoints
│   │   ├── services/                    ← email poller, retry worker, export builder, Supabase client
│   │   └── parsers/                     ← one TypeScript adapter per operator format + registry
│   ├── migrations/                      ← multi-tenancy migrations
│   ├── scripts/                         ← peek tools, parser tests, one-off utilities
│   └── package.json
├── web/                                 ← React + Vite frontend
│   └── src/
│       ├── App.tsx, main.tsx            ← entry
│       ├── pages/                       ← Dashboard, Monthly Export, Daily Export, Admin, etc.
│       ├── components/                  ← shared UI (Layout, ExportPanel, chart)
│       ├── auth/                        ← Supabase Auth wrappers + route guards
│       └── theme.ts                     ← brand palette + design tokens
├── supabase/migrations/                 ← core schema, RLS, RPCs
├── mappings/                            ← per-operator JSON config (reserved for future data-driven engine)
├── templates/                           ← reference for the ComboCurve master template
├── design_mockups/                      ← static design references
├── docs/                                ← ★ canonical documentation ★
├── ONBOARDING_NEW_CLIENT.md             ← step-by-step client onboarding runbook
├── STABILIZATION_PLAYBOOK.md            ← post-launch watch-period guide
├── RAILWAY_SETUP.md                     ← first-time Railway provisioning
├── GITHUB_SETUP.md                      ← first-time GitHub provisioning
└── COWORK_HANDOFF_v2.md                 ← historical context (April 2026); see docs/ for current state
```

---

## Tech stack at a glance

| Layer | Tool |
|---|---|
| Backend | Node 20+ · TypeScript · Express · node-cron |
| Frontend | React 18 · Vite · react-router-dom · inline-SVG charts |
| Database | Supabase (Postgres 17) with RLS-based multi-tenancy |
| Auth | Supabase Auth (email/password + magic link) |
| Storage | Supabase Storage (`production-files`, `non-production-files` buckets) |
| Email | Gmail API (OAuth refresh token) |
| Hosting | Railway (single service for API + cron + static frontend) |
| Source control | GitHub (`main` is the deploy branch; Railway auto-deploys) |

Why each: [docs/architecture/03-tech-stack.md](docs/architecture/03-tech-stack.md).
Why not the obvious alternative: [docs/architecture/04-decisions.md](docs/architecture/04-decisions.md).

---

## Current state (2026-05-19)

- **1 tenant** in production (Frio Energy Partners)
- **17 operators** ingested (Anadarko/OXY, EOG, BTA, Mewbourne, XTO, ConocoPhillips, Diamondback, Diversified, Matador, Chevron, Strata, Arlo, Notting Hill, …)
- **24 operator-format parsers** implemented
- **~129K** monthly production rows · **~57K** daily rows · **999** wells
- **0** flagged records open (clean)
- **130 / 133** ingested emails completed (3 ignored as non-production); 0 failed

Live snapshot kept in [docs/operations/system-state-2026-05-19.md](docs/operations/system-state-2026-05-19.md).

---

## Contributing

Direct pushes to `main` are the norm for small/cosmetic changes (UI tweaks, copy, dashboard tweaks) — Railway redeploys in ~3 minutes.

Risky changes (DB migrations, parser logic, schema changes, anything touching production data flow) go through a feature branch + manual review on github.com first.

See [docs/operations/01-deployment.md](docs/operations/01-deployment.md#branching-strategy) and [docs/backend/05-adding-a-new-parser.md](docs/backend/05-adding-a-new-parser.md) for the full workflow.

---

## License

Private. Proprietary to Stewardship.IS, Inc.
