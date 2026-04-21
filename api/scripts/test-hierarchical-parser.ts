/**
 * Smoke test for the Hierarchical Allocated-Production adapters.
 * Runs them against all real samples (XLSX + PDF variants) and prints
 * per-file record counts, first/last record, missing-API count, and
 * well count.
 *
 * The PDF adapter (hierarchicalAllocatedPdfAdapter) shares column
 * semantics with the XLSX adapter; when both variants exist for the
 * same reporting period they should produce the same well+date rows
 * (values may differ slightly by PDF-rendering quirks — see the
 * "pdfParseWarning" extraField for flagged rows).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dispatchParser } from '../src/parsers/index.js';

const WORKSPACE = path.resolve(__dirname, '..', '..');

const cases: {
  file: string;
  mimeType: string;
  expectedFormat: string;
  minRecords: number;
  expectApi: boolean;
}[] = [
  {
    file: '2026.03.03 Tap Rock Partner Report Feb 2026.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    expectedFormat: 'Hierarchical Allocated Production XLSX',
    minRecords: 150, // Feb 2026 has ~8 wells x ~28 days each ≈ 224 — conservative floor
    expectApi: true,
  },
  {
    file: '2026.04.03 Tap Rock Partner Report Mar 2026.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    expectedFormat: 'Hierarchical Allocated Production XLSX',
    minRecords: 150,
    expectApi: true,
  },
  {
    file: 'PARTNER REPORT - WEST PECOS.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    expectedFormat: 'Hierarchical Allocated Production XLSX',
    minRecords: 150,
    expectApi: true,
  },
  {
    file: 'Monthly Report.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    expectedFormat: 'Hierarchical Allocated Production XLSX',
    minRecords: 30, // 2 wells x ~30 days = 60 rows
    expectApi: false, // Monthly_Report has no API column
  },
  // ─── PDF variants — same "Partner Report" layout in PDF form ───
  {
    file: 'PARTNER REPORT - WEST PECOS.pdf',
    mimeType: 'application/pdf',
    expectedFormat: 'Hierarchical Allocated Production PDF',
    minRecords: 150, // 8 wells x 28 days = 224 — same floor as XLSX
    expectApi: true,
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
        mimeType: c.mimeType,
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
    if (outcome.records.length < c.minRecords) {
      console.log(
        `[FAIL] ${c.file}: got ${outcome.records.length} records, expected >= ${c.minRecords}`
      );
      fail++;
      continue;
    }

    const first = outcome.records[0];
    const last = outcome.records[outcome.records.length - 1];
    const missingApi = outcome.records.filter((r) => !r.api10).length;
    const wells = new Set(outcome.records.map((r) => r.wellName));

    // Sanity check for API expectation
    if (c.expectApi && missingApi > 0) {
      console.log(
        `[FAIL] ${c.file}: expected ALL records to have API but ${missingApi} are missing`
      );
      fail++;
      continue;
    }
    if (!c.expectApi && missingApi !== outcome.records.length) {
      console.log(
        `[WARN] ${c.file}: expected all records to MISS API (Monthly Report has no API col) but ${outcome.records.length - missingApi} have API. Not a failure but surprising.`
      );
    }

    console.log(
      `[PASS] ${c.file}  records=${outcome.records.length}  wells=${wells.size}  missingApi=${missingApi}/${outcome.records.length}  dataType=${outcome.dataType}`
    );
    console.log(
      `       first: well="${first.wellName}" api14=${first.api14 || '(none)'} date=${first.prodDate} oil=${first.oilProd} gas=${first.gasProd} water=${first.waterProd} choke=${first.choke} tub=${first.tubingPres} cas=${first.casingPres} hoursDown=${first.hoursDown}`
    );
    console.log(
      `       last : well="${last.wellName}" api14=${last.api14 || '(none)'} date=${last.prodDate} oil=${last.oilProd} gas=${last.gasProd} water=${last.waterProd}`
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
