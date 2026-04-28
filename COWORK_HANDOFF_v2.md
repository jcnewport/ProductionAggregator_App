# PRODUCTION AGGREGATOR — COWORK HANDOFF DOCUMENT

> **READER: This document is written for Claude (the AI), not for a human.** It is the canonical context handoff for the Production Aggregator project.
>
> **Revision history:**
> - **v1 (2026-04-28 morning, pre-Cowork):** initial handoff written before the Cowork project was created.
> - **v2 (2026-04-28 afternoon, this version):** corrected against live system state — DB schema, Railway deploys, GitHub commits, Gmail. Removed inaccurate claims from v1. Major corrections noted inline.

---

## 0. PRECEDENCE RULES (READ FIRST)

When information conflicts, resolve in this order:

1. **The user's current message** — always wins.
2. **Live system state** — what Supabase, GitHub, Railway, or Gmail actually show RIGHT NOW. Always verify before acting on assumptions. Use the Supabase MCP, `git log` in the repo, and the Railway dashboard.
3. **This handoff document, Section 4 (LIVE SYSTEM STATE — KNOWN AS OF 2026-04-28 v2)**.
4. **This handoff document, Sections 5–10** — durable design facts.
5. **This handoff document, Section 11 (HISTORICAL TIMELINE)**.
6. **Caleb's user preferences** — Caleb, age 40, solopreneur, zero coding background, visual learner. Use the VP-with-30-years-experience persona.
7. **The original architecture Word doc** (`Production_Data_Pipeline_Architecture.docx`) — superseded by what the repo actually implements. Don't reference it for stack decisions.

When in doubt, **ask Caleb a single clear question** rather than guessing. Use `AskUserQuestion` with 2–4 button options.

**META PRINCIPLE — VERIFY BEFORE PROPOSING.** Caleb runs lean and dislikes clutter. Before proposing any work, check whether it's already done. Run the SQL, read the git log, look at the live system. If the app is healthy and a "gap" only exists in old design docs, don't manufacture a fix.

---

## 1. THE USER (CALEB) — OPERATING PROFILE

- **Name:** Caleb
- **Age:** 40
- **Background:** Zero technical/coding/dev experience
- **Business stage:** Solopreneur, startup mode
- **Company:** Stewardship (referenced internally as "Stewardship.IS")
- **Role you (Claude) play:** Tech VP with 30 years of experience.
- **Communication style he prefers:**
  - Detailed step-by-step instructions for anything that touches a UI
  - Screenshots / visual guidance when instructing him to click around (visual learner)
  - Balanced responses: reality + options + timing + cost + offer to walk through any component
  - Build-vs-buy recommendations
  - Pragmatic dream-big-with-a-roadmap framing
- **Things he is NOT comfortable with:** Reading code, debugging stack traces, writing SQL, terminal commands without explicit guidance.
- **Things he IS comfortable with:** Oil & gas domain terminology (API-14, MCF, bbls, BS&W, PDSWDX, decline curves, vintages, choke values, downtime, casing/tubing pressure), client conversations, business strategy, file uploads/downloads, GitHub Desktop (basic), Supabase dashboard (basic).
- **Workflow preference:** **Design before coding.** Never skip straight to implementation.
- **Tone preference:** Concise. Don't add clutter. Don't propose work that doesn't need doing.

---

## 2. PROJECT OVERVIEW (60-SECOND SUMMARY)

**Production Aggregator** consolidates oil & gas production data from multiple operators across multiple US states into a single normalized database, then exports it to Caleb's client in the PDSWDX 16-column format.

**Two user groups:**
- **Internal team** — uploads source files, monitors ingestion
- **Client (Frio Energy Partners — Aaron Davis, CEO)** — read-only access to exports

**Core data flow:**
```
Email attachments / manual uploads / web downloads
        ↓
Gmail (S.IS_AD_Prod@stewardship.is) poller
        ↓
Format detection → operator-specific parser
        ↓
Normalization (canonical ProductionRecord shape)
        ↓
Supabase PostgreSQL (project ref: sdnpvclmfezesgqeudzu)
        ↓
PDSWDX 16-column Excel export → client
```

