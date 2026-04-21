/**
 * Proof-of-concept for the data-driven structured engine.
 *
 * Strategy:
 *   1. Define an Aftermath mapping as a JSON config (what the Mapping UI
 *      will save to format_mappings.mapping_config).
 *   2. Run the same Aftermath sample CSV through:
 *        a. The hand-written parseAftermathCsv()
 *        b. The data-driven runStructuredEngine() with the JSON config
 *   3. Assert the record counts match and the core volumes per row match.
 *
 * This proves the engine can replicate a known-good hand-written parser
 * purely from configuration — which is the whole point of Task #79.
 *
 * Run with:  npx tsx api/scripts/test-data-driven-aftermath.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseAftermathCsv } from '../src/parsers/aftermathDailiesCsv.js';
import { runStructuredEngine } from '../src/parsers/dataDriven/structuredEngine.js';
import type { StructuredMappingConfig } from '../src/parsers/dataDriven/schema.js';
import { SCHEMA_VERSION } from '../src/parsers/dataDriven/schema.js';

/** The Aftermath mapping, authored as pure data. This is the EXACT shape a
 *  future Mapping UI form will serialize into `format_mappings.mapping_config`. */
const aftermathConfig: StructuredMappingConfig = {
  kind: 'structured',
  schemaVersion: SCHEMA_VERSION,
  fileKind: 'csv',
  dataType: 'daily',
  headerRow: 1,
  columnMappings: {
    wellName: { matchType: 'header', headers: ['WELL NAME'] },
    api: { matchType: 'header', headers: ['API'] },
    prodDate: { matchType: 'header', headers: ['PRODDATE'] },
    oilProd: { matchType: 'header', headers: ['OIL PROD'] },
    oilSales: { matchType: 'header', headers: ['OIL SALES'] },
    gasProd: { matchType: 'header', headers: ['GAS PROD'] },
    gasSales: { matchType: 'header', headers: ['GAS SALES'] },
    waterProd: { matchType: 'header', headers: ['WATER PROD'] },
    tubingPres: { matchType: 'header', headers: ['TUBING PRESSURE'] },
    casingPres: { matchType: 'header', headers: ['CASING PRESSURE'] },
    operatorWellId: {
      matchType: 'header',
      headers: ['WELL ID'],
      transform: 'scientific-notation-int',
    },
  },
  extraFieldsCapture: {
    bhp: { matchType: 'header', headers: ['BOTTOMHOLE PRESSURE'], transform: 'number' },
    aftermathCompletionNoRaw: { matchType: 'header', headers: ['COMPLETION NO'], transform: 'text' },
  },
  conventions: {
    dateFormat: 'M/D/YYYY',
    apiSource: 'api10',
    apiFormat: 'digits-only',
  },
};

function fail(msg: string): never {
  console.error('FAIL —', msg);
  process.exit(1);
}

async function main() {
  const sample = path.resolve(__dirname, '..', '..', '2026.04.07 Aftermath Dailies.csv');
  if (!fs.existsSync(sample)) fail(`sample file not found at ${sample}`);

  const buf = fs.readFileSync(sample);

  // 1. Hand-written parser (truth).
  const handRecords = parseAftermathCsv(buf.toString('utf-8'));
  console.log(`[hand-written] parsed ${handRecords.length} records`);

  // 2. Data-driven engine (test target).
  const engineRecords = runStructuredEngine(buf, aftermathConfig);
  console.log(`[data-driven] parsed ${engineRecords.length} records`);

  // 3. Compare counts.
  if (handRecords.length !== engineRecords.length) {
    fail(`record count mismatch: hand=${handRecords.length} engine=${engineRecords.length}`);
  }

  // 4. Spot-check core fields across a sample of rows. We don't demand
  //    byte-exact extraFields parity (hand-written saves a few audit keys
  //    the generic engine doesn't), just the 16 template columns.
  const keysToCompare: Array<keyof (typeof handRecords)[0]> = [
    'api10',
    'api14',
    'wellName',
    'prodDate',
    'oilProd',
    'oilSales',
    'gasProd',
    'gasSales',
    'waterProd',
    'tubingPres',
    'casingPres',
  ];

  let mismatches = 0;
  for (let i = 0; i < handRecords.length; i++) {
    const a = handRecords[i];
    const b = engineRecords[i];
    for (const k of keysToCompare) {
      if (a[k] !== b[k]) {
        if (mismatches < 5) {
          console.error(`  row ${i} field "${String(k)}": hand=${JSON.stringify(a[k])} engine=${JSON.stringify(b[k])}`);
        }
        mismatches++;
      }
    }
  }

  if (mismatches > 0) {
    fail(`${mismatches} field mismatches across ${handRecords.length} rows`);
  }

  // 5. Sanity-check the BHP extra field rides through the engine.
  const firstWithBhp = engineRecords.find((r) => r.extraFields.bhp !== null);
  if (firstWithBhp) {
    console.log(`[data-driven] BHP extra field captured on row — example: ${JSON.stringify(firstWithBhp.extraFields.bhp)}`);
  }

  console.log(`PASS — data-driven engine matched hand-written parser across ${handRecords.length} rows and ${keysToCompare.length} fields each.`);
}

main().catch((err) => {
  console.error('UNEXPECTED ERROR:', err);
  process.exit(1);
});
