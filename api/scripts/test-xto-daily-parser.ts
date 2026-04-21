/**
 * Smoke test for the PDS XTO Daily PDF adapter (Format 5d).
 * Same assertion structure as Anadarko/Conoco/EOG daily tests.
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
    file: 'PDSWDX-DP-XTO-DAILY.pdf',
    expectedFormat: 'PDS XTO Daily',
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

    const badDate = outcome.records.filter((r) => !/^\d{4}-\d{2}-\d{2}$/.test(r.prodDate));
    if (badDate.length > 0) {
      console.log(
        `[FAIL] ${c.file}: ${badDate.length} records have a non-YYYY-MM-DD date (e.g. "${badDate[0].prodDate}")`
      );
      fail++;
      continue;
    }
    const nonDay1 = outcome.records.filter((r) => !/-\d{2}-01$/.test(r.prodDate)).length;
    if (nonDay1 === 0) {
      console.log(`[FAIL] ${c.file}: every prodDate is day 1 — daily granularity lost`);
      fail++;
      continue;
    }

    // Check daily-not-cumulative behavior on long-producing wells
    const byWell = new Map<string, typeof outcome.records>();
    for (const r of outcome.records) {
      if (!byWell.has(r.wellName)) byWell.set(r.wellName, []);
      byWell.get(r.wellName)!.push(r);
    }
    let multiDay = 0;
    let fluctuated = 0;
    for (const [, recs] of byWell) {
      // XTO example file has many wells that are shut-in for entire
      // periods. Look for wells with fluctuating gas OR oil rather
      // than oil-only (some wells in sample are pure gas).
      const producing = recs.filter(
        (r) =>
          (typeof r.oilProd === 'number' && (r.oilProd as number) > 0) ||
          (typeof r.gasProd === 'number' && (r.gasProd as number) > 0)
      );
      if (producing.length < 4) continue;
      multiDay++;
      producing.sort((a, b) => a.prodDate.localeCompare(b.prodDate));
      for (let i = 1; i < producing.length; i++) {
        const prevOil = producing[i - 1].oilProd as number | null;
        const curOil = producing[i].oilProd as number | null;
        const prevGas = producing[i - 1].gasProd as number | null;
        const curGas = producing[i].gasProd as number | null;
        if (
          (curOil !== null && prevOil !== null && curOil < prevOil) ||
          (curGas !== null && prevGas !== null && curGas < prevGas)
        ) {
          fluctuated++;
          break;
        }
      }
    }
    if (multiDay > 0 && fluctuated === 0) {
      console.log(
        `[FAIL] ${c.file}: ${multiDay} long-producing wells but NONE show fluctuation — looks cumulative`
      );
      fail++;
      continue;
    }

    const headerInName = outcome.records.filter((r) =>
      /^(Well Num|Well Name|Well ID|Prod Date|API|Oil Prod|Oil Sales|Gas Prod|Gas Sales|Water Prod|Water Inj|Tubing|Casing|Choke|Down Time|Downtime Reason|BeginOil|EndOil|Begin Oil|End Oil|Producing|Status|Active|Shut In)$/i.test(
        r.wellName.trim()
      )
    ).length;
    if (headerInName > 0) {
      console.log(`[FAIL] ${c.file}: ${headerInName} records have a header/status label as wellName`);
      fail++;
      continue;
    }

    // Diagnostics
    const uniqueWells = new Set(outcome.records.map((r) => r.wellName));
    const uniqueApis = new Set(outcome.records.map((r) => r.api14));
    const dateMin = outcome.records.map((r) => r.prodDate).sort()[0];
    const dateMax = outcome.records.map((r) => r.prodDate).sort().slice(-1)[0];
    const withTubing = outcome.records.filter((r) => typeof r.tubingPres === 'number').length;
    const withCasing = outcome.records.filter((r) => typeof r.casingPres === 'number').length;
    const withChoke = outcome.records.filter(
      (r) => typeof r.choke === 'string' && r.choke.length > 0
    ).length;
    const withHoursDown = outcome.records.filter(
      (r) => typeof r.hoursDown === 'number'
    ).length;
    const withDtReason = outcome.records.filter(
      (r) => r.downtimeReason && r.downtimeReason.length > 0
    ).length;
    const withWaterInj = outcome.records.filter((r) => typeof r.waterInj === 'number').length;
    const withOilSales = outcome.records.filter((r) => typeof r.oilSales === 'number').length;
    const withGasSales = outcome.records.filter((r) => typeof r.gasSales === 'number').length;
    const negativeOil = outcome.records.filter(
      (r) => typeof r.oilProd === 'number' && (r.oilProd as number) < 0
    ).length;

    // Multi-line downtime reasons should merge (both "Planned: S/I Long" and
    // "Term/PP" appear at x=705 — check at least some reasons are long/joined)
    const longReasons = outcome.records.filter(
      (r) => r.downtimeReason && r.downtimeReason.length > 15
    ).length;

    console.log(
      `[PASS] ${c.file}  records=${n}  wells=${uniqueWells.size}  apis=${uniqueApis.size}  dateRange=${dateMin}..${dateMax}`
    );
    console.log(
      `       coverage: tubingPres=${withTubing}/${n}, casingPres=${withCasing}/${n}, choke=${withChoke}/${n}, hoursDown=${withHoursDown}/${n}, dtReason=${withDtReason}/${n} (long=${longReasons}), waterInj=${withWaterInj}/${n}, oilSales=${withOilSales}/${n}, gasSales=${withGasSales}/${n}, negOil=${negativeOil}`
    );
    console.log(
      `       daily-not-cumulative: ${fluctuated}/${multiDay} long-producing wells show fluctuation`
    );

    const first = outcome.records[0];
    const last = outcome.records[outcome.records.length - 1];
    console.log(
      `       first: well="${first.wellName}" api10=${first.api10} api14=${first.api14} date=${first.prodDate} gas=${first.gasProd} oil=${first.oilProd} water=${first.waterProd} tub=${first.tubingPres} cas=${first.casingPres} choke=${first.choke} dt=${first.hoursDown} reason="${first.downtimeReason}"`
    );
    console.log(
      `       last : well="${last.wellName}" api14=${last.api14} date=${last.prodDate} gas=${last.gasProd} oil=${last.oilProd}`
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
