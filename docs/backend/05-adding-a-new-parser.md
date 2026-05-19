# 05 · Adding a New Operator Parser

A step-by-step recipe for onboarding a new operator format. Reference implementations are abundant in `api/src/parsers/`.

## Decide which path

| Operator file looks like… | Pattern to copy |
|---|---|
| Another PDSWDX PDF | `pdsAnadarkoMonthly.ts` (monthly) or `pdsConocoPhillipsDaily.ts` (daily) |
| A direct-export CSV from the operator | `aftermathDailiesCsv.ts` |
| A direct-export XLSX (single sheet) | `arloPartnerReportXlsx.ts` |
| A multi-sheet XLSX with one sheet per well | `btaDailyPerWellXlsx.ts` |
| A PDF with hierarchical / indented rows | `hierarchicalAllocatedPdf.ts` |
| An XLSX with hierarchical rows | `hierarchicalAllocatedXlsx.ts` |

The closest existing parser is usually the right starting point. Copy the file, rename, gut the operator-specific bits.

## Step 1 · Capture sample files

Get at least 3 actual operator emails worth of files. Save them to `api/scripts/_samples/<operator-slug>/`. **Never commit real client data** — gitignore that path. Use these only on your dev machine.

If the operator file structure varies month-to-month, you need samples that cover all variations BEFORE you start coding the parser.

## Step 2 · Write the "peek" script first

Create `api/scripts/peek-<operator-slug>.ts` that just opens the file and dumps the rows/text to stdout. This is the fastest way to understand the file structure.

For PDF:
```typescript
import pdfParse from 'pdf-parse';
import fs from 'fs';
const buf = fs.readFileSync('./api/scripts/_samples/operator/example.pdf');
pdfParse(buf).then((data) => console.log(data.text));
```

For XLSX:
```typescript
import * as XLSX from 'xlsx';
const wb = XLSX.readFile('./api/scripts/_samples/operator/example.xlsx');
for (const name of wb.SheetNames) {
  const sheet = wb.Sheets[name];
  console.log(`=== ${name} ===`);
  console.log(XLSX.utils.sheet_to_json(sheet, { header: 1 }).slice(0, 10));
}
```

Run with `cd api && npx tsx scripts/peek-<operator-slug>.ts`. Iterate until you understand every column.

## Step 3 · Write the adapter

File: `api/src/parsers/<operatorSlug>Adapter.ts` (camelCase, descriptive).

Skeleton (PDF example):

```typescript
import { ParserContext, ProductionRecord, FormatAdapter } from './types.js';

export const operatorXSomethingMonthlyAdapter: FormatAdapter = {
  name: 'operator-x-something-monthly',
  operatorName: 'Operator X',
  dataType: 'monthly',
  fileKinds: ['pdf'],
  senderEmailPatterns: [/operatorx-reports@/i],

  detect(ctx) {
    const text = ctx.pdfText ?? '';
    return text.includes('Operator X Production Statement') &&
           text.includes('Statement Generated');
  },

  async parse(ctx): Promise<ProductionRecord[]> {
    const text = ctx.pdfText ?? '';
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

    const records: ProductionRecord[] = [];
    for (const line of lines) {
      // operator-specific row parsing — typically a regex that extracts
      // well num, well name, API, prod date, oil, gas, water, etc.
      const m = /^(\d+)\s+(.+?)\s+(\d{14})\s+(\d{4}-\d{2}-\d{2})\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)$/.exec(line);
      if (!m) continue;
      const [, wellNum, wellName, api14, prodDate, oilStr, gasStr, waterStr] = m;
      records.push({
        api14,
        api10: api14.slice(0, 10),
        wellName: wellName.trim(),
        combocurveWellId: null,
        operatorWellId: Number(wellNum) || null,
        prodDate, // already YYYY-MM-DD
        oilProd: parseFloat(oilStr),
        oilSales: null,
        gasProd: parseFloat(gasStr),
        gasSales: null,
        waterProd: parseFloat(waterStr),
        waterInj: null,
        daysOn: null,
        choke: null,
        tubingPres: null,
        casingPres: null,
        hoursDown: null,
        downtimeReason: null,
        operatorName: 'Operator X',
        sourceFileName: ctx.filename,
      });
    }
    return records;
  },
};
```

