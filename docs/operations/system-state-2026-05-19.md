# Live System State — Snapshot 2026-05-19

A point-in-time capture of the production Supabase project's state. Compare against the schema docs to spot drift.

## Project

- **Supabase project ID:** `sdnpvclmfezesgqeudzu`
- **Project name:** `ProductionAggregator_App`
- **Region:** `us-east-1`
- **Postgres version:** 17.6.1
- **Created:** 2026-04-15

## Tables (13 in `public` schema)

```
combocurve_wells         – 627 rows  – Imported ComboCurve catalog (not tenant-scoped)
email_log                – 133 rows  – Tenant-scoped; UNIQUE on (gmail_message_id, tenant_id)
exports                  –  12 rows  – Export history
flagged_records          –   0 rows  – Rows that couldn't normalize (currently clean!)
format_mappings          –   0 rows  – Reserved for future data-driven parser engine
non_production_files     –   1 row   – Filtered drilling reports, etc.
operators                –  17 rows  – Oil & gas companies (not tenant-scoped)
production_daily         – 57,325 rows
production_monthly       – 128,884 rows
tenants                  –   1 row   – Frio Energy Partners
user_tenants             –  N rows   – User-to-tenant mapping with super-admin flag
well_name_aliases        – 327 rows  – Fuzzy-match alternate names
wells                    – 999 rows  – Canonical wells (tenant-scoped)
```

## RPCs (`public` schema, non-extension)

- `current_tenant_id() → uuid` — JWT claim extractor for RLS
- `is_super_admin() → boolean` — super-admin check for RLS
- `monthly_production_totals(p_start date, p_end date, p_operator uuid) → table` — chart aggregates (added 2026-05-19, migration 004)
- `exec_sql_json(q text) → jsonb` — admin-only utility
- `update_updated_at()` — trigger function

## RLS policies

| Table | Policy | Command | Predicate |
|---|---|---|---|
| email_log | tenant_isolation | ALL | `is_super_admin() OR tenant_id = current_tenant_id()` |
| exports | tenant_isolation | ALL | same |
| flagged_records | tenant_isolation | ALL | same |
| format_mappings | tenant_isolation | ALL | same |
| production_daily | tenant_isolation | ALL | same |
| production_monthly | tenant_isolation | ALL | same |
| well_name_aliases | tenant_isolation | ALL | same |
| wells | tenant_isolation | ALL | same |
| non_production_files | (two policies) | SELECT, ALL | tenant_iso for read; service_role for write |
| tenants | tenant_self_view + tenant_super_admin_write | SELECT, ALL | user sees own tenant; super-admin writes |
| user_tenants | user_tenants_self + user_tenants_super_admin_write | SELECT, ALL | user sees own row; super-admin writes |
| operators | operators_read_all + operators_super_admin_write | SELECT, ALL | authenticated read; super-admin write |
| combocurve_wells | (two policies) | SELECT, ALL | authenticated read; service write |

## Operators with well counts

| Operator | Wells |
|---|---:|
| Diversified Energy | 277 |
| OXY (Anadarko/Occidental) | 120 |
| EOG Resources | 31 |
| BTA Oil Producers | 20 |
| Various (Frio family / partner reports) | 20 |
| Mewbourne Oil Company | 11 |
| XTO Energy (ExxonMobil) | 9 |
| ConocoPhillips | 8 |
| Matador Resources Company | 6 |
| Strata Production | 4 |
| Chevron | 2 |
| Diamondback Energy | 2 |
| Notting Hill Energy LLC | 2 |
| Arlo | 1 |
| Frio Energy Holdings (Daily Report) | 0 |
| Frio Energy Holdings (Monthly Report) | 0 |
| Various (Tap Rock / West Pecos / EFG) | 0 |

## Email log status distribution (lifetime)

| Status | Count |
|---|---:|
| completed | 130 |
| ignored | 3 |
| (failed, partial, pending) | 0 |

Zero open failures. System is healthy.

## Monthly production totals (last 12 months, all tenants)

| Month | Oil (BBL) | Gas (MCF) | Water (BBL) | Rows |
|---|---:|---:|---:|---:|
| 2025-06 | 1,448,938 | 6,163,341 | 7,054,957 | 676 |
| 2025-07 | 1,452,636 | 6,185,088 | 6,397,288 | 675 |
| 2025-08 | 1,370,580 | 5,444,402 | 6,455,494 | 673 |
| 2025-09 | 1,114,058 | 5,441,778 | 5,817,054 | 665 |
| 2025-10 | 1,054,840 | 4,390,762 | 6,136,141 | 666 |
| 2025-11 | 1,015,477 | 4,307,367 | 6,065,773 | 673 |
| 2025-12 | 1,037,913 | 4,133,406 | 5,558,926 | 468 |
| 2026-01 | 1,543,445 | 7,100,054 | 5,761,727 | 125 |
| 2026-02 | 1,140,496 | 6,375,377 | 5,246,134 | 379 |
| 2026-03 | 850,591 | 6,013,191 | 6,516,176 | 493 |
| 2026-04 | 602,711 | 2,846,857 | 3,869,455 | 307 |

(Recent months show fewer rows because data is still arriving — operators report on different cadences.)

## How this snapshot was generated

Each section was produced by a SQL query against the live project. To refresh this file:

```sql
-- table counts
SELECT 'tenants' AS t, COUNT(*) FROM tenants UNION ALL
SELECT 'operators', COUNT(*) FROM operators UNION ALL ... ;

-- operators with well counts
SELECT name, (SELECT COUNT(*) FROM wells w WHERE w.operator_id = o.id) AS well_count
FROM operators o ORDER BY name;

-- email status
SELECT status, COUNT(*) FROM email_log GROUP BY status ORDER BY COUNT(*) DESC;

-- monthly totals
SELECT date_trunc('month', prod_date)::date AS month, COUNT(*) AS rows,
       SUM(oil_prod) AS oil, SUM(gas_prod) AS gas, SUM(water_prod) AS water
FROM production_monthly WHERE prod_date >= CURRENT_DATE - INTERVAL '12 months'
GROUP BY 1 ORDER BY 1;
```

Run them via the Supabase dashboard SQL editor or the Supabase MCP, then update this file. Worth doing once a quarter to track growth and catch drift.
