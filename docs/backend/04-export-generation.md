# 04 · Export Generation

How the system produces the ComboCurve-formatted XLSX downloads.

## Endpoints

- `GET /api/export/monthly?start=YYYY-MM&end=YYYY-MM[&operator_id=UUID]`
- `GET /api/export/daily?start=YYYY-MM-DD&end=YYYY-MM-DD[&operator_id=UUID]`

Source: `api/src/routes/exports.ts`. Builder: `api/src/services/comboCurveExport.ts`.

## The 16-column output

See [domain/01-master-template.md](../domain/01-master-template.md) for the column-by-column spec. Briefly:

```
Well ID | Well Name | API14 | API10 | Prod Date | Gas Prod | Gas Sales | Oil Prod | Oil Sales | Water Prod | Choke | Tubing Pres. | Casing Pres | Hours Down | Water Inj | Downtime Reason
```

Same columns for monthly and daily exports. Granularity differs only in `Prod Date`.

## The flow

```
1. Express handler in routes/exports.ts:
   a. Parse start/end strings into YYYY-MM-DD bounds
      - month inputs: expand to first-of-start-month through last-of-end-month
      - date inputs: use as-is
   b. Read optional operator_id filter
   c. Read user JWT, attach tenant context

2. comboCurveExport.generateComboCurveExport({ type, start, end, operatorId, tenantId }):
   a. Build the SELECT query:
        SELECT well_name, api14, api10, combocurve_well_id, prod_date, gas_prod, gas_sales, oil_prod, oil_sales, water_prod, choke, tubing_pres, casing_pres, hours_down, water_inj, downtime_reason
        FROM production_<grain>
        WHERE prod_date BETWEEN ? AND ?
          AND (operator_id = ? OR ? IS NULL)
        ORDER BY api10, prod_date
   b. (RLS automatically scopes to tenant_id; super-admin sees all)
   c. Fetch rows in pages (Supabase default: 1000/page, we loop until done)
   d. Build an XLSX in memory with the SheetJS library:
      - Worksheet name: 'ComboCurve_Export'
      - Header row: the 16 column names verbatim
      - Data rows: one per source row, columns in spec order
      - Date formatting: M/D/YYYY (Excel native date type)
      - Numeric formatting: no thousands separator, decimal precision as-stored (Postgres NUMERIC preserves what was ingested)
   e. Return { buffer, rowCount, wellCount, filename }

3. Express handler:
   a. Best-effort: upload buffer to Supabase Storage at production-files/exports/YYYY/MM/<uuid>.xlsx
   b. Best-effort: INSERT exports row
   c. (If either of these fails, the export still streams to the user — log and continue)
   d. Set response headers:
        Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
        Content-Disposition: attachment; filename="ComboCurve_<type>_<start>_to_<end>.xlsx"
        X-Export-Row-Count: <n>
        X-Export-Well-Count: <n>
   e. res.send(buffer)
```

## Filename convention

`buildFileName(type, start, end)` in `routes/exports.ts`. Examples:
- `ComboCurve_Monthly_2026-01_to_2026-03.xlsx`
- `ComboCurve_Daily_2026-04-01_to_2026-04-30.xlsx`

The user can rename freely after download — the filename is convenience, not contract.

## Why we go through the API and not direct PostgREST

We could let the frontend `SELECT FROM production_monthly` directly via PostgREST and build the XLSX client-side. Two reasons we don't:

1. **File size.** A multi-year export can produce 30+ MB of XLSX. Building that in the browser is slow and memory-heavy. Server-side is fine because Railway is a long-lived process.
2. **Auditability.** The `exports` history table needs a single source of truth for "what was exported by whom, when." Funneling all exports through `/api/export/*` makes that bookkeeping trivial.

## What the user sees vs. what RLS allows

The frontend allows the user to pick an arbitrary date range and operator filter. RLS independently scopes the query to the user's tenant. If a tenant user somehow constructs a query that crosses tenant boundaries (e.g. by tampering with the operator_id), the result is simply zero rows from that other tenant — no error, no leak, no exception. RLS is the backstop.

Super-admin behavior: super-admin's RLS predicate is `is_super_admin() OR …`, so a super-admin export pulls rows from ALL tenants. There is no UI to switch between tenant views for super-admin; this is intentional — see [architecture/04-decisions.md](../architecture/04-decisions.md#why-super-admin-uses-an-is_super_admin-boolean-on-user_tenants-not-a-separate-role-table).

## Storage bookkeeping

Successful exports persist to:
- `production-files/exports/YYYY/MM/<uuid>.xlsx` in Supabase Storage (private bucket)
- `exports` table in Postgres (links to the storage path)

The frontend's Export History page reads `exports` and offers a "Re-download" link that hits `GET /api/exports/:id/download`, which 302-redirects to a signed Storage URL.

## Failure modes

| Failure | What happens | Mitigation |
|---|---|---|
| Date range too wide → too many rows → memory pressure | Currently no explicit cap; the request stays open until the buffer is built | Future: add `LIMIT 100000`, return a `partial=true` flag and a continuation token |
| Supabase 5xx mid-fetch | Error response with the message; user retries | Acceptable; exports are idempotent |
| Storage upload fails (after XLSX is built) | Export streams to user, `exports` row may not be inserted | Logged; export history page shows fewer entries than reality |
| Empty result set | Returns a valid XLSX with only the header row, `X-Export-Row-Count: 0` | Frontend shows "0 rows" message |

## Future: incremental / cached exports

Not implemented. If a tenant runs the same Jan–Mar 2026 monthly export every Monday, we re-query and re-build every time. At current scale (single tenant, sub-100K rows per export), this is acceptable. The optimization would be a content-addressed cache keyed on `(tenant_id, type, start, end, operatorId, max(production_monthly.updated_at))`. Hold off until we have multiple tenants making this expensive.
