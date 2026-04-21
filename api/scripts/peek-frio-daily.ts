import * as XLSX from 'xlsx';
import * as fs from 'node:fs';
import * as path from 'node:path';

const filePath = path.resolve(__dirname, '..', '..', 'Frio_Daily_Production.xlsx');
const wb = XLSX.read(fs.readFileSync(filePath));
console.log('Sheet names:', wb.SheetNames);
for (const name of wb.SheetNames) {
  const sheet = wb.Sheets[name];
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, raw: true }) as any[][];
  console.log(`\n── Sheet: "${name}" — ${aoa.length} rows ──`);
  const ref = sheet['!ref'];
  console.log(`  !ref: ${ref}`);
  const merged = sheet['!merges'];
  if (merged && merged.length) console.log(`  merges: ${merged.length}`);
  for (let i = 0; i < Math.min(30, aoa.length); i++) {
    console.log(`  [${i}]`, JSON.stringify(aoa[i]?.slice(0, 30)));
  }
  if (aoa.length > 30) {
    console.log(`  ...${aoa.length - 30} more rows...`);
    for (let i = Math.max(30, aoa.length - 5); i < aoa.length; i++) {
      console.log(`  [${i}]`, JSON.stringify(aoa[i]?.slice(0, 30)));
    }
  }
}
