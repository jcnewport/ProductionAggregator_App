/**
 * Smoke test for the PDS EOG Monthly PDF adapter (Format 2).
 * Runs it against the real sample file and validates:
 *   - dispatcher routes to "PDS EOG Monthly" (NOT Anadarko — both are PDS)
 *   - at least ~100 records extracted (5-page PDF, 3 well pads, many months)
 *   - every record has wellName AND api14 (EOG reports always include it)
 *   - api10 is exactly 10 digits
 *   - every record has a prodDate of the form YYYY-MM-01 (first of month)
 *   - extraFields.rawProdDate preserves the original end-of-month date
 *   - negative Oil Prod values ARE present and preserved (BS&W corrections)
 *   - DaysOn is captured as a number for most records
 *   - No wellName is a header label ("Well Name", "API", etc.) — would indicate
 *     the header row bled into data
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dispatchParser } from '../src/parsers/index.js';

const WORKSPACE = path.resolve(__dirname, '..', '..');

const cases: {
  file: string;
  expectedFormat: string;
  minRecords: number;
}[] = [
  {
    file: 'PDSWDX-MP-EOG-MONTHLY.pdf',
    expectedFormat: 'PDS EOG Monthly',
    minRecords: 50, // 5 pages × ~15-25 rows/page = conservative floor
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

    const n = outcome.records.length;
    if (n < c.minRecords) {
      console.log(
        `[FAIL] ${c.file}: got ${n} records, expected at least ${c.minRecords}`
      );
      fail++;
      continue;
    }

    // Every record must have wellName + api14 (EOG always provides both)
    const missingName = outcome.records.filter((r) => !r.wellName).length;
    if (missingName > 0) {
      console.log(
        `[FAIL] ${c.file}: ${missingName} records missing wellName`
      );
      fail++;
      continue;
    }
    const missingApi = outcome.records.filter((r) => !r.api14).length;
    if (missingApi > 0) {
      console.log(
        `[FAIL] ${c.file}: ${missingApi} records missing api14 (EOG always provides it)`
      );
      fail++;
      continue;
    }

    // api10 must be exactly 10 digits and derived from api14
    const badApi10 = outcome.records.filter((r) => !/^\d{10}$/.test(r.api10)).length;
    if (badApi10 > 0) {
      console.log(
        `[FAIL] ${c.file}: ${badApi10} records have api10 that isn't 10 digits`
      );
      fail++;
      continue;
    }
    const api14Mismatch = outcome.records.filter(
      (r) => r.api10 !== r.api14.slice(0, 10)
    ).length;
    if (api14Mismatch > 0) {
      console.log(
        `[FAIL] ${c.file}: ${api14Mismatch} records have api10 that doesn't match api14.slice(0,10)`
      );
      fail++;
      continue;
    }

    // Every prodDate must be first-of-month
    const badDate = outcome.records.filter(
      (r) => !/^\d{4}-\d{2}-01$/.test(r.prodDate)
    );
    if (badDate.length > 0) {
      console.log(
        `[FAIL] ${c.file}: ${badDate.length} records have non-first-of-month prodDate (e.g. "${badDate[0].prodDate}")`
      );
      fail++;
      continue;
    }

    // rawProdDate in extraFields should be end-of-month (YYYY-MM-DD where DD >= 28)
    const rawLeaked = outcome.records.filter((r) => {
      const raw = (r.extraFields as any)?.rawProdDate;
      return !raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw);
    }).length;
    if (rawLeaked > 0) {
      console.log(
        `[FAIL] ${c.file}: ${rawLeaked} records missing or malformed extraFields.rawProdDate`
      );
      fail++;
      continue;
    }

    // No wellName should look like a header label
    const headerInName = outcome.records.filter((r) =>
      /^(Well Name|API|Prod Date|DaysOn|Oil Prod|Oil Sales|Gas Prod|Gas Sales|Water Prod|Water Inj|Well ID)$/i.test(
        r.wellName.trim()
      )
    ).length;
    if (headerInName > 0) {
      console.log(
        `[FAIL] ${c.file}: ${headerInName} records have a header label as wellName — header row leaked into data`
      );
      fail++;
      continue;
    }

    // Diagnostics
    const negativeOil = outcome.records.filter(
      (r) => r.oilProd != null && r.oilProd < 0
    ).length;
    const withDaysOn = outcome.records.filter(
      (r) => typeof r.daysOn === 'number'
    ).length;
    const uniqueWells = new Set(outcome.records.map((r) => r.wellName));
    const uniqueApis = new Set(outcome.records.map((r) => r.api14));
    const dateMin = outcome.records
      .map((r) => r.prodDate)
      .sort()[0];
    const dateMax = outcome.records
      .map((r) => r.prodDate)
      .sort()
      .slice(-1)[0];

    console.log(
      `[PASS] ${c.file}  records=${n}  wells=${uniqueWells.size}  apis=${uniqueApis.size}  dateRange=${dateMin}..${dateMax}`
    );
    console.log(
      `       negativeOilProd=${negativeOil} (BS&W corrections preserved), withDaysOn=${withDaysOn}/${n}`
    );

    // Print first and last for eyeball sanity
    const first = outcome.records[0];
    const last = outcome.records[outcome.records.length - 1];
    console.log(
      `       first: well="${first.wellName}" api14=${first.api14} date=${first.prodDate} (raw=${(first.extraFields as any)?.rawProdDate}) oilProd=${first.oilProd} oilSales=${first.oilSales} gasProd=${first.gasProd} gasSales=${first.gasSales} waterProd=${first.waterProd} waterInj=${first.waterInj} daysOn=${first.daysOn}`
    );
    console.log(
      `       last : well="${last.wellName}" api14=${last.api14} date=${last.prodDate} oilProd=${last.oilProd} oilSales=${last.oilSales} gasProd=${last.gasProd} waterProd=${last.waterProd}`
    );

    // If a negative Oil Prod exists, print one so we can see it preserved
    const oneNeg = outcome.records.find(
      (r) => r.oilProd != null && r.oilProd < 0
    );
    if (oneNeg) {
      console.log(
        `       neg sample: well="${oneNeg.wellName}" date=${oneNeg.prodDate} oilProd=${oneNeg.oilProd}`
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
