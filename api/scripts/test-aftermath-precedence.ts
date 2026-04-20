/**
 * Make sure the generic CSV adapter does NOT steal the Aftermath CSV —
 * Aftermath's strict detector must win first because it produces richer
 * extraFields (raw scientific-notation IDs + bottomhole pressure).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dispatchParser } from '../src/parsers/index.js';

const f = '2026.04.07 Aftermath Dailies.csv';
const full = path.resolve(__dirname, '..', '..', f);
const buffer = fs.readFileSync(full);

async function main() {
  const outcome = await dispatchParser(
    { filename: f, mimeType: 'text/csv', data: buffer } as any,
    'test@example.com'
  );

  if (outcome.kind !== 'parsed') {
    console.error('FAIL — expected parsed outcome, got:', outcome.kind);
    process.exit(1);
  }
  if (outcome.formatName !== 'Aftermath Dailies CSV') {
    console.error(`FAIL — Aftermath file was routed to "${outcome.formatName}", not to "Aftermath Dailies CSV".`);
    process.exit(1);
  }
  console.log(`PASS — Aftermath file routed to "${outcome.formatName}" with ${outcome.records.length} records (dataType=${outcome.dataType}).`);
}
main();
