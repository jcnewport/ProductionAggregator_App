/**
 * Smoke test for the non-production filter pass.
 * -----------------------------------------------
 * Two guarantees we want to lock in:
 *   1. Known-non-production files are RECOGNIZED and return outcome.kind === 'ignored'.
 *      • West Pecos tracking catalog → "tracking spreadsheet"
 *      • ComboCurve export sample    → "template/sample file"
 *      • test-export.xlsx            → "test/sample file"
 *   2. Real operator production files still parse normally (we must NOT
 *      over-match and swallow legitimate data). We spot-check 3 formats
 *      that could plausibly trip a loose filter rule.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dispatchParser } from '../src/parsers/index.js';

const WORKSPACE = path.resolve(__dirname, '..', '..');

interface IgnoreCase {
  file: string;
  expectedFilter: string;
  expectedCategory: string;
}

interface ProdCase {
  file: string;
  /** If set, we assert the outcome is 'parsed' and routed to this format name. */
  expectedFormat: string;
}

const ignoreCases: IgnoreCase[] = [
  {
    file: 'West Pecos Production Data Sources and Tracking.xlsx',
    expectedFilter: 'west-pecos-tracking-catalog',
    expectedCategory: 'tracking spreadsheet',
  },
  {
    file: 'ComboCurve_export_sample.xlsx',
    expectedFilter: 'combocurve-template-sample',
    expectedCategory: 'template/sample file',
  },
  {
    file: 'test-export.xlsx',
    expectedFilter: 'our-own-test-export',
    expectedCategory: 'test/sample file',
  },
];

// Real operator files that must NOT be mis-classified as non-production.
const prodCases: ProdCase[] = [
  {
    file: '2026.04.03 Tap Rock Partner Report Mar 2026.xlsx',
    // Tap Rock partner reports are parsed by the hierarchical allocated XLSX
    // adapter in the current registry (shared layout family).
    expectedFormat: 'Hierarchical Allocated Production XLSX',
  },
  {
    file: 'March 2026 Daily Production.xlsx',
    expectedFormat: 'BTA Daily Per-Well Sheets',
  },
  {
    file: 'Monthly Report.xlsx',
    expectedFormat: 'Hierarchical Allocated Production XLSX',
  },
];

function mimeFor(file: string): string {
  if (/\.xlsx$/i.test(file))
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (/\.xls$/i.test(file)) return 'application/vnd.ms-excel';
  if (/\.csv$/i.test(file)) return 'text/csv';
  if (/\.pdf$/i.test(file)) return 'application/pdf';
  return 'application/octet-stream';
}

async function main() {
  let pass = 0;
  let fail = 0;

  console.log('── Group 1: non-production files must be IGNORED ──');
  for (const c of ignoreCases) {
    const full = path.join(WORKSPACE, c.file);
    if (!fs.existsSync(full)) {
      console.log(`[SKIP] ${c.file}: file not found`);
      continue;
    }
    const buffer = fs.readFileSync(full);
    const outcome = await dispatchParser(
      { filename: c.file, mimeType: mimeFor(c.file), data: buffer } as any,
      'test@example.com'
    );

    if (outcome.kind !== 'ignored') {
      console.log(
        `[FAIL] ${c.file}: expected kind="ignored" but got "${outcome.kind}"`
      );
      if (outcome.kind === 'error') console.log(`       error: ${outcome.message}`);
      if (outcome.kind === 'unrecognized') console.log(`       reason: ${outcome.reason}`);
      if (outcome.kind === 'parsed')
        console.log(
          `       (!!!) dangerously routed to parser "${outcome.formatName}" with ${outcome.records.length} records — ` +
            `the filter must catch this BEFORE adapters run.`
        );
      fail++;
      continue;
    }
    if (outcome.filterName !== c.expectedFilter) {
      console.log(
        `[FAIL] ${c.file}: ignored by "${outcome.filterName}", expected "${c.expectedFilter}"`
      );
      fail++;
      continue;
    }
    if (outcome.category !== c.expectedCategory) {
      console.log(
        `[FAIL] ${c.file}: category="${outcome.category}", expected "${c.expectedCategory}"`
      );
      fail++;
      continue;
    }
    console.log(
      `[PASS] ${c.file}  filter=${outcome.filterName}  category="${outcome.category}"`
    );
    console.log(`       reason: ${outcome.reason}`);
    pass++;
  }

  console.log('\n── Group 2: real operator files must still PARSE ──');
  for (const c of prodCases) {
    const full = path.join(WORKSPACE, c.file);
    if (!fs.existsSync(full)) {
      console.log(`[SKIP] ${c.file}: file not found`);
      continue;
    }
    const buffer = fs.readFileSync(full);
    const outcome = await dispatchParser(
      { filename: c.file, mimeType: mimeFor(c.file), data: buffer } as any,
      'test@example.com'
    );

    if (outcome.kind === 'ignored') {
      console.log(
        `[FAIL] ${c.file}: real production file was incorrectly IGNORED by filter "${outcome.filterName}" (${outcome.category}). ` +
          `The filter signature is too loose.`
      );
      fail++;
      continue;
    }
    if (outcome.kind !== 'parsed') {
      console.log(`[FAIL] ${c.file}: expected kind="parsed" but got "${outcome.kind}"`);
      if (outcome.kind === 'error') console.log(`       ${outcome.message}`);
      if (outcome.kind === 'unrecognized') console.log(`       ${outcome.reason}`);
      fail++;
      continue;
    }
    if (outcome.formatName !== c.expectedFormat) {
      console.log(
        `[FAIL] ${c.file}: routed to "${outcome.formatName}", expected "${c.expectedFormat}"`
      );
      fail++;
      continue;
    }
    console.log(
      `[PASS] ${c.file}  format="${outcome.formatName}"  records=${outcome.records.length}`
    );
    pass++;
  }

  console.log(`\n── Summary: ${pass} passed, ${fail} failed ──`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
