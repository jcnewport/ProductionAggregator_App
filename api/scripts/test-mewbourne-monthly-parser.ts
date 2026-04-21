/**
 * Smoke test for the PDS Mewbourne Monthly PDF adapter (Format 3).
 * Mirrors the XTO / EOG Monthly tests, with Mewbourne-specific checks:
 *   - All records must have non-empty operatorWellId (the 8-digit Well Num).
 *   - Tank-gauge oilBegin/oilEnd must NOT be mapped to oilProd/oilSales
 *     (we check that at least some extraFields.oilEnd values differ from
 *     oilProd — proves we're reading them as separate columns).
 *   - daysOn must be populated (this format reports it per month).
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
    file: 'PDSWDX-MP-mewbourne-MONTHLY.pdf',
    expectedFormat: 'PDS Mewbourne Monthly',
    minRecords: 50,
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
      { filename: c.file, mimeType: 'application/pdf', data: buffer } as any,
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
      console.log(`[FAIL] ${c.file}: got ${n} records, expected at least ${c.minRecords}`);
      fail++;
      continue;
    }

    const missingName = outcome.records.filter((r) => !r.wellName).length;
    if (missingName > 0) {
      console.log(`[FAIL] ${c.file}: ${missingName} records missing wellName`);
      fail++;
      continue;
    }

    const badApi10 = outcome.records.filter((r) => !/^\d{10}$/.test(r.api10)).length;
    if (badApi10 > 0) {
      console.log(`[FAIL] ${c.file}: ${badApi10} records have api10 that isn't 10 digits`);
      fail++;
      continue;
    }
    const badApi14 = outcome.records.filter((r) => !/^\d{14}$/.test(r.api14)).length;
    if (badApi14 > 0) {
      console.log(`[FAIL] ${c.file}: ${badApi14} records have api14 that isn't 14 digits`);
      fail++;
      continue;
    }
    const apiPrefixMismatch = outcome.records.filter(
      (r) => r.api14.slice(0, 10) !== r.api10
    ).length;
    if (apiPrefixMismatch > 0) {
      console.log(
        `[FAIL] ${c.file}: ${apiPrefixMismatch} records have api14 that doesn't start with api10`
      );
      fail++;
      continue;
    }

    // Every record must have a first-of-month prodDate.
    const badDate = outcome.records.filter(
      (r) => !/^\d{4}-\d{2}-01$/.test(r.prodDate)
    );
    if (badDate.length > 0) {
      console.log(
        `[FAIL] ${c.file}: ${badDate.length} records have a non-first-of-month date (e.g. "${badDate[0].prodDate}")`
      );
      fail++;
      continue;
    }

    // All records should have an 8-digit operatorWellId (Mewbourne Well Num).
    const missingWellNum = outcome.records.filter(
      (r) => r.operatorWellId === null || r.operatorWellId === undefined
    ).length;
    if (missingWellNum > 0) {
      console.log(
        `[FAIL] ${c.file}: ${missingWellNum} records missing operatorWellId (Mewbourne Well Num)`
      );
      fail++;
      continue;
    }

    // Tank-gauge separation check: at least some records should have
    // extraFields.oilEnd different from oilProd (proves they were read
    // as separate columns, not coalesced).
    const tankGaugeSeparate = outcome.records.filter((r) => {
      const oilEnd = r.extraFields?.oilEnd as number | null | undefined;
      const oilProd = r.oilProd;
      return (
        typeof oilEnd === 'number' &&
        typeof oilProd === 'number' &&
        Math.abs(oilEnd - oilProd) > 0.001
      );
    }).length;
    if (tankGaugeSeparate === 0) {
      console.log(
        `[FAIL] ${c.file}: tank-gauge oilEnd never differs from oilProd — tank gauges may be collapsed into Oil Prod`
      );
      fail++;
      continue;
    }

    // daysOn should be populated on most records.
    const withDaysOn = outcome.records.filter(
      (r) => typeof r.daysOn === 'number'
    ).length;
    if (withDaysOn === 0) {
      console.log(`[FAIL] ${c.file}: no records have daysOn populated`);
      fail++;
      continue;
    }

    const headerInName = outcome.records.filter((r) =>
      /^(Well Num|Well Name|API|Compl\.?\s*ID|Prod Date|BTU|Oil Begin|Oil Prod|OilSales|Oil End|Gas Prod|GasSales|Water Prod|DaysOn)$/i.test(
        r.wellName.trim()
      )
    ).length;
    if (headerInName > 0) {
      console.log(`[FAIL] ${c.file}: ${headerInName} records have a header label as wellName`);
      fail++;
      continue;
    }

    // Diagnostics
    const uniqueWells = new Set(outcome.records.map((r) => r.wellName));
    const uniqueApis = new Set(outcome.records.map((r) => r.api14));
    const uniqueWellNums = new Set(outcome.records.map((r) => r.operatorWellId));
    const dateMin = outcome.records.map((r) => r.prodDate).sort()[0];
    const dateMax = outcome.records.map((r) => r.prodDate).sort().slice(-1)[0];
    const withOilProd = outcome.records.filter((r) => typeof r.oilProd === 'number').length;
    const withOilSales = outcome.records.filter((r) => typeof r.oilSales === 'number').length;
    const withGasProd = outcome.records.filter((r) => typeof r.gasProd === 'number').length;
    const withGasSales = outcome.records.filter((r) => typeof r.gasSales === 'number').length;
    const withWaterProd = outcome.records.filter((r) => typeof r.waterProd === 'number').length;
    const withOilBegin = outcome.records.filter(
      (r) => typeof r.extraFields?.oilBegin === 'number'
    ).length;
    const withOilEnd = outcome.records.filter(
      (r) => typeof r.extraFields?.oilEnd === 'number'
    ).length;
    const withBtu = outcome.records.filter(
      (r) => typeof r.extraFields?.btu === 'number'
    ).length;
    const negativeOil = outcome.records.filter(
      (r) => typeof r.oilProd === 'number' && (r.oilProd as number) < 0
    ).length;

    console.log(
      `[PASS] ${c.file}  records=${n}  wells=${uniqueWells.size}  apis=${uniqueApis.size}  wellNums=${uniqueWellNums.size}  dateRange=${dateMin}..${dateMax}`
    );
    console.log(
      `       coverage: oilProd=${withOilProd}/${n}, oilSales=${withOilSales}/${n}, gasProd=${withGasProd}/${n}, gasSales=${withGasSales}/${n}, waterProd=${withWaterProd}/${n}, daysOn=${withDaysOn}/${n}, oilBegin=${withOilBegin}/${n}, oilEnd=${withOilEnd}/${n}, btu=${withBtu}/${n}, negOil=${negativeOil}`
    );
    console.log(
      `       tank-gauge-separation: ${tankGaugeSeparate}/${n} records have oilEnd != oilProd (confirms columns are distinct)`
    );

    const first = outcome.records[0];
    const last = outcome.records[outcome.records.length - 1];
    console.log(
      `       first: well="${first.wellName}" api10=${first.api10} api14=${first.api14} wellNum=${first.operatorWellId} date=${first.prodDate} oil=${first.oilProd} oilSales=${first.oilSales} gas=${first.gasProd} gasSales=${first.gasSales} water=${first.waterProd} days=${first.daysOn} oilBegin=${first.extraFields?.oilBegin} oilEnd=${first.extraFields?.oilEnd}`
    );
    console.log(
      `       last : well="${last.wellName}" api14=${last.api14} date=${last.prodDate} oil=${last.oilProd} gas=${last.gasProd}`
    );
    pass++;
  }

  console.log(`\n── Summary: ${pass} passed, ${fail} failed ──`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
