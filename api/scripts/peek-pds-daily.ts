/**
 * Peek at text extracted from each PDS Daily PDF so we can write tight
 * stub detectors. Prints first 1200 chars of each.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pdfParse from 'pdf-parse';

const DIR = join(__dirname, '..', '..');

const files = [
  'PDSWDX-DP-Anadarko- DAILY.pdf',
  'PDSWDX-DP-EOG-DAILY.pdf',
  'PDSWDX-DP-XTO-DAILY.pdf',
  'PDSWDX-DP-mewbourne-DAILY.pdf',
  'PDSWDX-DP-conocophillips-DAILY.pdf',
];

async function main() {
  for (const f of files) {
    try {
      const buf = readFileSync(join(DIR, f));
      const r = await pdfParse(buf);
      console.log(`\n════════ ${f} ════════`);
      console.log(r.text.slice(0, 1200));
    } catch (err) {
      console.log(`[SKIP] ${f}: ${err instanceof Error ? err.message : err}`);
    }
  }
}
main();
