# 02 · System Diagram

This document is the picture-level reference: who talks to whom, in what order, with what data.

## End-to-end data flow

```
┌──────────────────────────────────────────────────────────────────────┐
│  Operators (external — Anadarko, EOG, BTA, Mewbourne, XTO, …)        │
│  Send production reports to per-tenant Gmail aliases                  │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ SMTP
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Google Workspace / Gmail                                             │
│  Inbox: S.IS_AD_Prod@stewardship.is                                   │
│  Aliases per tenant: <tenant-slug>.prod@stewardship.is                │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ Gmail API (OAuth refresh token)
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Railway service: ProductionAggregator API                            │
│  Single Node process, runs three things:                              │
│    1. HTTP server (Express)        — frontend + API                   │
│    2. Email poller cron            — every 5 min                      │
│    3. Retry worker cron            — every 10 min                     │
└──────┬──────────────────────────┬────────────────────────────────────┘
       │                          │
       │ writes parsed rows       │ writes original attachments
       ▼                          ▼
┌─────────────────────┐  ┌──────────────────────────────────────┐
│  Supabase Postgres  │  │  Supabase Storage                     │
│                     │  │                                       │
│  tenants            │  │  production-files/        ← parsed    │
│  user_tenants       │  │  non-production-files/    ← ignored   │
│  operators          │  │  exports/YYYY/MM/         ← outputs   │
│  wells              │  └──────────────────────────────────────┘
│  well_name_aliases  │
│  combocurve_wells   │
│  format_mappings    │
│  email_log          │
│  production_monthly │
│  production_daily   │
│  flagged_records    │
│  non_production_… │
│  exports            │
│                     │
│  RLS: tenant_       │
│  isolation on every │
│  data table         │
└──────────┬──────────┘
           │ SQL via PostgREST + Supabase JS client
           ▼
┌──────────────────────────────────────────────────────────────────────┐
│  React frontend (served by the same Railway service in prod)          │
│                                                                       │
│  Public routes:      /login                                           │
│  Tenant user:        /dashboard, /export/monthly, /export/daily,      │
│                      /export/history                                  │
│  Super-admin only:   /admin (tenants, users, mappings, retries)       │
└──────────────────────────────────────────────────────────────────────┘
```

## The poller's view of one message

```
1. Gmail API: list messages with label "INBOX" after last_processed_at
2. For each message:
   a. Read To: header → resolve to a tenant via tenants.email_alias
   b. INSERT into email_log (gmail_message_id, sender, subject, tenant_id, status='pending')
   c. Download every attachment
   d. For each attachment:
      i.   Run nonProductionFilters → if matched, INSERT into non_production_files, skip parse
      ii.  Build ParserContext (filename, sender, file bytes, lazily-extracted PDF text or workbook)
      iii. Iterate parser registry in order; first adapter whose detect() returns true wins
      iv.  If no adapter matches → INSERT row into flagged_records with reason='unknown_format'
      v.   Otherwise: adapter.parse() → ProductionRecord[]
      vi.  productionStorage.upsertBatch() resolves well_id (via wells + well_name_aliases),
           sets tenant_id, and UPSERTs into production_monthly or production_daily
           (keyed on (well_id, prod_date)).
      vii. Any row that fails normalization (e.g. unresolvable well name + no API) →
           flagged_records, NOT silent drop.
   e. Update email_log.status → 'completed' (or 'failed' / 'partial' depending on outcomes)
   f. UPDATE last_processed_at watermark
```

## The export's view

```
1. GET /api/export/monthly?start=YYYY-MM&end=YYYY-MM[&operator_id=UUID]
2. middleware/security.ts:
   - requireAuthMaybe → verifies Supabase JWT, sets req.user
   - requireTenantMaybe → resolves the user's current tenant
3. routes/exports.ts:
   - parseMonthStart / parseMonthEnd → YYYY-MM-DD bounds
   - services/comboCurveExport.ts:
     a. SELECT FROM production_monthly with tenant_id filter (RLS also enforces this)
     b. Sort by api10, prod_date
     c. Build XLSX in the 16-column ComboCurve template
     d. Best-effort: upload buffer to Supabase Storage, INSERT exports row
   - Stream XLSX back to client with attachment Content-Disposition
4. Frontend triggers a browser download via blob URL
```

## Multi-tenant request flow

Every authenticated request runs through `current_tenant_id()` in Postgres. The function reads `request.jwt.claims->>'tenant_id'`, which is set in two ways:

- **Frontend reads:** the Supabase JS client sends the user's session JWT. The JWT was minted with a `tenant_id` claim when the user authenticated.
- **Backend writes:** the Express middleware reads the same JWT, sets `req.user.tenant_id`, and includes it in INSERT/UPSERT payloads explicitly (defense in depth; RLS will reject mismatches anyway).

Super-admin bypass: `is_super_admin()` returns true if `user_tenants.is_super_admin = true` for the current user. Every RLS policy is of the form `(is_super_admin() OR tenant_id = current_tenant_id())`.

## What runs where

| Component | Process | Lifecycle |
|---|---|---|
| HTTP API + static frontend | Railway service, `node dist/index.js` | Always on |
| Email poller | node-cron inside same process | Every 5 min |
| Retry worker | node-cron inside same process | Every 10 min |
| Database | Supabase managed Postgres | Always on |
| File storage | Supabase Storage | Always on |
| Auth | Supabase Auth | Always on |
| Source of truth for code | GitHub `main` branch | Railway auto-deploys on push |

There is **no separate worker service**. The cron jobs run in-process. This is deliberate — see [04-decisions.md](04-decisions.md#why-one-process-not-a-worker-fleet).
