# Runbook · Flagged Records Buildup

**Symptom:** The dashboard's flagged_records count is climbing instead of staying near zero. Or a daily check finds 10+ new flagged rows.

## Step 1 · Group by reason

```sql
SELECT reason, COUNT(*) AS n
FROM flagged_records
WHERE created_at > NOW() - INTERVAL '7 days'
GROUP BY reason
ORDER BY n DESC;
```

The `reason` column tells you what kind of problem. Common reasons:

| Reason | What it means | Common cause |
|---|---|---|
| `unresolvable_well` | Row had a well name and/or API but no match found in `wells` | Missing well in catalog; misspelled well name; new well added by operator |
| `bad_date` | Date parse failed | Operator changed their date format |
| `no_data` | Row extracted but all volumes are NULL | Empty row in source file (often legitimate); rare bug in parser |
| `unknown_format` | No parser matched | New operator format — see [unknown-operator-format.md](unknown-operator-format.md) |
| `parser_error` | Parser threw mid-row | Bug in the parser, or operator-format change — see [parser-failing.md](parser-failing.md) |

## Step 2 · Pull the worst offender's details

```sql
-- For the most common reason in your group-by above:
SELECT id, source_file_name, attempted_well_name, attempted_api10, attempted_api14, raw_fields
FROM flagged_records
WHERE reason = '<worst-reason>'
  AND created_at > NOW() - INTERVAL '7 days'
ORDER BY created_at DESC
LIMIT 20;
```

## Step 3 · By reason — what to do

### `unresolvable_well` — missing well in catalog

This is the most common buildup cause. The fix is to add the well to `wells` (or to `well_name_aliases` if it's an alias of an existing well).

**If the row has an API:**
1. The well exists in operator-land but not in our `wells` table. Insert it:
   ```sql
   INSERT INTO wells (well_name, api10, api14, operator_id, tenant_id)
   VALUES ('<well_name>', '<api10>', '<api14>', '<operator_uuid>', '<tenant_uuid>');
   ```
2. After inserting, reprocess the email: `POST /api/admin/reprocess-email`
3. Verify: the same flagged_records reason should not recur

**If the row has NO API (only well name):**
1. Search for an existing well by name: `SELECT id, well_name FROM wells WHERE well_name ILIKE '%<search>%' AND tenant_id = '<tenant>';`
2. If a match exists, add an alias:
   ```sql
   INSERT INTO well_name_aliases (alias, well_id, source, tenant_id)
   VALUES ('<the operator''s spelling>', '<well_id>', 'operator-x report', '<tenant_uuid>');
   ```
3. If no match exists: this is a genuinely new well. Caleb's ComboCurve well catalog should be the source of truth — request the latest catalog from him, run `api/scripts/import-combocurve-catalog.ts` to backfill.

### `bad_date` — date parse failed

Look at `raw_fields` for the row. Inspect the date value.

- Is the format something new the parser doesn't handle? Update the parser's date-parsing code.
- Is the date genuinely invalid (e.g. `0000-00-00`, blank, garbage text)? That's a source-file problem — flag for the operator.

### `no_data` — empty row

Inspect `raw_fields`. If all volume columns are blank or zero, this might be a legitimate empty row (well shut in for the entire period). Usually safe to leave; the absence of a `production_monthly` row for that well/date implicitly means "no production reported."

If you DO want a row representing "zero production," manually insert with explicit zeros.

### `unknown_format` and `parser_error`

See the dedicated runbooks: [unknown-operator-format.md](unknown-operator-format.md), [parser-failing.md](parser-failing.md).

## Step 4 · Mark flagged records resolved

There is currently no "resolved" flag on `flagged_records` — the dashboard simply shows them in chronological order. After you fix the underlying issue and reprocess, DELETE the flagged_record rows:

```sql
DELETE FROM flagged_records
WHERE id IN ('<id1>', '<id2>', ...);
```

**Backlog item:** add a `resolved_at` column to `flagged_records` for proper auditability. Until then, deletion is the workflow.

## Step 5 · Prevent recurrence

If the same well/operator keeps showing up in flagged_records, fix the upstream cause:
- Recurring unresolvable_well for an operator → catalog is outdated; request a refresh
- Recurring bad_date for an operator → date format is variable; harden the parser
- Recurring no_data → likely a source-file convention we should ignore programmatically (filter empty rows in the parser before producing ProductionRecord)

## When to ask for help (operator-side)

If a buildup is caused by the operator sending genuinely-broken data (missing API, missing date, scrambled columns), Caleb may need to email the operator directly. Tee up the case:
- Specific email_log row(s) and source_file_name(s)
- A clear description of what's wrong with the file
- A reminder of the expected format (point to the canonical template)

Don't try to fix operator-side problems by mangling their data on ingest. Better to flag and have the operator resend.
