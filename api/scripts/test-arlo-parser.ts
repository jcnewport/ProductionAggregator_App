/**
 * Smoke test for the Arlo Partner Report XLSX adapter.
 * Checks both Arlo and Pinon workbooks parse cleanly with the same adapter.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dispatchParser } from '../src/parsers/index.js';

const WORKSPACE = path.resolve(__dirname, '..', '..');

const cases: { file: string; minRecords: number }[] = [
  { file: '2026.03.30 Arlo Production.xlsx', minRecords: 25 }, // 30-ish rows, 1 well
  { file: 'pinonPartnerReport.nopag.xlsx', minRecords: 25 },
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
    if (outcome.formatName !== 'Arlo Partner Report XLSX') {
      console.log(
        `[FAIL] ${c.file}: routed to "${outcome.formatName}", expected "Arlo Partner Report XLSX"`
      );
      fail++;
      continue;
    }
    if (outcome.records.length < c.minRecords) {
      console.log(
        `[FAIL] ${c.file}: got ${outcome.records.length} records, expected ≥ ${c.minRecords}`
      );
      fail++;
      continue;
    }
    const first = outcome.records[0];
    console.log(
      `[PASS] ${c.file}  records=${outcome.records.length}  dataType=${outcome.dataType}`
    );
    console.log(
      `       first: well="${first.wellName}" api14=${first.api14} date=${first.prodDate} ` +
        `oil=${first.oilProd} gas=${first.gasProd} water=${first.waterProd} ` +
        `tubing=${first.tubingPres} casing=${first.casingPres} extra=${JSON.stringify(first.extraFields)}`
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
