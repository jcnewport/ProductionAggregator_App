# 02 · Parsers — Registry, Dispatch, and the Adapter Model

The parser system is the heart of the application. Every operator format we recognize is implemented as a `FormatAdapter` in `api/src/parsers/`. The dispatcher tries each adapter's `detect()` method in order; the first one that matches wins.

## The `FormatAdapter` interface

Source: `api/src/parsers/types.ts`.

```typescript
export interface FormatAdapter {
  /** Unique short name, e.g. 'pds-anadarko-monthly' */
  name: string;

  /** Display name of the operator, e.g. 'Anadarko (OXY)' */
  operatorName: string;

  /** What grain this adapter produces */
  dataType: 'monthly' | 'daily' | 'weekly';

  /** Which file kinds this adapter handles */
  fileKinds: readonly ('pdf' | 'xlsx' | 'csv')[];

  /** Optional: regex patterns to short-circuit by sender email */
  senderEmailPatterns?: readonly RegExp[];

  /** Cheap text-signature check — does this file look like one of ours? */
  detect(ctx: ParserContext): boolean;

  /** Extract records. Called only after detect() returned true. */
  parse(ctx: ParserContext): Promise<ProductionRecord[]>;
}
```

## `ProductionRecord` — the normalized output

Every parser produces an array of these:

```typescript
export interface ProductionRecord {
  api14: string;
  api10: string;
  wellName: string;
  combocurveWellId: number | null;
  operatorWellId: number | null;
  prodDate: string;              // YYYY-MM-DD ISO; monthly = first-of-month
  oilProd: number | null;
  gasProd: number | null;
  waterProd: number | null;
  gasSales: number | null;
  oilSales: number | null;
  waterInj: number | null;
  daysOn: number | null;
  choke: string | null;
  tubingPres: number | null;
  casingPres: number | null;
  hoursDown: number | null;
  downtimeReason: string | null;
  operatorName: string;
  sourceFileName: string;
  extra?: Record<string, unknown>;  // Anything that doesn't fit the template
}
```

Note: the parser produces `ProductionRecord` shape (camelCase). The DB columns are snake_case. The transformation happens in `services/productionStorage.ts` during the upsert.

## The registry

Source: `api/src/parsers/registry.ts`. Single source of truth for which formats exist.

```typescript
export const REGISTERED_FORMATS: readonly RegisteredFormat[] = [
  {
    status: 'implemented',
    adapter: pdsAnadarkoMonthlyAdapter,
  },
  // ... 23 more implemented adapters as of 2026-05-19 ...
  {
    status: 'stub',
    adapter: stubAdapter({
      name: 'pds-someother-monthly',
      operatorName: 'Someother',
      dataType: 'monthly',
      fileKinds: ['pdf'],
      detect: (ctx) => hasAll(ctx.pdfText ?? '', 'Statement Generated', 'Someother'),
    }),
  },
];
```

**`status: 'stub'`** means the adapter can detect the format but its `parse()` throws "not yet implemented." The dispatcher still matches it — the email is flagged for manual review rather than misrouted to a different parser. When you implement the parser, flip `status` to `'implemented'` and swap in the real adapter.

## The dispatcher

The poller hands each attachment to the dispatcher (`services/emailPoller.ts` → adapter iteration). The dispatcher:

1. Builds a `ParserContext` lazily — PDF text and XLSX workbook are extracted only when first asked.
2. Iterates `REGISTERED_FORMATS` in declaration order.
3. For each one, runs `adapter.detect(ctx)`. The first `true` wins.
4. If a winner is found and it's a real (non-stub) adapter, calls `parse(ctx)`.
5. If no adapter matches, the email is marked `failed` with reason `unknown_format`.

**Detection order matters.** More specific adapters (operator-specific PDS PDF) must come BEFORE generic fallbacks (generic CSV). The current order in `registry.ts` is correct; if you add a new adapter, place it before generics.

## Precedence and the "Aftermath rule"

Aftermath sends a CSV daily report for ConocoPhillips/Concho wells. PDS also sends a Daily PDF for the same wells. We prefer Aftermath because its data is cleaner and arrives earlier.

