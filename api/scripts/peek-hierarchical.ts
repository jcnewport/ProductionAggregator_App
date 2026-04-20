/**
 * Deep peek at hierarchical partner-report XLSX files to see:
 *   - how well-boundary transitions look (well row → date rows → next well row)
 *   - what appears at the bottom of the sheet (grand total? blank? footer?)
 *   - column shape consistency across Tap Rock Feb / Tap Rock Mar / West Pecos / Monthly Report
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as XLSX from 'xlsx';

const DIR = join(__dirname, '..', '..');

const files = [
  '2026.03.03 Tap Rock Partner Report Feb 2026.xlsx',
  '2026.04.03 Tap Rock Partner Report Mar 2026.xlsx',
  'PARTNER REPORT - WEST PECOS.xlsx',
  'Monthly Report.xlsx',
];

for (const f of files) {
  const buf = readFileSync(join(DIR, f));
  const wb = XLSX.read(buf, { type: 'buffer' });
  const sn = wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sn], { header: 1, defval: '' });
  console.log(`\n════════ ${f}  (sheet "${sn}", ${rows.length} rows) ════════`);
  // Print row 0 + 1 (headers), first 3 data rows after a well block boundary,
  // and last 5 rows.
  const samplePoints = [
    0, 1, 2, 3, 4, 5, 28, 29, 30, 31, 32, 60, 61, 62, 63,
    rows.length - 3, rows.length - 2, rows.length - 1,
  ];
  const seen = new Set<number>();
  for (const idx of samplePoints) {
    if (idx < 0 || idx >= rows.length || seen.has(idx)) continue;
    seen.add(idx);
    const r = (rows[idx] as unknown[]).map((c) => {
      if (typeof c === 'string') return c.length > 30 ? c.substring(0, 30) + '…' : c;
      return c;
    });
    console.log(`  [${idx}] ${JSON.stringify(r)}`);
  }
}
