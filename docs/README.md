# Production Aggregator Documentation

This is the canonical documentation for the **Stewardship.IS Production Aggregator** — a multi-tenant web application that monitors a Gmail inbox for operator production reports, parses them, stores normalized data in Supabase, and exports a 16-column ComboCurve-formatted Excel file.

The goal of these docs is simple: **a competent developer should be able to take over this system using only what is in this repository**, with no access to the original author and no access to private chat history. Every architectural decision, every business rule, every operational procedure is recorded somewhere in `docs/`.

---

## How this documentation is organized

Read in this order if you are new to the project. Skim section 1, then jump to whichever section is relevant to your task.

| Section | When to read it |
|---|---|
| **[architecture/](architecture/)** | First. What this is, what it's made of, why those choices. |
| **[domain/](domain/)** | When you need to understand the oil & gas business logic — formats, units, master template. |
| **[database/](database/)** | When you're writing a query, adding a migration, or debugging RLS. |
| **[backend/](backend/)** | When you're touching the API, the parser registry, the email poller, or exports. |
| **[frontend/](frontend/)** | When you're touching the React app. |
| **[operations/](operations/)** | When you're deploying, rotating a secret, onboarding a client, or watching production health. |
| **[runbooks/](runbooks/)** | When something is broken at 7am and you need a procedure. |

---

## Quick map

### Architecture
- [01-overview.md](architecture/01-overview.md) — what this is and the 60-second mental model
- [02-system-diagram.md](architecture/02-system-diagram.md) — end-to-end request flow
- [03-tech-stack.md](architecture/03-tech-stack.md) — every tool we use and why
- [04-decisions.md](architecture/04-decisions.md) — non-obvious architectural choices, recorded so future-you doesn't re-litigate them

### Domain (oil & gas)
- [01-master-template.md](domain/01-master-template.md) — the 16-column ComboCurve export format (the gold standard)
- [02-operator-catalog.md](domain/02-operator-catalog.md) — every operator format we recognize, with mapping quirks
- [03-oil-and-gas-rules.md](domain/03-oil-and-gas-rules.md) — units, API number formats, gross vs net, edge cases
- [04-data-handling-rules.md](domain/04-data-handling-rules.md) — monthly vs daily vs weekly, and the rules that keep them separate

### Database
- [01-schema.md](database/01-schema.md) — every table and every column
- [02-rls-and-tenancy.md](database/02-rls-and-tenancy.md) — multi-tenant model and every RLS policy
- [03-rpc-functions.md](database/03-rpc-functions.md) — Postgres functions callable from the app
- [04-migrations.md](database/04-migrations.md) — how migrations work, the two-directory layout, and how to add one

### Backend (`api/`)
- [01-api-routes.md](backend/01-api-routes.md) — every HTTP endpoint, what it does, who can call it
- [02-parsers.md](backend/02-parsers.md) — parser interface, registry, dispatcher
- [03-email-poller.md](backend/03-email-poller.md) — Gmail polling, attachment handling, retry logic
- [04-export-generation.md](backend/04-export-generation.md) — how XLSX files are built
- [05-adding-a-new-parser.md](backend/05-adding-a-new-parser.md) — recipe for onboarding a new operator format

### Frontend (`web/`)
- [01-pages-and-routes.md](frontend/01-pages-and-routes.md) — every route in the React app
- [02-auth-and-tenants.md](frontend/02-auth-and-tenants.md) — Supabase Auth flow, tenant context, super-admin
- [03-components.md](frontend/03-components.md) — shared components, design tokens, the chart

### Operations
- [00-fresh-install.md](operations/00-fresh-install.md) — **standing up a new copy from scratch** (cold-start playbook)
- [01-deployment.md](operations/01-deployment.md) — Railway and Supabase deploy flow
- [02-secrets-and-env.md](operations/02-secrets-and-env.md) — every environment variable, where it lives, how to rotate it
- [03-monitoring.md](operations/03-monitoring.md) — logs, health checks, alerts
- [04-onboarding-new-client.md](operations/04-onboarding-new-client.md) — bringing a new tenant online (see also the original `ONBOARDING_NEW_CLIENT.md` in repo root)
- [05-stabilization-playbook.md](operations/05-stabilization-playbook.md) — what to watch when the system is in a "letting it bake" period (see also the original `STABILIZATION_PLAYBOOK.md`)

### Runbooks (incident response)
- [gmail-poller-stopped.md](runbooks/gmail-poller-stopped.md)
- [parser-failing.md](runbooks/parser-failing.md)
- [unknown-operator-format.md](runbooks/unknown-operator-format.md)
- [flagged-records-buildup.md](runbooks/flagged-records-buildup.md)
- [rollback-a-bad-deploy.md](runbooks/rollback-a-bad-deploy.md)

---

## Companion files in repo root

The following pre-existing docs are still authoritative and should be read in addition to the `docs/` tree:

- **[README.md](../README.md)** — repo front door
- **[ONBOARDING_NEW_CLIENT.md](../ONBOARDING_NEW_CLIENT.md)** — step-by-step client onboarding (referenced by `operations/04-onboarding-new-client.md`)
- **[STABILIZATION_PLAYBOOK.md](../STABILIZATION_PLAYBOOK.md)** — daily/weekly health checks
- **[RAILWAY_SETUP.md](../RAILWAY_SETUP.md)** — first-time Railway provisioning
- **[GITHUB_SETUP.md](../GITHUB_SETUP.md)** — first-time GitHub provisioning
- **[COWORK_HANDOFF_v2.md](../COWORK_HANDOFF_v2.md)** — historical handoff doc; useful for context, but the docs/ tree is now the canonical reference

---

## Conventions in these docs

- **File paths** are written relative to the repo root unless otherwise noted (e.g. `api/src/index.ts`).
- **Dates** are ISO format `YYYY-MM-DD`.
- **Code snippets** use the same line numbering as the actual source files where possible.
- **"Operator"** = oil & gas company that drills/runs wells (Anadarko, EOG, BTA, etc.).
- **"Tenant"** = paying customer of Stewardship.IS — the company that owns the data on the other side of the export. There is currently one tenant: Frio Energy Partners.
- **"PDS"** = PDS Energy's "Well Data Exchange" platform, which several operators use to distribute production data. PDS reports come as PDFs.

---

*Last refreshed: 2026-05-19. Snapshot of live-system facts in [operations/system-state-2026-05-19.md](operations/system-state-2026-05-19.md).*
