# Runbook · Parser Failing

**Symptom:** Emails from a known operator are landing in `email_log.status = 'failed'` or `'partial'`. The operator's format has likely changed.

## Step 1 · Identify the failing email

Dashboard → recent activity → find the red/yellow rows. Note the `email_log.id`.

Or via SQL:
```sql
SELECT id, sender, subject, received_at, status, error_messages
FROM email_log
WHERE status IN ('failed', 'partial')
  AND received_at > NOW() - INTERVAL '7 days'
ORDER BY received_at DESC;
```

Look at `error_messages` for the parser's reported reason.

## Step 2 · Fetch the original attachment

The original is in Supabase Storage. Two ways:

**Via Supabase dashboard:**
- Storage → `production-files` bucket → navigate to the year/month folder → find the file
- Click → Download

**Via SQL (gets the path):**
```sql
SELECT non_production_files.* FROM non_production_files WHERE email_log_id = '<email_log_id>';
-- OR for normal production attachments:
-- (storage paths aren't recorded in email_log directly; pull the file_name from production_monthly/daily rows tagged with source_email_id, or list the bucket folder for the email's date)
```

If the storage upload itself failed, the original is gone — you'll need the operator to resend.

## Step 3 · Inspect the file structure

Run the appropriate peek script:

```bash
cd api
npx tsx scripts/peek-pdf.ts <path-to-pdf>           # for any PDF
npx tsx scripts/peek-mewbourne-monthly.ts <path>    # operator-specific
npx tsx scripts/peek-xto-monthly.ts <path>
npx tsx scripts/peek-partner-xlsx.ts <path>         # for XLSX
# etc.
```

Compare the structure to a known-good sample in the repo root (e.g. `PDSWDX-MP-Anadarko-MONTHLY.pdf`). Look for:
- New columns added or columns removed
- Column ORDER changed
- Date format changed
- API number length changed
- Header text changed (this would break `detect()`)

## Step 4 · Fix the parser

The change you need is operator-specific. Common cases:

### Case: `detect()` no longer matches

The operator changed their header text. Find the strings in the parser's `detect()` method and update them.

```typescript
detect(ctx) {
  const text = ctx.pdfText ?? '';
  return text.includes('Statement Generated') &&
         text.includes('Anadarko');   // ← maybe this is now 'OXY' or 'Occidental'
}
```

### Case: column order swapped

The row-extracting regex needs to be updated.

```typescript
const m = /^(\d+)\s+(.+?)\s+(\d{14})\s+(\d{4}-\d{2}-\d{2})\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)$/.exec(line);
// Reorder the captures and the destructuring to match the new columns
```

### Case: new column added in the middle

If an operator added a column the parser doesn't know about, the regex fails because the column count is off. Update the regex to accommodate the new column, then either:
- Map it to a template column (if it fits one of the 16)
- Drop it (if it's metadata we don't need)
- Stash it in `extra` (if we might want it later)

### Case: file is genuinely different (new sub-format)

The operator may have switched their template. In this case:
- Don't shoehorn the new shape into the old parser
- Add a SECOND parser for the new format with a more specific `detect()`
- Keep the old parser around for any back-dated emails

## Step 5 · Test before pushing

```bash
cd api
npx tsx scripts/test-<operator-slug>-parser.ts ./scripts/_samples/<operator>/<new-sample>.pdf
```

Spot-check the first few records against the source by hand. **Don't push** if anything looks off.

## Step 6 · Push and reprocess

```bash
git add api/src/parsers/<file>.ts
git commit -m "Fix <operator> parser: <what changed in their format>"
git push origin main
```

Wait ~3 min for Railway to redeploy.

Then reprocess the failed email:

```bash
curl -X POST https://productionaggregator.stewardship.is/api/admin/reprocess-email \
  -H "Authorization: Bearer <super-admin JWT>" \
  -H "Content-Type: application/json" \
  -d '{"emailLogId": "<the email_log id>"}'
```

Or use the Admin UI → "Reprocess email" button (if available).

## Step 7 · Verify

```sql
SELECT status, error_messages FROM email_log WHERE id = '<email_log_id>';
-- Should now be 'completed'

SELECT COUNT(*) FROM production_monthly WHERE source_email_id = '<email_log_id>';
-- Should be > 0 if the parser succeeded
```

## Wiping and reprocessing one email

If reprocess didn't clear stale rows (e.g. the previous run partially wrote bad data), wipe and re-do:

```sql
DELETE FROM production_monthly WHERE source_email_id = '<email_log_id>';
DELETE FROM production_daily WHERE source_email_id = '<email_log_id>';
DELETE FROM flagged_records WHERE email_log_id = '<email_log_id>';

UPDATE email_log SET status = 'pending', error_messages = NULL, retry_count = 0
WHERE id = '<email_log_id>';
```

Then re-trigger via the admin endpoint.

## When this happens for the same operator twice

Document the second occurrence in the parser's source-file header comment. Patterns matter:
- "This operator changes column order quarterly" → write a more flexible parser that maps by header name, not position
- "This operator occasionally sends a different template" → add a stub adapter to detect-and-flag the variant
