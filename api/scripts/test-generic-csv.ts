/**
 * Smoke-test the Generic Production CSV adapter against every real CSV
 * in the project folder. Reports parsed/skipped/drifted per file and an
 * overall summary.
 *
 * Run from api/ directory:
 *   npx tsx scripts/test-generic-csv.ts
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGenericProductionCsv } from '../src/parsers/genericProductionCsv.js';

// Project folder sits two dirs above api/scripts.
const PROJECT_DIR = join(__dirname, '..', '..');
const SKIP_FILES = new Set<string>([
  'ComboCurve_Prod_Template.csv',                                   // master template, not an intake
  'well_Frio_Energy_Holdings_I__EPK_Capital_Database_20260420043844.csv', // well mapping, not production
  '2026.04.07 Aftermath Dailies.csv',                               // handled by aftermath-specific adapter
  '2026.04.07 Aftermath Dailies (1).csv',                           // ditto
]);

const files = readdirSync(PROJECT_DIR)
  .filter((f) => f.toLowerCase().endsWith('.csv'))
  .filter((f) => !SKIP_FILES.has(f))
  .sort();

console.log(`── Generic CSV adapter smoke test ──\n`);
console.log(`Scanning ${files.length} files in ${PROJECT_DIR}\n`);

let ok = 0;
let failed = 0;
let totalParsed = 0;
let totalSkipped = 0;
let totalDriftRepaired = 0;
const perFile: Array<{
  file: string;
  parsed: number;
  skipped: number;
  drift: number;
  dataType: string;
  firstSkip?: string;
  error?: string;
}> = [];

for (const f of files) {
  const text = readFileSync(join(PROJECT_DIR, f), 'utf-8');
  try {
    const result = parseGenericProductionCsv(text, f);
    ok += 1;
    totalParsed += result.records.length;
    totalSkipped += result.stats.skipped.length;
    totalDriftRepaired += result.stats.driftRepaired;
    perFile.push({
      file: f,
      parsed: result.records.length,
      skipped: result.stats.skipped.length,
      drift: result.stats.driftRepaired,
      dataType: result.dataType,
      firstSkip: result.stats.skipped[0]?.reason,
    });
  } catch (err) {
    failed += 1;
    perFile.push({
      file: f,
      parsed: 0,
      skipped: 0,
      drift: 0,
      dataType: '?',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Print per-file rows aligned in columns.
const padR = (s: string, n: number) => s.padEnd(n).slice(0, n);
const padL = (s: string, n: number) => s.padStart(n);
console.log(
  `${padR('FILE', 60)}  ${padL('TYPE', 7)}  ${padL('PARSED', 7)}  ${padL('SKIP', 5)}  ${padL('DRIFT', 6)}  NOTES`
);
console.log('─'.repeat(120));
for (const p of perFile) {
  const notes = p.error
    ? `❌ ERROR: ${p.error.slice(0, 60)}`
    : p.firstSkip
      ? `first skip: ${p.firstSkip.slice(0, 50)}`
      : '';
  console.log(
    `${padR(p.file, 60)}  ${padL(p.dataType, 7)}  ${padL(String(p.parsed), 7)}  ${padL(String(p.skipped), 5)}  ${padL(String(p.drift), 6)}  ${notes}`
  );
}

console.log('\n── Summary ──');
console.log(`  Files attempted:           ${files.length}`);
console.log(`  Files parsed (at least 1 record): ${ok}`);
console.log(`  Files failed hard:         ${failed}`);
console.log(`  Total records produced:    ${totalParsed.toLocaleString()}`);
console.log(`  Total rows skipped:        ${totalSkipped.toLocaleString()}`);
console.log(`  Total rows drift-repaired: ${totalDriftRepaired.toLocaleString()}`);

// Exit non-zero if any file errored, so this can gate CI later.
process.exit(failed > 0 ? 1 : 0);
