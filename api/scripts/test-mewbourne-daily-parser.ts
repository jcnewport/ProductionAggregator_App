/**
 * Smoke test for the PDS Mewbourne Daily PDF adapter (Format 5c).
 * Same assertion structure as the Anadarko / EOG / XTO / Conoco daily tests,
 * but relaxed where the Mewbourne Daily format legitimately has no data:
 *   - No Sales columns → oilSales / gasSales coverage = 0 (expected).
 *   - No Hours Down / Downtime Reason columns → 0 coverage expected.
 *   - No Water Inject column → 0 coverage expected.
 *   - Fluctuation check uses gas OR oil (Mewbourne wells can be gas-heavy).
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
    file: 'PDSWDX-DP-mewbourne-DAILY.pdf',
    expectedFormat: 'PDS Mewbourne Daily',
    minRecords: 200,
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

    // Check daily-not-cumulative behavior — fluctuation on gas OR oil.
    const byWell = new Map<string, typeof outcome.records>();
    for (const r of outcome.records) {
      if (!byWell.has(r.wellName)) byWell.set(r.wellName, []);
      byWell.get(r.wellName)!.push(r);
    }
    let multiDay = 0;
    let fluctuated = 0;
    for (const [, recs] of byWell) {
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
      /^(Well Num|Well Name|Well ID|Prod Date|API|Oil Prod|Oil Sales|Gas Prod|Gas Sales|Water Prod|Water Inj|Tubing Pres\.?|Casing Pres\.?|Choke|Compl\.?Id|Comp\.?Id|BTU)$/i.test(
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
    const dateMin = outcome.records.map((r) => r.prodDate).sort()[0];
    const dateMax = outcome.records.map((r) => r.prodDate).sort().slice(-1)[0];
    const withTubing = outcome.records.filter((r) => typeof r.tubingPres === 'number').length;
    const withCasing = outcome.records.filter((r) => typeof r.casingPres === 'number').length;
    const withChoke = outcome.records.filter(
      (r) => typeof r.choke === 'string' && r.choke.length > 0
    ).length;
    const withGas = outcome.records.filter((r) => typeof r.gasProd === 'number').length;
    const withOil = outcome.records.filter((r) => typeof r.oilProd === 'number').length;
    const withWater = outcome.records.filter((r) => typeof r.waterProd === 'number').length;
    const withWellId = outcome.records.filter(
      (r) => typeof r.operatorWellId === 'number'
    ).length;
    const negativeOil = outcome.records.filter(
      (r) => typeof r.oilProd === 'number' && (r.oilProd as number) < 0
    ).length;

    console.log(
      `[PASS] ${c.file}  records=${n}  wells=${uniqueWells.size}  apis=${uniqueApis.size}  dateRange=${dateMin}..${dateMax}`
    );
    console.log(
      `       coverage: gasProd=${withGas}/${n}, oilProd=${withOil}/${n}, waterProd=${withWater}/${n}, tubingPres=${withTubing}/${n}, casingPres=${withCasing}/${n}, choke=${withChoke}/${n}, operatorWellId=${withWellId}/${n}, negOil=${negativeOil}`
    );
    console.log(
      `       daily-not-cumulative: ${fluctuated}/${multiDay} long-producing wells show fluctuation`
    );

    const first = outcome.records[0];
    const last = outcome.records[outcome.records.length - 1];
    console.log(
      `       first: well="${first.wellName}" api10=${first.api10} api14=${first.api14} date=${first.prodDate} gas=${first.gasProd} oil=${first.oilProd} water=${first.waterProd} tub=${first.tubingPres} cas=${first.casingPres} choke=${first.choke} wellID=${first.operatorWellId}`
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