**Refresh cadence:** ~2× per month per operator.
**Scale:** ~16 operators, ~979 wells.
**Future feature:** Forecast vs. Actuals (deferred, awaiting Aaron Davis signoff).

---

## 3. THE TECH STACK (AS BUILT)

| Layer | Technology | Notes |
|---|---|---|
| Database | **Supabase PostgreSQL** | Project ref: `sdnpvclmfezesgqeudzu` |
| File storage | Supabase Storage | Raw files preserved alongside DB |
| Backend / API | **Node.js + TypeScript on Railway** | Single language across api+web. Railway auto-deploys from `main` branch on GitHub push. |
| Email ingestion | Gmail (Google Workspace) poller built into the Node API | Inbox: `S.IS_AD_Prod@stewardship.is` |
| File parsing | TypeScript adapters (one per format), `pdf-parse` (positional x/y) and `exceljs`/`SheetJS` for spreadsheets | See Section 7 |
| Frontend | Next.js / React | Has a "reprocess" button on the ingestion log; full UI inventory not fully mapped |
| Excel export | TypeScript export module producing PDSWDX 16-column format | Working as of 2026-04-25 (last export run) |
| Source control | GitHub — repo `jcnewport/ProductionAggregator_App` | Caleb commits + pushes via GitHub Desktop |
| Deploy | Railway, auto-deploy on push to `main` | |
| **Multi-tenancy** | **Tenant-scoped tables with `tenant_id` column** | **Added in 5 phases between ~2026-04-22 and 2026-04-22 (commits `20f3c28` through `008d247`).** Currently 1 tenant, 3 user-tenant links. RLS enforces isolation. Super-admin users bypass scoping. |

**Repo monorepo layout:**
```
ProductionAggregator_App/
├── api/                # Node + TypeScript backend
│   └── src/parsers/    # One .ts file per operator format (see Section 7)
├── web/                # Next.js frontend
├── mappings/           # Config-driven JSON field mappings
├── templates/
├── supabase/
│   └── migrations/     # SQL migrations
├── ONBOARDING_NEW_CLIENT.md   # ← guide for tenant onboarding
├── STABILIZATION_PLAYBOOK.md
└── package.json
```

---

## 4. LIVE SYSTEM STATE — KNOWN AS OF 2026-04-28 (v2)

> Verified directly against Supabase + GitHub on 2026-04-28 afternoon.

| Metric | Value | Source |
|---|---|---|
| Operators | **16** | `operators` rowcount |
| Wells | **979** (all with API10) | `wells` rowcount |
| Wells linked to CC | **849** | `wells.combocurve_well_id IS NOT NULL` |
| Daily production rows | **48,642** | `production_daily` rowcount |
| Monthly production rows | **1,870** | `production_monthly` rowcount |
| Email log rows | **37** (35 completed, 2 ignored, **0 failed lifetime**) | `email_log` |
| Emails ingested last 7d | **18** | `email_log.received_at >= NOW() - 7 days` |
| Last email received | **2026-04-27 17:36 UTC** | `email_log` |
| Last daily row inserted | **2026-04-27 18:21 UTC** | `production_daily.created_at` |
| Last monthly row inserted | **2026-04-22 16:09 UTC** | `production_monthly.created_at` |
| Flagged records | **0** | `flagged_records` |
| ComboCurve forecast wells loaded | **627** | `combocurve_wells` |
| Client-facing exports run | **4** (last: 2026-04-25) | `exports` |

**System health verdict:** Healthy. No flagged records, no failed emails, ingestion ran through yesterday afternoon. The "client_well_id gap" v1 of this doc claimed is **resolved** — see Section 8.

