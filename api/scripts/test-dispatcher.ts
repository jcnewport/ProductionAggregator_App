/**
 * Dispatcher smoke test — feeds every sample operator file through the registry
 * dispatcher and reports which adapter matched.
 *
 * Expected behavior:
 *   - Anadarko PDF     → PDS Anadarko Monthly (implemented, returns records)
 *   - EOG / Mewbourne / XTO / CoP / BTA WIO PDFs → corresponding stub (error with "not yet implemented")
 *   - Aftermath CSV    → Aftermath Dailies CSV stub
 *   - Arlo XLSX        → Arlo Partner Report stub
 *   - BTA Daily XLSX   → BTA Daily Per-Well Sheets stub
 *   - Monthly Report   → Hierarchical Monthly Report stub
 *   - ComboCurve template → unrecognized (it's not an operator report)
 *
 * This proves the dispatcher can route each of the 10 formats correctly without
 * implementing every parser yet.
 *
 * Run:  SUPABASE_URL=x SUPABASE_SERVICE_KEY=x npx tsx scripts/test-dispatcher.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { dispatchParser } from '../src/parsers/index.js';
import { formatInventory } from '../src/parsers/registry.js';

const WORKSPACE = path.resolve(__dirname, '..', '..');

// Map of sample files → expected format name (or 'unrecognized'/'error')
const CASES: Array<{ file: string; mime: string; expect: string }> = [
  { file: 'PDSWDX-MP-Anadarko-MONTHLY.pdf',                        mime: 'application/pdf',  expect: 'PDS Anadarko Monthly' },
  { file: 'PDSWDX-MP-EOG-MONTHLY.pdf',                              mime: 'application/pdf',  expect: 'PDS EOG Monthly' },
  { file: 'PDSWDX-MP-mewbourne-MONTHLY.pdf',                        mime: 'application/pdf',  expect: 'PDS Mewbourne Monthly' },
  { file: 'PDSWDX-MP-XTO-MONTHLY.pdf',                              mime: 'application/pdf',  expect: 'PDS XTO Monthly' },
  { file: 'PDSWDX-DP-conocophillips-DAILY.pdf',                     mime: 'application/pdf',  expect: 'PDS ConocoPhillips Daily' },
  { file: 'PDSWDX-DP-Anadarko- DAILY.pdf',                          mime: 'application/pdf',  expect: 'PDS Anadarko Daily' },
  { file: 'PDSWDX-DP-EOG-DAILY.pdf',                                mime: 'application/pdf',  expect: 'PDS EOG Daily' },
  { file: 'PDSWDX-DP-mewbourne-DAILY.pdf',                          mime: 'application/pdf',  expect: 'PDS Mewbourne Daily' },
  { file: 'PDSWDX-DP-XTO-DAILY.pdf',                                mime: 'application/pdf',  expect: 'PDS XTO Daily' },
  { file: 'February 2026 West Pecos Trading WIO Mailout.pdf',       mime: 'application/pdf',  expect: 'BTA WIO Mailout Monthly' },
  { file: '2026.04.07 Aftermath Dailies.csv',                       mime: 'text/csv',         expect: 'Aftermath Dailies CSV' },
  { file: '2026.03.30 Arlo Production.xlsx',                        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', expect: 'Arlo Partner Report XLSX' },
  { file: 'March 2026 Daily Production.xlsx',                       mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', expect: 'BTA Daily Per-Well Sheets' },
  { file: 'Monthly Report.xlsx',                                    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', expect: 'Hierarchical Allocated Production XLSX' },
  { file: 'Frio_Daily_Production.xlsx',                             mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', expect: 'Frio Daily Production XLSX' },
  // Negative case — not an operator report, should NOT match any adapter
  { file: 'ComboCurve_Prod_Template.csv',                           mime: 'text/csv',         expect: '(unrecognized)' },
];

async function main() {
  console.log('── Format Registry Inventory ──');
  for (const entry of formatInventory()) {
    console.log(`  ${entry.status.padEnd(12)} ${entry.name.padEnd(36)} (${entry.operator}, ${entry.dataType})`);
  }
  console.log('');
  console.log('── Dispatcher Smoke Test ──');

  let pass = 0;
  let fail = 0;

  for (const c of CASES) {
    const fullPath = path.join(WORKSPACE, c.file);
    if (!fs.existsSync(fullPath)) {
      console.log(`  [SKIP] ${c.file}  (file not found)`);
      continue;
    }
    const buffer = fs.readFileSync(fullPath);
    const attachment = {
      filename: c.file,
      mimeType: c.mime,
      data: buffer,
    } as any; // EmailAttachment shape

    const outcome = await dispatchParser(attachment, 'test@example.com');

    let got: string;
    if (outcome.kind === 'parsed') got = outcome.formatName;
    else if (outcome.kind === 'error') got = outcome.matchedFormatName ?? '(error, no match)';
    else got = '(unrecognized)';

    const ok = got === c.expect;
    if (ok) pass++; else fail++;
    const tag = ok ? 'PASS' : 'FAIL';

    console.log(`  [${tag}] ${c.file}`);
    console.log(`         expected: ${c.expect}`);
    console.log(`         got:      ${got}  (outcome.kind=${outcome.kind})`);
    if (outcome.kind === 'parsed') {
      console.log(`         records:  ${outcome.records.length}`);
    } else if (outcome.kind === 'error') {
      console.log(`         message:  ${outcome.message.substring(0, 120)}...`);
    } else if (outcome.kind === 'unrecognized') {
      console.log(`         reason:   ${outcome.reason.substring(0, 120)}...`);
    }
  }

  console.log(`\n── Summary: ${pass} passed, ${fail} failed ──`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
