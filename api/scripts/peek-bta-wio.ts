/**
 * Diagnostic: dump the pdf-parse text for the BTA WIO Mailout PDF.
 * We need to see exactly how pdf-parse breaks up the tabular text —
 * the project notes warned the header row fragments across lines.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import pdfParse from 'pdf-parse';

const WORKSPACE = path.resolve(__dirname, '..', '..');
const FILE = 'February 2026 West Pecos Trading WIO Mailout.pdf';

async function main() {
  const full = path.join(WORKSPACE, FILE);
  if (!fs.existsSync(full)) {
    console.error(`Not found: ${full}`);
    process.exit(1);
  }
  const buf = fs.readFileSync(full);
  const parsed = await pdfParse(buf);
  const text = parsed.text;
  console.log(`=== ${FILE} ===`);
  console.log(`Pages: ${parsed.numpages}`);
  console.log(`Text length: ${text.length} chars`);
  console.log('--- FULL TEXT (line-numbered) ---');
  const lines = text.split(/\r?\n/);
  lines.forEach((l, i) => {
    console.log(`${String(i).padStart(3)}: "${l}"`);
  });
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