**Phase status (verified 2026-04-28):**
- Phase 1 — Foundation: ✅
- Phase 2 — Parser Core (10 formats): ✅
- Phase 3 — Upload Interface: 🟡 partial; reprocess button exists; full UI not mapped
- Phase 4 — Excel Export (PDSWDX): ✅ (4 successful exports)
- Phase 5 — Email Ingestion: ✅
- Phase 6 — Dashboard & monitoring: 🟡 partial
- Phase 7 — Forecasts: 🟡 deferred pending Aaron's response
- **Multi-tenancy (added late):** ✅ all 5 phases shipped (commits `20f3c28` → `008d247`, ~2026-04-22)

---

## 5. DATABASE SCHEMA (AS DEPLOYED — VERIFIED 2026-04-28)

> v1 of this doc had several wrong table and column names. These are the actual deployed names. Always cross-check with `Supabase:list_tables` before writing SQL.

### Tables (12 total in public schema)

| Table | Rows | Purpose |
|---|---:|---|
| `operators` | 16 | Master operator list |
| `wells` | 979 | Well registry |
| `well_name_aliases` | 253 | Fuzzy-match aliases for wells |
| `production_daily` | 48,642 | Daily production records |
| `production_monthly` | 1,870 | Monthly production records |
| `email_log` | 37 | Email ingestion audit trail (was called `ingestion_log` in v1 — wrong) |
| `format_mappings` | 0 | Operator format configs (was called `field_mappings` in v1) |
| `combocurve_wells` | 627 | ComboCurve well registry imported from client |
| `flagged_records` | 0 | Rows that failed ingestion (currently empty) |
| `exports` | 4 | Generated client exports |
| `tenants` | 1 | Multi-tenancy: client companies |
| `user_tenants` | 3 | Multi-tenancy: user→tenant mapping |

### `wells` columns (verified)
- `id` (uuid, PK)
- `well_name` (text, NOT NULL)
- `api14` (text) — note: `api14` not `api_14`
- `api10` (text) — note: `api10` not `api_10`
- `combocurve_well_id` (bigint) — links to `combocurve_wells.chosen_id`. Was called `combocurve_id` in v1 (wrong name).
- `operator_id` (uuid, FK → operators)
- `location_metadata` (jsonb)
- `notes` (text)
- `tenant_id` (uuid, NOT NULL) — **multi-tenancy column**
- `created_at`, `updated_at`

**There is NO `client_well_id` column.** v1 claimed one was needed. It isn't — see Section 8.

### `operators` columns (verified)
- `id` (uuid, PK)
- `name` (text)
- `sender_email_patterns` (text array) — used for sender → operator routing
- `contact_info` (jsonb)
- `notes` (text)
- `created_at`, `updated_at`

There is NO `operator_short_code` or `default_email_domain`. v1 was wrong about this. Operator routing uses `sender_email_patterns` (an array of patterns).

