/**
 * Smoke test for Format 11 — Frio Daily Production XLSX adapter.
 *
 * Runs the real Frio_Daily_Production.xlsx sample through the full
 * dispatcher path (so the detect() wiring is tested too, not just the
 * parser internals) and prints shape statistics.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dispatchParser } from '../src/parsers/index.js';

const WORKSPACE = path.resolve(__dirname, '..', '..');

async function main() {
  const file = 'Frio_Daily_Production.xlsx';
  const full = path.join(WORKSPACE, file);
  if (!fs.existsSync(full)) {
    console.log(`[FAIL] sample file not found at ${full}`);
    process.exit(1);
  }

  const buffer = fs.readFileSync(full);
  const outcome = await dispatchParser(
    {
      filename: file,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      data: buffer,
    } as any,
    'test@example.com'
  );

  if (outcome.kind !== 'parsed') {
    console.log(`[FAIL] outcome.kind=${outcome.kind}`);
    if (outcome.kind === 'error') console.log(`       ${outcome.message}`);
    if (outcome.kind === 'unrecognized') console.log(`       ${outcome.reason}`);
    if (outcome.kind === 'ignored')
      console.log(`       category=${outcome.category} filter=${outcome.filterName}`);
    process.exit(1);
  }

  if (outcome.formatName !== 'Frio Daily Production XLSX') {
    console.log(
      `[FAIL] routed to "${outcome.formatName}", expected "Frio Daily Production XLSX"`
    );
    process.exit(1);
  }

  const records = outcome.records;
  const uniqueWells = new Set(records.map((r) => r.wellName));
  const uniqueDates = new Set(records.map((r) => r.prodDate));
  const missingApi = records.filter((r) => !r.api10).length;
  const hasOilProd = records.filter((r) => r.oilProd != null).length;
  const hasGasProd = records.filter((r) => r.gasProd != null).length;
  const hasWaterProd = records.filter((r) => r.waterProd != null).length;
  const hasGasFlare = records.filter(
    (r) => r.extraFields && typeof r.extraFields.gasFlare === 'number'
  ).length;
  const fieldnames = new Set(
    records
      .map((r) => (r.extraFields && typeof r.extraFields.fieldname === 'string' ? r.extraFields.fieldname : null))
      .filter((v) => v != null)
  );

  console.log(
    `[PASS] ${file}\n` +
      `       records   : ${records.length}\n` +
      `       wells     : ${uniqueWells.size}\n` +
      `       dates     : ${Array.from(uniqueDates).sort().join(', ')}\n` +
      `       fieldnames: ${Array.from(fieldnames).join(', ') || '(none)'}\n` +
      `       dataType  : ${outcome.dataType}\n` +
      `       operator  : ${outcome.operatorName}\n` +
      `       missingApi: ${missingApi}/${records.length} (expected ALL — no API column)\n` +
      `       oilProd   : ${hasOilProd}/${records.length}\n` +
      `       gasProd   : ${hasGasProd}/${records.length}\n` +
      `       waterProd : ${hasWaterProd}/${records.length}\n` +
      `       gasFlare  : ${hasGasFlare}/${records.length} (extraFields)`
  );

  // Spot-check a few records
  const first = records[0];
  const last = records[records.length - 1];
  console.log(
    `       first     : well="${first.wellName}" date=${first.prodDate} ` +
      `oil=${first.oilProd} gas=${first.gasProd} water=${first.waterProd} ` +
      `flare=${first.extraFields?.gasFlare}`
  );
  console.log(
    `       last      : well="${last.wellName}" date=${last.prodDate} ` +
      `oil=${last.oilProd} gas=${last.gasProd} water=${last.waterProd} ` +
      `flare=${last.extraFields?.gasFlare}`
  );

  // ── Sanity assertions ──
  let failures = 0;
  if (missingApi !== records.length) {
    console.log(
      `[CHECK-FAIL] expected ALL records to have empty API (no API column in this format), ` +
        `but ${records.length - missingApi} have a non-empty api10`
    );
    failures++;
  }
  if (records.length < 150) {
    console.log(
      `[CHECK-FAIL] expected ≥150 records (sample has 159 wells) — got ${records.length}`
    );
    failures++;
  }
  if (outcome.dataType !== 'daily') {
    console.log(`[CHECK-FAIL] expected dataType='daily', got '${outcome.dataType}'`);
    failures++;
  }
  if (!uniqueDates.has('2026-03-31')) {
    console.log(
      `[CHECK-FAIL] expected '2026-03-31' in dates (sample Production Date = 46112), ` +
        `got ${Array.from(uniqueDates).join(',')}`
    );
    failures++;
  }
  if (!fieldnames.has('NORTH HARPOON')) {
    console.log(
      `[CHECK-FAIL] expected fieldname 'NORTH HARPOON' in extraFields, ` +
        `got ${Array.from(fieldnames).join(',')}`
    );
    failures++;
  }

  if (failures > 0) {
    console.log(`\n── ${failures} assertion(s) failed ──`);
    process.exit(1);
  }
  console.log(`\n── All assertions passed ──`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
