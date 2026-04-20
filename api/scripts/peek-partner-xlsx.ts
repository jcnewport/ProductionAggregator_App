/**
 * Peek at every "partner report"-style XLSX to see if they share enough
 * structure that ONE generic XLSX adapter can cover all of them (same
 * approach used for the Generic Production CSV adapter).
 *
 * Prints sheet names + first 5 rows of each sheet.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as XLSX from 'xlsx';

const DIR = join(__dirname, '..', '..');

const files = [
  '2026.03.30 Arlo Production.xlsx',
  '2026.03.03 Tap Rock Partner Report Feb 2026.xlsx',
  '2026.04.03 Tap Rock Partner Report Mar 2026.xlsx',
  'PARTNER REPORT - WEST PECOS.xlsx',
  'pinonPartnerReport.nopag.xlsx',
];

for (const f of files) {
  try {
    const buf = readFileSync(join(DIR, f));
    const wb = XLSX.read(buf, { type: 'buffer' });
    console.log(`\n════════ ${f} ════════`);
    console.log(`Sheets: ${wb.SheetNames.join(', ')}`);
    for (const sn of wb.SheetNames) {
      const sheet = wb.Sheets[sn];
      const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' });
      console.log(`  ── Sheet "${sn}" (${rows.length} rows) ──`);
      for (let i = 0; i < Math.min(rows.length, 6); i++) {
        const cells = (rows[i] as unknown[]).map((c) =>
          typeof c === 'string' ? c.substring(0, 30) : c
        );
        console.log(`    [${i}] ${JSON.stringify(cells)}`);
      }
    }
  } catch (err) {
    console.log(`[SKIP] ${f}: ${err instanceof Error ? err.message : err}`);
  }
}
