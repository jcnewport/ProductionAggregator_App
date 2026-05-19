# Runbook · Unknown Operator Format

**Symptom:** An email arrived from an operator we don't recognize. `email_log.status = 'failed'`, error_messages includes "No parser matched" or similar. `flagged_records` may have a row with `reason = 'unknown_format'`.

This is different from [parser-failing.md](parser-failing.md), which is about a KNOWN operator whose format changed. This is about a NEW operator entirely.

## Step 1 · Confirm it's truly unknown

A "no parser matched" can also mean the existing parser's `detect()` is too strict for this variant. Check:

1. Look at the sender: `SELECT sender FROM email_log WHERE id = '<email_log_id>';`
2. Have we ever processed mail from this sender successfully? `SELECT COUNT(*), status FROM email_log WHERE sender = '<sender>' GROUP BY status;`
3. If we have processed it before: the format changed → use [parser-failing.md](parser-failing.md) instead.
4. If we have NEVER processed mail from this sender: it's truly new → proceed.

## Step 2 · Decide if this is real production data

Some emails to `S.IS_AD_Prod@` are not production reports:
- Marketing
- Statements / invoices
- Drilling reports
- Workover notices
- Lease operating statements (LOS)

If the email is NOT production data, the fix is to add it to `nonProductionFilters.ts` so the dispatcher routes it to `non_production_files` automatically.

If it IS production data: continue.

## Step 3 · Build a temporary stub adapter

Before writing the full parser, add a STUB to the registry. This gives the system a way to:
- Detect future emails of this same format and route them to flagged-review
- Avoid misrouting to a wrong parser
- Track the volume of incoming new-format emails (count of flagged_records with this reason)

In `api/src/parsers/registry.ts`:

```typescript
{
  status: 'stub',
  adapter: stubAdapter({
    name: 'operator-x-monthly',
    operatorName: 'Operator X',
    dataType: 'monthly',
    fileKinds: ['pdf'],
    detect: (ctx) => hasAll(ctx.pdfText ?? '', 'Operator X', 'Monthly Statement'),
  }),
},
```

**Pick the detect() strings carefully.** They need to:
- Match all Operator X reports
- NOT match any other operator's reports

Push and deploy. Now future Operator X emails will fail with a clear "not yet implemented" message and route to flagged_records.

## Step 4 · Implement the real parser

Follow the recipe in [backend/05-adding-a-new-parser.md](../backend/05-adding-a-new-parser.md).

While developing locally:
1. Get 3 sample emails worth of files
2. Save them under `api/scripts/_samples/operator-x/` (gitignored)
3. Write the parser
4. Test against the samples
5. Swap the stub for the real adapter in the registry
6. Push

## Step 5 · Reprocess the queued emails

After your real parser is deployed:

```sql
SELECT id FROM email_log
WHERE status = 'failed'
  AND error_messages::text ILIKE '%operator-x-monthly%'
ORDER BY received_at;
```

For each, POST to `/api/admin/reprocess-email`.

## Step 6 · Add operator to the catalog doc

Update [domain/02-operator-catalog.md](../domain/02-operator-catalog.md) with the new format's documentation. Include:
- File type and grain (PDF / XLSX / CSV; daily / monthly)
- Column list as it appears in the source
- Any quirks (8-digit API, cumulative columns, hierarchical rows, etc.)
- A reference sample filename

## Skipping the stub step

You can skip the stub adapter and implement the real parser in one push if:
- The new operator has only sent ONE email so far, so there's no traffic to misroute in the gap
- You're confident the real parser will be ready within a few hours

Otherwise, always do the stub first. The cost is a single extra deploy, and the benefit is that you don't have to worry about other parsers' detectors accidentally matching the new format.

## How to know which existing parser's `detect()` is at risk

The dispatcher iterates in declaration order. After your new operator's stub or real adapter is added, run:

```typescript
// in a script:
import { REGISTERED_FORMATS } from '../src/parsers/registry.js';
for (const { adapter } of REGISTERED_FORMATS) {
  console.log(adapter.name, '→ detect():', adapter.detect(ctxForNewOperatorFile));
}
```

If two adapters both return `true` for the same file, the EARLIER one wins. Reorder registry.ts so the more-specific adapter comes first.

## Avoid: false-positive detection

A common pitfall: the new operator's PDF has the word "Anadarko" somewhere in a sub-heading. The Anadarko parser's `detect()` matches it, parse() blows up because the column structure is different. Now you've got "data" in production_monthly tagged as Anadarko when it's actually Operator X.

To prevent this, make `detect()` strings as SPECIFIC as possible: not just operator name, but a phrase that uniquely identifies THAT operator's THAT report template. Combine with sender email match for extra confidence.