### `production_daily` and `production_monthly` columns (identical except for grain)
- `id`, `well_id` (FK), `well_name`, `api14`, `api10`, `combocurve_well_id` (denormalized cache), `prod_date`
- `gas_prod`, `gas_sales`, `oil_prod`, `oil_sales`, `water_prod`
- `choke` (text — note: stored as text, not numeric, despite v1's claim)
- `tubing_pres`, `casing_pres`, `hours_down`, `water_inj`, `downtime_reason`, `days_on`
- `operator_id`, `source_email_id`, `source_file_name`, `extra_fields` (jsonb)
- `tenant_id` (multi-tenancy)
- `created_at`

**Important:** there is NO `is_current` column and NO `revision_number` column on either table. The "revision system" v1 of this doc described as a critical design pattern is **not implemented**. Re-revised data overwrites or appends as plain rows. If revision-tracking ever becomes a requirement, it's a build-from-scratch task.

### `combocurve_wells` columns (verified)
- `id`, `well_name`, `api14`, `api10`, `api12`
- `chosen_id` (bigint) — **the API10 value as a bigint.** Confirmed by Kyle Parker (Frio): "our Chosen ID which is API10. The Chosen ID maps all data into CC."
- `current_operator` (text)
- `raw_fields` (jsonb) — full original CC export columns
- `source_file`, `imported_at`, `updated_at`

**Note on chosen_id length:** stored as bigint, so leading zeros are stripped. Wells with state codes starting with 0 (e.g. some federal/offshore) end up as 9-digit chosen_ids in the table when their actual API10 is 10 digits. 20 such rows exist as of 2026-04-28. When matching `wells.api10` (text) to `combocurve_wells.chosen_id` (bigint), use:
```sql
cc.chosen_id::text = w.api10 OR cc.chosen_id::text = LTRIM(w.api10, '0')
```

---

## 6. REVISION HANDLING (CURRENT REALITY)

**v1 of this doc claimed there was a revision system with `is_current` and `revision_number` columns. There is not.** Those columns don't exist on either production table. Re-revised data inserts or overwrites without history.

If revision tracking is ever required (regulatory or dispute resolution), it's a from-scratch build. Don't tell Caleb the system "preserves a complete audit history" — it doesn't currently.

---

## 7. PARSER REGISTRY — IMPLEMENTED FORMATS

Each format is a TypeScript adapter under `api/src/parsers/`. The registry detects format by:
- Email sender (matched against `operators.sender_email_patterns`)
- Filename pattern
- File contents (header text, distinctive strings)

| Format | File | Type | Status | Notes |
|---|---|---|---|---|
| BTA Oil Producers Daily | `btaDailyExcel.ts` | Daily Excel | ✅ | One sheet per well |
| Frio Daily Production | `frioDailyExcel.ts` | Daily Excel | ✅ | No API; match on well name |
| Monthly Report | `monthlyReportExcel.ts` | Daily Excel | ✅ | Well name in header row, then daily rows |
| Partner Report — West Pecos | `partnerReportWestPecos.ts` | Daily Excel | ✅ | API-14, OpTm, choke, pressures |
| Pinon Partner Report | `pinonPartnerReport.ts` | Daily Excel | ✅ | Negative production values must be preserved |
| PDSWDX-DP-* CSV | `pdswdxCsv.ts` | Daily CSV | ✅ | Direct load |
| PDS XTO Monthly | `pdsXtoMonthly.ts` | Monthly PDF | ✅ | Reference pattern (positional x/y extraction) |
| PDS Matador Monthly | `pdsMatadorMonthly.ts` | Monthly PDF | ✅ (verified 2026-04-22) | Look-ahead merger for multi-bucket rows; skip "Total :" rows; MMBTUSales is heat content, NOT a sales volume |
| PDS Diamondback Monthly | `pdsDiamondbackMonthly.ts` | Monthly PDF | ✅ (verified 2026-04-22) | Column order INVERTED (Gas Prod before Oil Prod); SSI → `operatorWellId` |
| PDS Diversified Monthly | `pdsDiversifiedMonthly.ts` | Monthly PDF | ✅ (verified 2026-04-22) | wellName splits across 2 y-buckets |

---

## 8. THE PDSWDX EXPORT — 16-COLUMN MAPPING

The client deliverable. **Status: working as of 2026-04-25.** v1 of this doc claimed the Well ID column was an open gap awaiting a "client_well_id" migration. **It isn't.** Commit `caeed5d` ("Fix: Well ID column blank for 30/105 wells in ComboCurve export") closed that loop. The Well ID column is populated from `wells.api10` (which equals `combocurve_wells.chosen_id` for any well that's in CC).

| # | Column | Source | Notes |
|---|---|---|---|
| 1 | Well ID | `wells.api10` (or equivalently `wells.combocurve_well_id`) | This IS the API10. No separate "client_well_id" column. |
| 2 | Well Name | `wells.well_name` | |
| 3 | API14 | `wells.api14` | Nullable |
| 4 | API10 | `wells.api10` | |
| 5 | Prod Date | `production_daily.prod_date` | M/D/YYYY |
| 6–10 | Gas/Oil/Water Prod & Sales | `production_*` columns | |
| 11 | Choke | `production_*.choke` (text — "16/64" format may pass through; verify if changed) | |
| 12–13 | Tubing/Casing Pressures | `production_*.tubing_pres`, `casing_pres` | |
| 14 | Hours Down | `production_*.hours_down` | Often null |
| 15 | Water Inj | `production_*.water_inj` | |
| 16 | Downtime Reason | `production_*.downtime_reason` | Often null |

