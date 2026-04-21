/**
 * Debug: find the 17 records where oilProd === oilCum and understand why.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dispatchParser } from '../src/parsers/index.js';

const WORKSPACE = path.resolve(__dirname, '..', '..');

async function main() {
  const full = path.join(WORKSPACE, 'PDSWDX-MP-XTO-MONTHLY.pdf');
  const buffer = fs.readFileSync(full);
  const outcome = await dispatchParser(
    { filename: 'PDSWDX-MP-XTO-MONTHLY.pdf', mimeType: 'application/pdf', data: buffer } as any,
    'test@example.com'
  );
  if (outcome.kind !== 'parsed') {
    console.log('Parse failed:', outcome);
    return;
  }
  console.log(`Total records: ${outcome.records.length}`);
  const leaky = outcome.records.filter((r) => {
    const cum = (r.extraFields as any)?.oilCum;
    return cum != null && r.oilProd != null && Math.abs(r.oilProd - cum) < 0.01;
  });
  console.log(`\nRecords with oilProd===oilCum (${leaky.length}):`);
  for (const r of leaky.slice(0, 20)) {
    console.log(
      `  ${r.wellName} | ${r.prodDate} | oilProd=${r.oilProd} oilSales=${r.oilSales} oilCum=${(r.extraFields as any)?.oilCum} gasProd=${r.gasProd} gasSales=${r.gasSales} gasCum=${(r.extraFields as any)?.gasCum} waterProd=${r.waterProd} wellStatus="${(r.extraFields as any)?.wellStatus}"`
    );
  }

  console.log(`\nFirst 5 records for PERLA VERDE 31 STATE 001H (for contrast):`);
  const perla = outcome.records
    .filter((r) => r.wellName === 'PERLA VERDE 31 STATE 001H')
    .slice(0, 5);
  for (const r of perla) {
    console.log(
      `  ${r.prodDate} | oilProd=${r.oilProd} oilSales=${r.oilSales} oilCum=${(r.extraFields as any)?.oilCum} gasProd=${r.gasProd} gasCum=${(r.extraFields as any)?.gasCum}`
    );
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
