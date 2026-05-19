# 01 · Database Schema

The live Postgres schema, table by table. Verified against the production Supabase project (`sdnpvclmfezesgqeudzu`) on 2026-05-19.

13 tables in the `public` schema. Every data table has a `tenant_id` column and RLS enforcement — see [02-rls-and-tenancy.md](02-rls-and-tenancy.md).

## tenants

The list of paying customers.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| id | uuid | no | gen_random_uuid() | Primary key |
| slug | text | no | | URL-friendly identifier (e.g. `frio`) — used in alias generation |
| name | text | no | | Display name |
| email_alias | text | no | | Gmail alias this tenant receives operator emails at (e.g. `frio.prod@stewardship.is`) |
| is_active | boolean | no | true | Soft-disable without deleting |
| notes | text | yes | | Free-form ops notes |
| created_at | timestamptz | no | now() | |

## user_tenants

Maps Supabase Auth users to tenants. Many-to-many in theory, almost always one-to-one in practice.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| user_id | uuid | no | | FK → auth.users.id |
| tenant_id | uuid | no | | FK → tenants.id |
| is_super_admin | boolean | no | false | If true, sees ALL tenants regardless of tenant_id |
| created_at | timestamptz | no | now() | |

Composite primary key: `(user_id, tenant_id)`.

## operators

The oil & gas companies that send us production reports. Not tenant-scoped — operators are shared metadata.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| id | uuid | no | uuid_generate_v4() | |
| name | text | no | | Display name (e.g. "Anadarko (OXY)") |
| sender_email_patterns | text[] | yes | `{}` | Regex-ish patterns to identify which sender emails belong to this operator |
| contact_info | jsonb | yes | `{}` | Free-form |
| notes | text | yes | | |
| created_at | timestamptz | yes | now() | |
| updated_at | timestamptz | yes | now() | |

## wells

The canonical wells. Tenant-scoped.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| id | uuid | no | uuid_generate_v4() | |
| well_name | text | no | | Canonical name |
| api14 | text | yes | | 14-digit API, when known |
| api10 | text | yes | | 10-digit API, **always 10 chars text** when present |
| combocurve_well_id | bigint | yes | | Caleb's ComboCurve internal ID (from imported catalog) |
| operator_id | uuid | yes | | FK → operators.id |
| location_metadata | jsonb | yes | `{}` | Free-form (county, state, basin, lease, …) |
| notes | text | yes | | |
| created_at | timestamptz | yes | now() | |
| updated_at | timestamptz | yes | now() | |
| **tenant_id** | uuid | no | | FK → tenants.id, RLS |

Indexes:
- `idx_wells_tenant` on `tenant_id`
- `idx_wells_api10` on `api10`
- Unique constraint: `(tenant_id, api10)` when api10 is not null (added in phase-3 multitenancy migration)

## well_name_aliases

For fuzzy matching: alternate names → canonical well.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| id | uuid | no | uuid_generate_v4() | |
| alias | text | no | | The alternate name (e.g. `"HIDEOUT 24-13 ST COM 1H"`) |
| well_id | uuid | no | | FK → wells.id |
| source | text | yes | | Where this alias was discovered |
| created_at | timestamptz | yes | now() | |
| **tenant_id** | uuid | no | | RLS |

## combocurve_wells

Caleb's import of his ComboCurve well catalog. Not tenant-scoped — global metadata.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| id | uuid | no | gen_random_uuid() | |
| well_name | text | no | | |
| api14 | text | yes | | |
| api10 | text | yes | | |
| api12 | text | yes | | |
| chosen_id | bigint | yes | | ComboCurve's internal numeric ID |
| current_operator | text | yes | | |
| raw_fields | jsonb | yes | | Original CSV row preserved verbatim |
| source_file | text | yes | | Provenance |
| imported_at | timestamptz | no | now() | |
| updated_at | timestamptz | no | now() | |

## format_mappings

Reserved for the future data-driven parser engine. **Currently unused** (0 rows). Parsers are code-based today.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| id | uuid | no | | |
| operator_id | uuid | yes | | |
| name | text | no | | |
| file_type | text | no | | `pdf` / `xlsx` / `csv` |
| data_type | text | no | | `monthly` / `daily` / `weekly` |
| mapping_config | jsonb | no | `{}` | Column-to-template mapping rules |
| identification_rules | jsonb | yes | `{}` | How to detect this format |
| version | integer | yes | 1 | |
| is_active | boolean | yes | true | |
| notes | text | yes | | |
| created_at | timestamptz | yes | now() | |
| updated_at | timestamptz | yes | now() | |
| **tenant_id** | uuid | no | | RLS |