---

## 9. THE CLIENT — FRIO ENERGY PARTNERS

**Primary client:** Frio Energy Partners (FEP / FEH1)
- **CEO:** Aaron Davis (`adavis@frioenergypartners.com`)
- **Business development:** Kyle Parker (`kparker@frioenergypartners.com`)
- **Stewardship-side monitored inbox:** `S.IS_AD_Prod@stewardship.is`

**ComboCurve well lists Kyle has provided (all loaded into `combocurve_wells`):**
- 2026-04-20: Initial Frio Energy Holdings I / EPK Capital list (57 rows)
- 2026-04-27: Dolan Falls (184 rows) + 6 WPTC chunks (343 rows total) — same-day "Re: CC Wells" thread
- 2026-04-27: NorthHarpoon checklist (25 rows)

Total: 627 rows in `combocurve_wells`. **All loaded — there is no pending Kyle list as of 2026-04-28.**

**Operators with wells we receive production for, but NOT covered in any CC list Kyle has sent:**
- Diversified Energy: 276 wells (monthly only)
- OXY: 83 wells (monthly only)
- BTA Oil Producers: 5 wells (daily + monthly)
- 4 orphan wells with no operator

These are benign — they ingest fine, they just don't have CC chosen_id linkage. If the client ever wants their CC Well IDs in PDSWDX exports for those operators, ask Kyle for CC lists covering whichever entity those operators sit under (likely a different Frio entity from WPTC / Dolan Falls / EPK).

**Outstanding pitch (Aaron Davis):** Forecast vs. Actuals. Three deliverables sent ~2026-04-25:
- `Frio_Email_Draft.txt` — pitch email
- `Frio_Mockups.pdf` — 3-page landscape mockup deck
- `Frio_Forecast_vs_Actuals_Concept_Summary.docx`

**Status:** awaiting Aaron's response. Forecast schema build is **deferred** until he says yes.

---

## 10. EDGE CASES + DATA QUIRKS THAT BIT US (PRESERVE THIS)

These are still all true:

1. **Choke values as fractions.** BTA reports `16/64`, `20/64`. Convert to decimal at parse time if numeric handling is required. (Note: production tables actually store choke as `text`, so the raw fraction may pass through — verify exact behavior before changing.)
2. **Negative production values are legitimate.** Pinon had a `-0.46` oil row. Preserve negatives.
3. **API numbers absent in some formats.** Frio and Monthly Report have no API column. Match by well name; maintain `well_name_aliases`.
4. **API formats vary across operators.** Diamondback 10-digit, Matador 14-digit, Diversified dashed. Normalize via `apiNormalization.ts`.
5. **PDS PDF rows split across multiple y-buckets.** Matador, Diversified. Look-ahead merger handles this.
6. **"Total :" rows in PDS PDFs.** Skip. They double-count if treated as data.
7. **Diamondback column order is INVERTED.** Gas Prod before Oil Prod. Don't assume sibling layouts are interchangeable.
8. **MMBTUSales is heat content, not sales volume.** Store in `extra_fields.mmbtuSales`. Never map to `gas_sales`.
9. **"Daily" vs "Monthly" filename mismatches.** A file titled "Monthly Report" was actually daily-grain. Inspect before deciding grain.
10. **Email sender → operator mapping.** `operators.sender_email_patterns` (text array). Keep accurate.
11. **Chosen ID is API10 stored as bigint.** Leading zeros are stripped. See Section 5 for the join-time normalization pattern.

---

## 11. HISTORICAL TIMELINE

