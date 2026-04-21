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
  {
    // ComboCurve well-header export from Frio Energy — filename matches the
    // distinctive `well_<project>_<14-digit-timestamp>.csv` pattern AND the
    // first row has "Well Name", "API 14", "Chosen ID" (double-locked signature).
    file: 'well_Frio_Energy_Holdings_I__EPK_Capital_Database_20260420043844.csv',
    expectedFilter: 'combocurve-well-catalog',
    expectedCategory: 'well catalog / reference export',
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

  console.log('── Group 0: synthetic inline-image attachment must be IGNORED ──');
  // We don't need a real image on disk — the filter keys off fileKind='image',
  // and detectFileKind() decides from mime/extension alone. A zero-byte buffer
  // with the right filename + mime is enough to exercise the full dispatch path.
  {
    const imgOutcome = await dispatchParser(
      {
        filename: 'Outlook-zqz425aa.png',
        mimeType: 'image/png',
        data: Buffer.alloc(0),
      } as any,
      'someone@outlook.com'
    );
    if (imgOutcome.kind === 'ignored' && imgOutcome.filterName === 'inline-image-attachment') {
      console.log(
        `[PASS] Outlook-zqz425aa.png  filter=${imgOutcome.filterName}  category="${imgOutcome.category}"`
      );
      console.log(`       reason: ${imgOutcome.reason}`);
      pass++;
    } else {
      console.log(
        `[FAIL] Outlook-zqz425aa.png: expected filter=inline-image-attachment, got kind=${imgOutcome.kind}`
      );
      if (imgOutcome.kind === 'ignored') console.log(`       filter=${imgOutcome.filterName}`);
      fail++;
    }
  }

  console.log('\n── Group 1: non-production files must be IGNORED ──');
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

  // ──────────────────────────────────────────────────────────────
  // Group 3 (Task #61, 2026-04-21) — synthetic production CSVs that
  // carry the Well Name + API 14 + Chosen ID identity triplet but ARE
  // production data. Before Task #61 these were silently misclassified
  // as "ComboCurve well-header export" by the catalog filter. The
  // tightened Rule 2 (requires ≥2 catalog-only columns AND no volume
  // columns) must let these flow through to the Generic Production CSV
  // adapter.
  // ──────────────────────────────────────────────────────────────
  console.log(
    '\n── Group 3: synthetic production CSVs with Chosen ID must PARSE (not be caught by catalog filter) ──'
  );

  // Minimal EFG-Monthly-style CSV: the identity triplet that used to
  // trigger the old catalog Rule 2, PLUS real production-volume columns
  // that disqualify it as a catalog, AND a sprinkle of well-name values
  // the Generic CSV adapter will happily accept.
  const efgMonthlyCsv = Buffer.from(
    [
      'Well Name,API 14,Chosen ID,Prod Date,Oil Prod,Oil Sales,Gas Prod,Gas Sales,Water Prod',
      'EFG STATE 57-T2-42 1H,42389395160000,4238939516,2026-01-01,4521,4498,18432,17920,312',
      'EFG STATE 57-T2-42 2H,42389395170000,4238939517,2026-01-01,5122,5100,21084,20541,287',
      'EFG STATE 57-T2-42 1H,42389395160000,4238939516,2026-02-01,4019,3994,16210,15788,298',
    ].join('\n'),
    'utf-8'
  );

  // Ruthless-Dailies style CSV: daily granularity, Chosen ID present,
  // several volume columns.
  const ruthlessDailiesCsv = Buffer.from(
    [
      'Well Name,API 14,Chosen ID,Prod Date,Oil Prod,Gas Prod,Water Prod,Tubing Pressure,Casing Pressure',
      'RUTHLESS 11 FEDERAL COM 729H,30025511740000,3002551174,3/1/2026,152,1821,45,820,540',
      'RUTHLESS 11 FEDERAL COM 729H,30025511740000,3002551174,3/2/2026,148,1804,48,815,538',
      'RUTHLESS 11 FEDERAL COM 729H,30025511740000,3002551174,3/3/2026,151,1812,46,818,542',
    ].join('\n'),
    'utf-8'
  );

  // A file that HAS a partial catalog-style shape (one catalog-only column)
  // but ALSO a production-volume column. Must NOT be caught — the volume
  // column is the disqualifier, even though "INPT ID" is a catalog signal.
  const ambiguousWithVolumeCsv = Buffer.from(
    [
      'Well Name,API 14,Chosen ID,INPT ID,Prod Date,Oil Prod',
      'ARLO COUNTRY 45-09B 2DN,42115340770000,4211534077,INPTabcd123,2026-03-15,77',
    ].join('\n'),
    'utf-8'
  );

  const syntheticCases: Array<{
    filename: string;
    buffer: Buffer;
    expectedFormat: string;
    description: string;
  }> = [
    {
      filename: '2026.03.20 EFG Monthly Production.csv',
      buffer: efgMonthlyCsv,
      expectedFormat: 'Generic Production CSV',
      description:
        'EFG Monthly carries Well Name + API 14 + Chosen ID + volume columns — must parse',
    },
    {
      filename: '2026.04.07 Ruthless Dailies Production.csv',
      buffer: ruthlessDailiesCsv,
      expectedFormat: 'Generic Production CSV',
      description:
        'Ruthless Dailies carries Well Name + API 14 + Chosen ID + volume columns — must parse',
    },
    {
      filename: 'ambiguous-with-volume.csv',
      buffer: ambiguousWithVolumeCsv,
      expectedFormat: 'Generic Production CSV',
      description:
        'Volume column disqualifies catalog even when one catalog-only column (INPT ID) is present',
    },
  ];

  for (const c of syntheticCases) {
    const outcome = await dispatchParser(
      { filename: c.filename, mimeType: 'text/csv', data: c.buffer } as any,
      'test@example.com'
    );

    if (outcome.kind === 'ignored') {
      console.log(
        `[FAIL] ${c.filename}: incorrectly ignored by "${outcome.filterName}" (${outcome.category}). ` +
          `${c.description}`
      );
      console.log(`       reason: ${outcome.reason}`);
      fail++;
      continue;
    }
    if (outcome.kind !== 'parsed') {
      console.log(
        `[FAIL] ${c.filename}: expected kind="parsed" but got "${outcome.kind}"`
      );
      if (outcome.kind === 'error') console.log(`       error: ${outcome.message}`);
      if (outcome.kind === 'unrecognized') console.log(`       reason: ${outcome.reason}`);
      fail++;
      continue;
    }
    if (outcome.formatName !== c.expectedFormat) {
      console.log(
        `[FAIL] ${c.filename}: routed to "${outcome.formatName}", expected "${c.expectedFormat}"`
      );
      fail++;
      continue;
    }
    console.log(
      `[PASS] ${c.filename}  format="${outcome.formatName}"  records=${outcome.records.length}`
    );
    console.log(`       — ${c.description}`);
    pass++;
  }

  // Synthetic inverse: a minimal "fake catalog" CSV with no filename match
  // but with the full identity triplet + several catalog-only columns and
  // NO production volumes. Rule 2 must still catch this.
  console.log(
    '\n── Group 4: synthetic catalog CSV (no filename match) must still be IGNORED by Rule 2 ──'
  );
  const syntheticCatalogCsv = Buffer.from(
    [
      'Well Name,API 14,Chosen ID,Chosen ID Key,INPT ID,Has Monthly Data,Scope',
      'EXAMPLE WELL 1H,42001000010000,4200100001,API_UWI,INPTabc1,True,Project',
    ].join('\n'),
    'utf-8'
  );
  {
    const outcome = await dispatchParser(
      {
        filename: 'some-reasonably-named.csv',
        mimeType: 'text/csv',
        data: syntheticCatalogCsv,
      } as any,
      'test@example.com'
    );
    if (outcome.kind === 'ignored' && outcome.filterName === 'combocurve-well-catalog') {
      console.log(
        `[PASS] synthetic catalog (no filename match)  filter=${outcome.filterName}  category="${outcome.category}"`
      );
      console.log(`       reason: ${outcome.reason}`);
      pass++;
    } else {
      console.log(
        `[FAIL] synthetic catalog (no filename match): expected filter=combocurve-well-catalog, got kind=${outcome.kind}`
      );
      if (outcome.kind === 'ignored') console.log(`       filter=${outcome.filterName}`);
      if (outcome.kind === 'parsed') console.log(`       routed to "${outcome.formatName}"`);
      fail++;
    }
  }

  console.log(`\n── Summary: ${pass} passed, ${fail} failed ──`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
