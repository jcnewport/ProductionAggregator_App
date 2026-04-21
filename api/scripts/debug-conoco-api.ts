/**
 * Debug: check what API widths we're seeing across the 143-page sample.
 * If some are 13+ digits, api10+"0000" won't equal api14 (api14 keeps
 * the extra middle digits). The test needs to assert a looser invariant:
 * api14 starts with api10.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dispatchParser } from '../src/parsers/index.js';

const WORKSPACE = path.resolve(__dirname, '..', '..');

async function main() {
  const full = path.join(WORKSPACE, 'PDSWDX-DP-conocophillips-DAILY.pdf');
  const buffer = fs.readFileSync(full);
  const outcome = await dispatchParser(
    {
      filename: 'PDSWDX-DP-conocophillips-DAILY.pdf',
      mimeType: 'application/pdf',
      data: buffer,
    } as any,
    'test@example.com'
  );
  if (outcome.kind !== 'parsed') {
    console.log('Parse failed:', outcome);
    return;
  }
  console.log(`Total records: ${outcome.records.length}`);
  const byRawLen = new Map<number, number>();
  for (const r of outcome.records) {
    const raw = (r.extraFields as any)?.rawApi as string | null;
    const len = raw ? raw.length : -1;
    byRawLen.set(len, (byRawLen.get(len) ?? 0) + 1);
  }
  console.log('\nRaw API length distribution:');
  for (const [len, count] of [...byRawLen.entries()].sort()) {
    console.log(`  ${len} digits: ${count} records`);
  }

  // Check unique api14 prefixes (first 10 chars) vs api10
  const mismatches = outcome.records.filter((r) => r.api14.slice(0, 10) !== r.api10);
  console.log(`\nRecords where api14 does NOT start with api10: ${mismatches.length}`);
  if (mismatches.length > 0) {
    for (const m of mismatches.slice(0, 5)) {
      console.log(
        `  well=${m.wellName} api10=${m.api10} api14=${m.api14} rawApi=${(m.extraFields as any)?.rawApi}`
      );
    }
  }

  // Show a sample of each raw-length bucket
  console.log('\nSample records for each raw-API length:');
  const shown = new Set<number>();
  for (const r of outcome.records) {
    const raw = (r.extraFields as any)?.rawApi as string | null;
    const len = raw ? raw.length : -1;
    if (shown.has(len)) continue;
    shown.add(len);
    console.log(
      `  [len=${len}] well="${r.wellName}" api10=${r.api10} api14=${r.api14} rawApi=${raw}`
    );
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