- **2026-04-07:** Architecture & schema designed in `Production_Data_Pipeline_Architecture.docx`. Original recommended Python + Edge Functions. Repo went Node + TypeScript on Railway.
- **2026-04-20:** Phase 1 complete. Schema deployed. Kyle sent first CC well list (Frio Energy Holdings I / EPK Capital, 57 wells).
- **2026-04-21:** New PDS PDFs (Matador, Diamondback, Diversified) appear in inbox; existing parsers were stubs.
- **2026-04-22:** Real PDS parsers implemented + verified end-to-end. Multi-tenancy phases 1–5 shipped (`20f3c28`, `c52b376`, `60b424a`, `008d247`, `5d73c62`). `STABILIZATION_PLAYBOOK.md` and `ONBOARDING_NEW_CLIENT.md` added. **Phase 2 declared complete.**
- **2026-04-25:** Forecast vs. Actuals pitch package built for Aaron. Phase 7 schema build deferred. Last client export run.
- **2026-04-27:** Kyle sent additional CC lists (Dolan Falls + 6 WPTC chunks + NorthHarpoon checklist, 552 new well rows). All ingested into `combocurve_wells` same day.
- **2026-04-28 morning:** v1 of this handoff written.
- **2026-04-28 afternoon:** v1 inaccuracies discovered (table names, schema columns, "client_well_id gap" that didn't exist, "revision system" not implemented, missing multi-tenancy). v2 of this doc written after verification against live system. **System confirmed healthy.**

---

## 12. WHAT TO DO ON THE FIRST INTERACTION

1. **Acknowledge the handoff** briefly. Don't dump it back at Caleb.
2. **Verify live system state** with Supabase MCP and `git log`. The numbers in Section 4 will drift.
3. **Ask what's on deck this session.** Don't assume.
4. **Maintain VP voice.** Detailed step-by-step when UI is involved. Visual aids for clicks.
5. **Verify before proposing work.** If a "gap" only exists in old design docs, don't manufacture a fix. Caleb dislikes clutter.

---

## 13. STANDING OFFERS (STILL OPEN AS OF 2026-04-28 v2)

- Walk through the existing UI together to map what's actually built (the "reprocess button mystery" — there's UI Claude doesn't have a mental model of)
- If/when Aaron responds positively on Forecast vs. Actuals: build forecast schema (Phase 7) — `forecast_vintages`, `forecast_monthly`, etc.
- If/when Diversified / OXY / BTA wells need CC linkage: draft a Kyle email asking for CC lists covering those operators' parent entity

The previous "build well-import staging workflow" and "draft Kyle's well list intake checklist" offers are **withdrawn** — Kyle's lists are landing fine via the existing pipeline; no staging workflow is needed.

---

## 14. MCP CONNECTORS AVAILABLE

- **Supabase** — primary verification tool. Project ref: `sdnpvclmfezesgqeudzu`.
- **Gmail** — `S.IS_AD_Prod@stewardship.is` and Caleb's personal `c@stewardship.is`.
- **Google Drive** — Stewardship working files.
- **Google Calendar** — scheduling.
- **HubSpot** — broader pipeline (separate project).
- **Microsoft 365** — backup access.

---

## 15. CRITICAL DON'Ts

- **DON'T** invent a "client_well_id" column. The Well ID in PDSWDX exports is `wells.api10` / `combocurve_wells.chosen_id`. Both are the same value.
- **DON'T** claim there's a revision system. It isn't built.
- **DON'T** use v1's table or column names — they were wrong. Use Section 5 of v2.
- **DON'T** build `forecast_vintages` / `forecast_monthly` without confirming Aaron has greenlit the pitch.
- **DON'T** delete production data without explicit instruction.
- **DON'T** map MMBTUSales to gas_sales.
- **DON'T** clamp negative production values to zero.
- **DON'T** assume sibling parser layouts are interchangeable. Diamondback inverts Gas/Oil.
- **DON'T** skip the design-before-code step.
- **DON'T** push terminal commands on Caleb. He uses GitHub Desktop, the Supabase web dashboard, and the Railway web dashboard.
- **DON'T** propose work that the running system doesn't actually need. Verify live state first.

---

## 16. END OF HANDOFF (v2)

This document is the canonical project state as of 2026-04-28 afternoon. Update this doc — don't just write a new one — when major facts change.
