# 01 · API Routes

Every HTTP endpoint exposed by the Railway service. The Express server is `api/src/index.ts`; route modules live in `api/src/routes/`.

## Public

| Method | Path | What it does |
|---|---|---|
| GET | `/health` | Liveness check — returns `{ status: "ok", service, timestamp }`. No auth. |

## Triggered by ops (super-admin only)

| Method | Path | What it does |
|---|---|---|
| POST | `/api/poll` | Manually runs one email-poller pass. Useful for testing. |

## Export endpoints

Auth: requires Supabase JWT. RLS scopes to the caller's tenant.

| Method | Path | What it does |
|---|---|---|
| GET | `/api/export/monthly?start=YYYY-MM&end=YYYY-MM[&operator_id=UUID]` | Streams an XLSX in the ComboCurve 16-column format with all monthly rows in range |
| GET | `/api/export/daily?start=YYYY-MM-DD&end=YYYY-MM-DD[&operator_id=UUID]` | Same, for `production_daily` |

**Response headers:**
- `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
- `Content-Disposition: attachment; filename="ComboCurve_<type>_<start>_to_<end>.xlsx"`
- `X-Export-Row-Count`: number of data rows
- `X-Export-Well-Count`: distinct wells in the export

**Side effects:**
- Successful exports upload the XLSX buffer to Supabase Storage (`production-files/exports/YYYY/MM/<uuid>.xlsx`)
- Insert a row into `exports` table for history (best-effort; XLSX still streams if storage/log fails)

**Source:** `api/src/routes/exports.ts`, builder in `api/src/services/comboCurveExport.ts`.

## Export history

| Method | Path | What it does |
|---|---|---|
| GET | `/api/exports?limit=N&before=cursor` | Paginated list of past exports, newest first |
| GET | `/api/exports/:id` | Single export row (metadata) |
| GET | `/api/exports/:id/download` | 302 redirect to a signed Supabase Storage URL for the original XLSX |

**Source:** `api/src/routes/exportHistory.ts`.

## Admin (super-admin only)

Mounted at `/api/admin/`. The `requireSuperAdmin` middleware checks `is_super_admin = true` on `user_tenants`.

### Format mappings

(Reserved for the future data-driven parser engine; currently unused but the CRUD routes are in place.)

| Method | Path | What it does |
|---|---|---|
| GET | `/api/admin/mappings?operator=X&type=monthly\|daily` | List mappings |
| GET | `/api/admin/mappings/:id` | Single mapping |
| POST | `/api/admin/mappings` | Create |
| PUT | `/api/admin/mappings/:id` | Update |
| DELETE | `/api/admin/mappings/:id` | Delete |
| POST | `/api/admin/mappings/validate` | Structural JSON check only — no file required |
| POST | `/api/admin/mappings/test` (multipart) | Dry-run a mapping config against an uploaded sample file |
| GET | `/api/admin/mappings/operators/list` | Operator dropdown source for the mapping UI |

**Source:** `api/src/routes/mappings.ts`. The same router is also mounted at `/api/admin/mappings` to keep paths stable.

### Tenancy / onboarding

| Method | Path | What it does |
|---|---|---|
| POST | `/api/admin/onboarding/tenants` | Create tenant (name, slug, email_alias) |
| GET | `/api/admin/onboarding/tenants` | List all tenants |
| POST | `/api/admin/onboarding/tenants/:id/deactivate` | Soft-disable |
| POST | `/api/admin/onboarding/tenants/:id/reactivate` | Re-enable |
| POST | `/api/admin/onboarding/invite` | Invite a user via Supabase Auth + create `user_tenants` row |

**Source:** `api/src/routes/onboarding.ts`. Used by the Admin page in the frontend.

### Retry and reprocess

| Method | Path | What it does |
|---|---|---|
| POST | `/api/admin/reprocess-email` | `{ emailLogId?, gmailMessageId? }` — wipe parsed rows and re-run parser for one email |
| POST | `/api/admin/reprocess-failed` | `{ statuses?, limit? }` — bulk-replay failed emails |
| POST | `/api/admin/retry-now` | `{ emailLogId }` — fire the retry worker on a specific email immediately |
| POST | `/api/admin/retry-pass` | `{ max? }` — run one full retry-worker pass |
| GET | `/api/admin/retries-due?limit=N` | List emails currently scheduled for retry |
| POST | `/api/admin/send-alert` | `{ emailLogId, force? }` — manually send the permanent-failure alert |

**Source:** `api/src/routes/admin.ts`.

## Flagged records

Auth: tenant-scoped via RLS.

| Method | Path | What it does |
|---|---|---|
| GET | `/api/flagged-records?limit=50&since=YYYY-MM-DD` | List flagged rows |
| GET | `/api/flagged-records/summary` | Counts grouped by reason |

**Source:** `api/src/routes/flaggedRecords.ts`.

## Non-production files

Auth: tenant-scoped via RLS.

| Method | Path | What it does |
|---|---|---|
| GET | `/api/non-production-files` | List filtered attachments |
| GET | `/api/non-production-files/:id/url` | Signed download URL |

**Source:** `api/src/routes/nonProductionFiles.ts`.

## Middleware applied to every route

In order:

1. **helmet** — security headers (with CSP disabled because the Vite bundle uses inline styles)
2. **cors** — allowlist-based; the allowlist is in `buildCorsOptions()` in `middleware/security.ts`
3. **globalLimiter** — per-IP rate limit
4. **express.json** — parse JSON bodies

Then per route:
- **requireAuthMaybe** — verifies the Supabase JWT, sets `req.user`. Routes that need auth assert that `req.user` is set.
- **requireTenantMaybe** — resolves the user's tenant. Sets `req.tenant`.
- **requireSuperAdmin** — only allows users with `is_super_admin = true` to proceed.
- **adminLimiter** — stricter per-IP rate limit on `/api/admin/*`

## Error format

All routes return errors as JSON:

```json
{
  "ok": false,
  "error": "Human-readable error message"
}
```

with an HTTP 4xx or 5xx status. The error message is safe to display to the user — no stack traces, no internal paths.