**How precedence works:**
- Both adapters' `senderEmailPatterns` and `detect()` are mutually exclusive based on which email arrived (sender, attachment type).
- If both somehow ingest data for the same well/date, the unique constraint `(tenant_id, well_id, prod_date)` ensures the later UPSERT wins.
- Practical effect: Aftermath usually arrives first; PDS ConocoPhillips Daily lands later and is no-op-overwritten with the same numbers.

If the two ever disagree, the LATER arrival wins. This is by design — newer = more correct (operator may have corrected the earlier upload).

## Email poller (`services/emailPoller.ts`)

The cron-driven entry point for ingestion.

**Schedule:** every 5 minutes (`*/5 * * * *`). Configured in `api/src/index.ts` via `startEmailPollerCron()`.

**Single pass:**
1. Gmail API: list messages newer than the watermark.
2. For each message:
   a. Resolve tenant via `To:` header → `tenants.email_alias`. If no match, skip (and log).
   b. INSERT into `email_log` with `status='processing'`.
   c. Download attachments via Gmail API.
   d. For each attachment:
      - Run `nonProductionFilters` first. If any filter matches, archive to `non_production_files` and skip.
      - Build `ParserContext`. Run the dispatcher.
      - On success: call `productionStorage.upsertBatch(records, ctx)`. This resolves wells and tenant_id, then UPSERTs.
      - On parser error: insert flagged_record(s); accumulate error message.
   e. Update `email_log.status` to `completed` / `partial` / `failed` based on outcomes.
3. Move the watermark forward.

**Idempotency:** `gmail_message_id` is the natural key on `email_log`. Re-processing the same message is a no-op.

## Retry worker (`services/retryWorker.ts`)

**Schedule:** every 10 minutes (`*/10 * * * *`).

**Behavior:**
1. SELECT emails where `next_retry_at <= NOW() AND retry_count < max_retries AND is_retryable = true`.
2. For each one, call the same poller code path that handles a fresh email.
3. Update `last_retry_at`, `last_retry_outcome`. If still failed: schedule next retry with exponential backoff (`5min → 15min → 1hr → 4hr → 24hr`).
4. If `retry_count >= max_retries`, mark as permanent failure and call `notifications.sendPermanentFailureAlert()`.

**What's retryable:**
- Transient errors (Gmail API timeouts, Supabase 5xx) → `is_retryable = true`
- Parser errors that look like a bad format ("Unknown format", "No detect() match") → `is_retryable = false` (a human needs to investigate)

Classification logic: `services/errorClassification.ts`.

## Storage: `productionStorage.ts`

The bridge between parsed records and the database.

**`upsertBatch(records, ctx):`**

1. **Well resolution.** For each record:
   - First try: `wells WHERE api10 = ?` (scoped to tenant)
   - Fallback: `well_name_aliases WHERE alias = ?` → wells
   - Fallback: fuzzy match via `pg_trgm` (`wellNameResolver.ts`)
   - If nothing matches: create a `flagged_records` row, skip this row's upsert.
2. **Tenant tagging.** `tenant_id` is always set from `ctx.tenant_id` (resolved by the poller from the email's To: header).
3. **Granularity routing.** `dataType === 'monthly'` → `production_monthly`; `dataType === 'daily'` → `production_daily`.
4. **Upsert.** `INSERT ... ON CONFLICT (well_id, prod_date) DO UPDATE SET ...`. All non-key columns are updated to the latest values.

## File kinds and content extraction

| File kind | Extractor | When PDF text is built |
|---|---|---|
| `pdf` | `pdf-parse` library | Lazy in ParserContext — only built when an adapter's `detect()` calls `ctx.pdfText` |
| `xlsx` / `xls` | `xlsx` (SheetJS) | Lazy — `ctx.workbook` |
| `csv` | Native string handling | Always available as `ctx.fileText` |

Lazy extraction matters because some emails carry many attachments — we don't want to pay PDF-parsing cost for every attachment when only one of them might be a production report.

## When parsers go wrong (the operator changed their format)

This will happen. When it does:
1. The dispatcher may misroute (a generic fallback matches because the specific detector no longer recognizes the new shape) → bad data in DB.
2. Or the specific adapter still matches but `parse()` throws → email marked failed.

See [runbooks/parser-failing.md](../runbooks/parser-failing.md) for the response procedure.
