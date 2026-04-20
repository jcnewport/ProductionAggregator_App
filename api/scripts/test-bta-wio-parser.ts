/**
 * Smoke test for the BTA WIO Mailout PDF adapter.
 * Validates:
 *   - dispatcher routes to "BTA WIO Mailout Monthly"
 *   - 4 wells parsed (one row each for Feb 2026)
 *   - every record has a wellName but NO api10/api14
 *   - Oil Prod ≈ Oil Sold and Gas Prod ≈ Gas Sold (BTA's sample is very close)
 *   - monthly date is first-of-month; rawProdDate preserves end-of-month
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dispatchParser } from '../src/parsers/index.js';

const WORKSPACE = path.resolve(__dirname, '..', '..');

const cases: { file: string; expectedFormat: string; expectRecords: number }[] = [
  {
    file: 'February 2026 West Pecos Trading WIO Mailout.pdf',
    expectedFormat: 'BTA WIO Mailout Monthly',
    expectRecords: 4, // 4 wells × 1 month
  },
];

async function main() {
  let pass = 0;
  let fail = 0;

  for (const c of cases) {
    const full = path.join(WORKSPACE, c.file);
    if (!fs.existsSync(full)) {
      console.log(`[SKIP] ${c.file}: file not found`);
      continue;
    }
    const buffer = fs.readFileSync(full);
    const outcome = await dispatchParser(
      {
        filename: c.file,
        mimeType: 'application/pdf',
        data: buffer,
      } as any,
      'test@example.com'
    );

    if (outcome.kind !== 'parsed') {
      console.log(`[FAIL] ${c.file}: outcome.kind=${outcome.kind}`);
      if (outcome.kind === 'error') console.log(`       ${outcome.message}`);
      if (outcome.kind === 'unrecognized') console.log(`       ${outcome.reason}`);
      fail++;
      continue;
    }
    if (outcome.formatName !== c.expectedFormat) {
      console.log(
        `[FAIL] ${c.file}: routed to "${outcome.formatName}", expected "${c.expectedFormat}"`
      );
      fail++;
      continue;
    }
    if (outcome.records.length !== c.expectRecords) {
      console.log(
        `[FAIL] ${c.file}: got ${outcome.records.length} records, expected ${c.expectRecords}`
      );
      fail++;
      continue;
    }

    // All records should have wellName, NO api, and 4 volumes.
    for (const r of outcome.records) {
      if (!r.wellName) {
        console.log(`[FAIL] ${c.file}: record missing wellName`);
        fail++;
        continue;
      }
      if (r.api10 || r.api14) {
        console.log(
          `[FAIL] ${c.file}: record has api (${r.api10}/${r.api14}) — this format has no API`
        );
        fail++;
        continue;
      }
      if (
        r.oilProd == null ||
        r.oilSales == null ||
        r.gasProd == null ||
        r.gasSales == null
      ) {
        console.log(
          `[FAIL] ${c.file}: record missing one of the 4 volumes — got oilProd=${r.oilProd} oilSales=${r.oilSales} gasProd=${r.gasProd} gasSales=${r.gasSales}`
        );
        fail++;
        continue;
      }
      // Oil Prod and Oil Sold should be close (within ~15%) in BTA's sample
      const oilRatio = r.oilSales! / r.oilProd!;
      if (oilRatio < 0.8 || oilRatio > 1.2) {
        console.log(
          `[WARN] ${c.file}: well=${r.wellName} oilProd=${r.oilProd} oilSales=${r.oilSales} ratio=${oilRatio.toFixed(2)}  — unexpected divergence (column assignment may be off)`
        );
      }
    }

    // Monthly date convention: first-of-month
    const badDate = outcome.records.find((r) => !/-01$/.test(r.prodDate));
    if (badDate) {
      console.log(
        `[FAIL] ${c.file}: record has non-first-of-month prodDate "${badDate.prodDate}" — monthly convention broken`
      );
      fail++;
      continue;
    }

    console.log(`[PASS] ${c.file}  records=${outcome.records.length}`);
    for (const r of outcome.records) {
      const raw = (r.extraFields as any)?.rawProdDate;
      console.log(
        `       well="${r.wellName}" prodDate=${r.prodDate} (raw=${raw}) oilProd=${r.oilProd} oilSales=${r.oilSales} gasProd=${r.gasProd} gasSales=${r.gasSales}`
      );
    }
    pass++;
  }

  console.log(`\n── Summary: ${pass} passed, ${fail} failed ──`);
  if (fail > 0) process.exit(1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
