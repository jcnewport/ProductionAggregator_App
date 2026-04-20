/**
 * Diagnostic: peek at BTA "March 2026 Daily Production.xlsx"
 * Prints each sheet name, dimensions, and the first ~8 rows as arrays-of-arrays.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as XLSX from 'xlsx';

const WORKSPACE = path.resolve(__dirname, '..', '..');
const FILE = 'March 2026 Daily Production.xlsx';
const full = path.join(WORKSPACE, FILE);

if (!fs.existsSync(full)) {
  console.error(`File not found: ${full}`);
  process.exit(1);
}

const wb = XLSX.read(fs.readFileSync(full), { type: 'buffer' });
console.log(`\n=== ${FILE} ===`);
console.log(`Sheets: ${wb.SheetNames.length}`);
console.log(`Names:  ${JSON.stringify(wb.SheetNames)}\n`);

for (const name of wb.SheetNames) {
  const ws = wb.Sheets[name];
  const aoa = XLSX.utils.sheet_to_json(ws, {
    header: 1,
    blankrows: false,
    defval: null,
  }) as any[][];
  console.log(`--- Sheet: "${name}" (rows=${aoa.length}) ---`);
  const preview = aoa.slice(0, 8);
  preview.forEach((row, i) => {
    console.log(`  [${i}] ${JSON.stringify(row)}`);
  });
  if (aoa.length > 8) {
    console.log(`  ... (${aoa.length - 8} more rows)`);
    console.log(`  [last] ${JSON.stringify(aoa[aoa.length - 1])}`);
  }
  console.log('');
}
