/**
 * Smoke test for the PDS XTO Monthly PDF adapter (Format 4).
 * Validates:
 *   - dispatcher routes to "PDS XTO Monthly" (not Anadarko / EOG)
 *   - ≥30 records from the 7-page sample
 *   - every record has wellName, api10 (10 digits), api14 (14 digits)
 *   - api14 = api10 + "0000" per project convention
 *   - every prodDate is first-of-month (YYYY-MM-01)
 *   - oilProd looks like MONTHLY values, not cumulative: for at least one
 *     long-producing well, oilProd values fluctuate (cum would be strictly
 *     non-decreasing). Cumulative columns (OilCum/GasCum) are NOT part
 *     of the ComboCurve export, so we only sanity-check that they didn't
 *     leak into oilProd.
 *   - no wellName is a header label (header row didn't leak into data)
 *   - every ProductionStatus / Well Status is a non-numeric string
 *     (would indicate x-center misalignment)
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
    file: 'PDSWDX-MP-XTO-MONTHLY.pdf',
    expectedFormat: 'PDS XTO Monthly',
    // 7 pages × ~20 rows/page = conservative floor after filtering
    minRecords: 30,
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

    // Every record must have wellName, api10 (10 digits), api14 (14 digits)
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
    // api14 must be api10 + "0000"
    const apiMismatch = outcome.records.filter(
      (r) => r.api14 !== r.api10 + '0000'
    ).length;
    if (apiMismatch > 0) {
      console.log(
        `[FAIL] ${c.file}: ${apiMismatch} records have api14 that isn't api10 + "0000"`
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

    // Sanity: oilProd must be MONTHLY, not cumulative.
    // Cumulative values would be strictly non-decreasing over time.
    // Real monthly production fluctuates (down months follow up months).
    // For each well with ≥4 months of producing history, confirm oilProd
    // is NOT strictly monotonically non-decreasing (i.e., has at least
    // one month lower than the previous).
    const byWell = new Map<string, typeof outcome.records>();
    for (const r of outcome.records) {
      if (!byWell.has(r.wellName)) byWell.set(r.wellName, []);
      byWell.get(r.wellName)!.push(r);
    }
    let longProducers = 0;
    let wellsWithFluctuation = 0;
    for (const [, recs] of byWell) {
      const producing = recs.filter(
        (r) => typeof r.oilProd === 'number' && (r.oilProd as number) > 0
      );
      if (producing.length < 4) continue;
      longProducers++;
      producing.sort((a, b) => a.prodDate.localeCompare(b.prodDate));
      let fluctuated = false;
      for (let i = 1; i < producing.length; i++) {
        if ((producing[i].oilProd as number) < (producing[i - 1].oilProd as number)) {
          fluctuated = true;
          break;
        }
      }
      if (fluctuated) wellsWithFluctuation++;
    }
    if (longProducers > 0 && wellsWithFluctuation === 0) {
      console.log(
        `[FAIL] ${c.file}: ${longProducers} long-producing wells but NONE show oilProd fluctuation — oilProd may be cumulative, not monthly`
      );
      fail++;
      continue;
    }

    // Header labels should not appear as wellName
    const headerInName = outcome.records.filter((r) =>
      /^(Well Num|Well Name|Prod Date|Producing|OilProd|OilSales|OilCum|GasProd|GasSales|GasCum|GasInj|WaterProd|WaterInj|Pressure|Well Status)$/i.test(
        r.wellName.trim()
      )
    ).length;
    if (headerInName > 0) {
      console.log(
        `[FAIL] ${c.file}: ${headerInName} records have a header label as wellName`
      );
      fail++;
      continue;
    }

    // Producing Status should be a non-numeric string where present
    const badProducingStatus = outcome.records.filter((r) => {
      const ps = (r.extraFields as any)?.producingStatus;
      return ps != null && /^\d/.test(String(ps));
    }).length;
    if (badProducingStatus > 0) {
      console.log(
        `[FAIL] ${c.file}: ${badProducingStatus} records have numeric producingStatus (x-alignment likely off)`
      );
      fail++;
      continue;
    }

    // Diagnostics
    const uniqueWells = new Set(outcome.records.map((r) => r.wellName));
    const uniqueApis = new Set(outcome.records.map((r) => r.api14));
    const dateMin = outcome.records.map((r) => r.prodDate).sort()[0];
    const dateMax = outcome.records.map((r) => r.prodDate).sort().slice(-1)[0];
    const withGasInj = outcome.records.filter(
      (r) => typeof (r.extraFields as any)?.gasInj === 'number'
    ).length;
    const withPressureBase = outcome.records.filter(
      (r) => typeof (r.extraFields as any)?.pressureBase === 'number'
    ).length;
    const withStatus = outcome.records.filter(
      (r) => (r.extraFields as any)?.wellStatus != null
    ).length;
    console.log(
      `[PASS] ${c.file}  records=${n}  wells=${uniqueWells.size}  apis=${uniqueApis.size}  dateRange=${dateMin}..${dateMax}`
    );
    console.log(
      `       extraFields coverage: gasInj=${withGasInj}/${n}, pressureBase=${withPressureBase}/${n}, wellStatus=${withStatus}/${n}`
    );
    console.log(
      `       monthly-not-cumulative check: ${wellsWithFluctuation}/${longProducers} long-producing wells show oilProd fluctuation`
    );

    const first = outcome.records[0];
    const last = outcome.records[outcome.records.length - 1];
    console.log(
      `       first: well="${first.wellName}" api10=${first.api10} api14=${first.api14} date=${first.prodDate} oil=${first.oilProd} oilSales=${first.oilSales} gas=${first.gasProd} waterProd=${first.waterProd} wellStatus="${(first.extraFields as any)?.wellStatus}"`
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
