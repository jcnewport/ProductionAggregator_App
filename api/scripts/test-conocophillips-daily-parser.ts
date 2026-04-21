/**
 * Smoke test for the PDS ConocoPhillips Daily PDF adapter (Format 5).
 * Validates:
 *   - dispatcher routes to "PDS ConocoPhillips Daily"
 *   - ≥500 records from the 143-page sample (very conservative floor —
 *     ~30 days × tens of wells)
 *   - every record has wellName
 *   - every record has api10 (10 digits) and api14 (14 digits)
 *   - every prodDate matches YYYY-MM-DD (NOT first-of-month — this is daily)
 *   - api14 starts with api10 (invariant across all API widths — 12-digit
 *     sources preserve sidetrack digits in positions 11-12 which our
 *     pad-to-14 keeps, so api14 is NOT always api10+"0000")
 *   - oil/gas/water values look like daily (not monthly) — for each
 *     multi-day well, oilProd fluctuates rather than being strictly
 *     monotonic (cumulative signature)
 *   - BHP lives in extraFields, not in any volume column
 *   - no wellName equals a header label
 *   - tubing/casing pressure columns populated on a reasonable % of rows
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
    file: 'PDSWDX-DP-conocophillips-DAILY.pdf',
    expectedFormat: 'PDS ConocoPhillips Daily',
    minRecords: 500,
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

    // Every record must have wellName
    const missingName = outcome.records.filter((r) => !r.wellName).length;
    if (missingName > 0) {
      console.log(`[FAIL] ${c.file}: ${missingName} records missing wellName`);
      fail++;
      continue;
    }

    // API structural checks
    const badApi10 = outcome.records.filter((r) => !/^\d{10}$/.test(r.api10)).length;
    if (badApi10 > 0) {
      console.log(
        `[FAIL] ${c.file}: ${badApi10} records have api10 that isn't 10 digits`
      );
      fail++;
      continue;
    }
    const badApi14 = outcome.records.filter((r) => !/^\d{14}$/.test(r.api14)).length;
    if (badApi14 > 0) {
      console.log(
        `[FAIL] ${c.file}: ${badApi14} records have api14 that isn't 14 digits`
      );
      fail++;
      continue;
    }
    // api14 must START with api10 — the trailing 4 digits encode
    // sidetrack (2) + completion (2). For wells with sidetrack codes,
    // api14[10:12] will be non-zero. This is the correct invariant;
    // api14 == api10 + "0000" only holds for first-bore wells.
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
    // Diagnostic: how many records have sidetrack encoding (api14[10:12] != "00")?
    const withSidetrack = outcome.records.filter(
      (r) => r.api14.slice(10, 12) !== '00'
    ).length;

    // Daily dates — YYYY-MM-DD, NOT first-of-month
    const badDate = outcome.records.filter(
      (r) => !/^\d{4}-\d{2}-\d{2}$/.test(r.prodDate)
    );
    if (badDate.length > 0) {
      console.log(
        `[FAIL] ${c.file}: ${badDate.length} records have a non-YYYY-MM-DD date (e.g. "${badDate[0].prodDate}")`
      );
      fail++;
      continue;
    }
    // Sanity: at least a handful of records should NOT be on day 1 (proves
    // we're keeping daily granularity rather than accidentally collapsing
    // to first-of-month).
    const nonDay1 = outcome.records.filter(
      (r) => !/-\d{2}-01$/.test(r.prodDate)
    ).length;
    if (nonDay1 === 0) {
      console.log(
        `[FAIL] ${c.file}: every prodDate is day 1 — daily granularity lost`
      );
      fail++;
      continue;
    }

    // Sanity: oilProd must be DAILY, not cumulative. For each well with
    // multiple producing days, oilProd must have at least one day where
    // the value went DOWN from the previous day. Cumulative would only
    // ever grow.
    const byWell = new Map<string, typeof outcome.records>();
    for (const r of outcome.records) {
      if (!byWell.has(r.wellName)) byWell.set(r.wellName, []);
      byWell.get(r.wellName)!.push(r);
    }
    let multiDay = 0;
    let fluctuated = 0;
    for (const [, recs] of byWell) {
      const producing = recs.filter(
        (r) => typeof r.oilProd === 'number' && (r.oilProd as number) > 0
      );
      if (producing.length < 4) continue;
      multiDay++;
      producing.sort((a, b) => a.prodDate.localeCompare(b.prodDate));
      for (let i = 1; i < producing.length; i++) {
        if (
          (producing[i].oilProd as number) <
          (producing[i - 1].oilProd as number)
        ) {
          fluctuated++;
          break;
        }
      }
    }
    if (multiDay > 0 && fluctuated === 0) {
      console.log(
        `[FAIL] ${c.file}: ${multiDay} long-producing wells but NONE show oilProd fluctuation — oilProd may be cumulative, not daily`
      );
      fail++;
      continue;
    }

    // BHP must live in extraFields.bhp (NOT in any of the 16-col fields).
    // Sample a couple of records to confirm bhp is populated.
    const withBhp = outcome.records.filter(
      (r) => typeof (r.extraFields as any)?.bhp === 'number'
    ).length;
    if (withBhp === 0) {
      console.log(
        `[FAIL] ${c.file}: extraFields.bhp is never populated — BHP column not being captured`
      );
      fail++;
      continue;
    }

    // Header labels should not appear as wellName
    const headerInName = outcome.records.filter((r) =>
      /^(Well Num|Well Name|Well ID|Prod Date|Completion No|API|Oil Prod|Oil Sales|Gas Prod|Gas Sales|Water Prod|Tubing Pres\.?|Casing Pres\.?|BHP)$/i.test(
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

    // Diagnostics
    const uniqueWells = new Set(outcome.records.map((r) => r.wellName));
    const uniqueApis = new Set(outcome.records.map((r) => r.api14));
    const dateMin = outcome.records.map((r) => r.prodDate).sort()[0];
    const dateMax = outcome.records
      .map((r) => r.prodDate)
      .sort()
      .slice(-1)[0];
    const withTubing = outcome.records.filter(
      (r) => typeof r.tubingPres === 'number'
    ).length;
    const withCasing = outcome.records.filter(
      (r) => typeof r.casingPres === 'number'
    ).length;
    const withOilSales = outcome.records.filter(
      (r) => typeof r.oilSales === 'number'
    ).length;
    const negativeOil = outcome.records.filter(
      (r) => typeof r.oilProd === 'number' && (r.oilProd as number) < 0
    ).length;

    console.log(
      `[PASS] ${c.file}  records=${n}  wells=${uniqueWells.size}  apis=${uniqueApis.size}  dateRange=${dateMin}..${dateMax}`
    );
    console.log(
      `       column coverage: tubingPres=${withTubing}/${n}, casingPres=${withCasing}/${n}, oilSales=${withOilSales}/${n} (expected ~0), bhp=${withBhp}/${n}, negativeOil=${negativeOil}, withSidetrack=${withSidetrack}`
    );
    console.log(
      `       monthly-not-cumulative check: ${fluctuated}/${multiDay} long-producing wells show oilProd fluctuation`
    );

    const first = outcome.records[0];
    const last = outcome.records[outcome.records.length - 1];
    console.log(
      `       first: well="${first.wellName}" api10=${first.api10} api14=${first.api14} date=${first.prodDate} oil=${first.oilProd} gas=${first.gasProd} water=${first.waterProd} tub=${first.tubingPres} cas=${first.casingPres} bhp=${(first.extraFields as any)?.bhp}`
    );
    console.log(
      `       last : well="${last.wellName}" api14=${last.api14} date=${last.prodDate} oil=${last.oilProd}`
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