## email_log

Every email the poller has seen. Tenant-scoped.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| id | uuid | no | uuid_generate_v4() | |
| gmail_message_id | text | yes | | UNIQUE per tenant; the dedup key |
| sender | text | yes | | From: header |
| subject | text | yes | | |
| received_at | timestamptz | yes | | |
| attachments_found | integer | yes | 0 | |
| attachments_processed | integer | yes | 0 | |
| status | text | yes | `'pending'` | `pending` / `processing` / `completed` / `partial` / `failed` / `ignored` |
| error_messages | text[] | yes | | Concatenated parser errors |
| operator_id | uuid | yes | | Resolved from sender |
| processing_started_at | timestamptz | yes | | |
| processing_completed_at | timestamptz | yes | | |
| retry_count | integer | no | 0 | |
| max_retries | integer | no | 5 | |
| next_retry_at | timestamptz | yes | | When the retry-worker will pick this up |
| last_retry_at | timestamptz | yes | | |
| last_retry_outcome | text | yes | | |
| is_retryable | boolean | no | false | Set by error classifier |
| alert_sent_at | timestamptz | yes | | When permanent-failure alert was emailed |
| created_at | timestamptz | yes | now() | |
| **tenant_id** | uuid | no | | RLS |

## production_monthly

| Column | Type | Notes |
|---|---|---|
| id | uuid | |
| well_id | uuid (nullable) | FK → wells.id (nullable because some rows fail well resolution) |
| well_name | text | Captured at ingest time |
| api14, api10 | text | |
| combocurve_well_id | bigint | |
| **prod_date** | date NOT NULL | First-of-month convention |
| gas_prod, gas_sales, oil_prod, oil_sales, water_prod | numeric | The five core volumes |
| choke | text | "64/64" format preserved |
| tubing_pres, casing_pres | numeric | PSI |
| hours_down, days_on | numeric | |
| water_inj | numeric | |
| downtime_reason | text | |
| operator_id | uuid | |
| source_email_id | uuid | FK → email_log.id |
| source_file_name | text | |
| extra_fields | jsonb | Operator-specific metadata that doesn't fit the template |
| created_at | timestamptz | |
| **tenant_id** | uuid NOT NULL | RLS |

**Unique constraint:** `(tenant_id, well_id, prod_date)` — drives upsert idempotency.

Indexes:
- `idx_monthly_prod_date`
- `idx_monthly_well`
- `idx_monthly_operator`
- `idx_monthly_tenant`

## production_daily

Identical structure to `production_monthly`, but `prod_date` is the specific day. Unique constraint: `(tenant_id, well_id, prod_date)`.

## flagged_records

Rows that couldn't be normalized. The dashboard surfaces these for human review.

| Column | Type | Notes |
|---|---|---|
| id | uuid | |
| email_log_id | uuid | FK |
| source_file_name | text NOT NULL | |
| row_number | integer | Which row in the source file (when applicable) |
| reason | text NOT NULL | `unresolvable_well`, `bad_date`, `no_data`, `unknown_format`, `parser_error`, … |
| attempted_well_name | text | What the parser tried |
| attempted_api10, attempted_api14 | text | |
| raw_fields | jsonb | The raw row data, for inspection |
| created_at | timestamptz | |
| **tenant_id** | uuid NOT NULL | RLS |

## non_production_files

Audit log of attachments that were proactively filtered out (drilling reports, etc.).

| Column | Type | Notes |
|---|---|---|
| id | uuid | |
| email_log_id | uuid | FK |
| filename, mime_type, file_bytes | | File metadata |
| category | text NOT NULL | The class of non-production file (e.g. `drilling_report`) |
| filter_name | text NOT NULL | Which filter in `nonProductionFilters.ts` matched |
| reason | text | Free-form notes |
| sender, subject, email_received_at | | Email metadata captured |
| storage_bucket | text | Default `'non-production-files'` |
| storage_path | text NOT NULL | Path within the bucket |
| created_at | timestamptz | |
| **tenant_id** | uuid NOT NULL | RLS |

## exports

History of every generated export (best-effort log; export still works if this insert fails).

| Column | Type | Notes |
|---|---|---|
| id | uuid | |
| export_type | text NOT NULL | `monthly` or `daily` |
| date_range_start, date_range_end | date | |
| operator_filter | text[] | Operator IDs included (empty = all) |
| well_filter | text[] | Future use |
| row_count | integer | |
| file_path | text | Path in `production-files` storage bucket |
| file_size_bytes | bigint | |
| generated_by | uuid | FK → auth.users.id |
| generated_at | timestamptz | |
| **tenant_id** | uuid NOT NULL | RLS |
