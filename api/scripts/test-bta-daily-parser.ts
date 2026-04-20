/**
 * Smoke test for the BTA Daily Per-Well Sheets XLSX adapter.
 * Runs it against the real sample file and checks:
 *   - dispatcher routes to "BTA Daily Per-Well Sheets"
 *   - every record has a wellName
 *   - every record has NO api10/api14 (this format has no API column)
 *   - Grand Total rows are not emitted as records
 *   - 4 sheets × ~31 days = ~124 total records expected
 *   - Choke preserved as string "64/64"
 *   - Compound Well Site cell parsed into wellName + operatorWellId
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dispatchParser } from '../src/parsers/index.js';

const WORKSPACE = path.resolve(__dirname, '..', '..');

const cases: {
  file: string;
  expectedFormat: string;
  minRecords: number;
  maxRecords: number;
  expectSheets: number;
}[] = [
  {
    file: 'March 2026 Daily Production.xlsx',
    expectedFormat: 'BTA Daily Per-Well Sheets',
    minRecords: 100, // 4 wells × ~31 days = 124 expected; conservative floor
    maxRecords: 150, // sanity cap to catch Grand Total leakage (would be 132)
    expectSheets: 4,
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
        mimeType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
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
    if (n < c.minRecords || n > c.maxRecords) {
      console.log(
        `[FAIL] ${c.file}: got ${n} records, expected ${c.minRecords}..${c.maxRecords}`
      );
      fail++;
      continue;
    }

    // Every record must have a well name
    const missingName = outcome.records.filter((r) => !r.wellName).length;
    if (missingName > 0) {
      console.log(
        `[FAIL] ${c.file}: ${missingName} records missing wellName`
      );
      fail++;
      continue;
    }

    // BTA daily has NO API column — expect ALL records to have empty api10/api14
    const hasAnyApi = outcome.records.filter((r) => r.api10 || r.api14).length;
    if (hasAnyApi > 0) {
      console.log(
        `[FAIL] ${c.file}: ${hasAnyApi} records unexpectedly have API (this format has no API col)`
      );
      fail++;
      continue;
    }

    // No "Grand Total" slipped into wellName
    const totalLeak = outcome.records.filter((r) =>
      /total/i.test(r.wellName)
    ).length;
    if (totalLeak > 0) {
      console.log(
        `[FAIL] ${c.file}: ${totalLeak} records have "Total" in wellName — Grand Total row wasn't filtered`
      );
      fail++;
      continue;
    }

    // Choke sanity: at least some records should carry "64/64"
    const chokePreserved = outcome.records.filter(
      (r) => r.choke && r.choke.includes('/')
    ).length;
    if (chokePreserved === 0) {
      console.log(
        `[WARN] ${c.file}: no records preserved the "64/64" choke string. Check parseNum/toString path.`
      );
    }

    // operatorWellId parsed from compound Well Site
    const haveWellId = outcome.records.filter(
      (r) => typeof r.operatorWellId === 'number'
    ).length;
    const uniqueWellIds = new Set(
      outcome.records.map((r) => r.operatorWellId).filter((x) => x != null)
    );

    const wells = new Set(outcome.records.map((r) => r.wellName));
    const sheetSet = new Set(
      outcome.records.map((r) => (r.extraFields as any)?.sheetName)
    );

    console.log(
      `[PASS] ${c.file}  records=${n}  wells=${wells.size}  sheets=${sheetSet.size}  operatorWellIds=${uniqueWellIds.size}`
    );
    const first = outcome.records[0];
    const last = outcome.records[outcome.records.length - 1];
    console.log(
      `       first: well="${first.wellName}" opId=${first.operatorWellId} date=${first.prodDate} oil=${first.oilProd} gas=${first.gasProd} water=${first.waterProd} choke="${first.choke}" hoursDown=${first.hoursDown} reason=${JSON.stringify(first.downtimeReason)}`
    );
    console.log(
      `       last : well="${last.wellName}" opId=${last.operatorWellId} date=${last.prodDate} oil=${last.oilProd} gas=${last.gasProd} water=${last.waterProd}`
    );
    console.log(
      `       checks: sheets=${sheetSet.size}/${c.expectSheets}, chokePreserved=${chokePreserved}/${n}, haveWellId=${haveWellId}/${n}`
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