Match the **column conventions** from [domain/03-oil-and-gas-rules.md](../domain/03-oil-and-gas-rules.md):
- API: always TEXT, leading zeros preserved
- Prod date: YYYY-MM-DD, monthly = first-of-month
- "Production"/"Prod" → `*Prod` columns (gross); "Sales"/"Sold" → `*Sales` columns (net)
- Negative values preserved
- Cumulative columns IGNORED

## Step 4 · Register the adapter

In `api/src/parsers/registry.ts`:

```typescript
import { operatorXSomethingMonthlyAdapter } from './operatorXSomethingMonthly.js';

export const REGISTERED_FORMATS: readonly RegisteredFormat[] = [
  // ... existing entries ...
  {
    status: 'implemented',
    adapter: operatorXSomethingMonthlyAdapter,
  },
];
```

**Placement matters.** Add new entries BEFORE generic fallbacks (`genericProductionCsvAdapter`). The dispatcher iterates in declaration order.

## Step 5 · Write a parser test

Create `api/scripts/test-<operator-slug>-parser.ts`:

```typescript
import { operatorXSomethingMonthlyAdapter } from '../src/parsers/operatorXSomethingMonthly.js';
import { buildContextFromFile } from './_helpers/buildContext.js';

const samples = [
  './scripts/_samples/operator-x/example-1.pdf',
  './scripts/_samples/operator-x/example-2.pdf',
];

for (const path of samples) {
  const ctx = await buildContextFromFile(path);
  console.log(`detect(${path}):`, operatorXSomethingMonthlyAdapter.detect(ctx));
  if (operatorXSomethingMonthlyAdapter.detect(ctx)) {
    const recs = await operatorXSomethingMonthlyAdapter.parse(ctx);
    console.log(`  → ${recs.length} records, first row:`, recs[0]);
  }
}
```

Run with `cd api && npx tsx scripts/test-<operator-slug>-parser.ts`.

**Spot-check** the first few records by hand against the source PDF/XLSX. Check API formatting, date formatting, units, gross vs net, edge cases (zero-oil SWD wells, negative values, multi-page boundary).

## Step 6 · Add the operator + wells to the DB

Through the Admin UI (preferred) or directly in Supabase:

```sql
-- 1. Operator row
INSERT INTO operators (name, sender_email_patterns)
VALUES ('Operator X', ARRAY['operatorx-reports@']);

-- 2. Wells — usually backfilled the first time the parser runs and processes a real email
--    (the well resolver creates rows on first sight if api10 is provided and well_name_aliases table is empty)
```

For operators that don't include API in their reports (like BTA WIO Mailout), pre-populate `well_name_aliases` mapping the operator's well names to existing canonical wells.

## Step 7 · Push and let Railway redeploy

Standard direct-push flow:

```bash
git add api/src/parsers/operatorXSomethingMonthly.ts api/src/parsers/registry.ts api/scripts/test-operator-x-parser.ts
git commit -m "Add Operator X Monthly PDF parser"
git push origin main
```

Railway redeploys in ~3 min. Watch `email_log.status` for the first real email after deploy.

## Step 8 · Verify in production

1. Send a real Operator X email to the tenant's alias (or wait for one to arrive naturally).
2. Watch the dashboard's recent email log for `status='completed'` with `attachments_processed > 0`.
3. Run a spot-check query:
   ```sql
   SELECT well_name, prod_date, oil_prod, gas_prod, water_prod
   FROM production_monthly
   WHERE source_file_name LIKE '%OperatorX%'
   ORDER BY prod_date DESC LIMIT 20;
   ```
4. Compare a few rows against the original PDF/XLSX.

## When the operator changes their format

Three signals to watch:
- Email arrives, adapter doesn't `detect()` → email lands in failed/flagged
- Email arrives, adapter detects, parse throws → email partial-failed with error message
- Email arrives, adapter detects, parse succeeds, but values look WRONG → silent regression, often caught only when the tenant complains about an export

Defense: keep `peek-<operator-slug>.ts` in the repo and run it against new samples whenever a tenant flags an issue. The peek script is your forensic tool.

See [runbooks/parser-failing.md](../runbooks/parser-failing.md).
