/**
 * Diagnostic: dump the pdf-parse text for the EOG Monthly PDF (both
 * default flat text and item-level positions) so we can discover the
 * text-stream structure. Anadarko's stream is 3-lines-per-record; EOG's
 * layout may differ because the visual columns are ordered differently
 * (Well Name BEFORE Well ID, per project spec).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import pdfParse from 'pdf-parse';

const WORKSPACE = path.resolve(__dirname, '..', '..');
const FILE = 'PDSWDX-MP-EOG-MONTHLY.pdf';

async function main() {
  const full = path.join(WORKSPACE, FILE);
  if (!fs.existsSync(full)) {
    console.error(`Not found: ${full}`);
    process.exit(1);
  }
  const buf = fs.readFileSync(full);

  // 1) Default pdf-parse text
  const defaultParsed = await pdfParse(buf);
  console.log(`=== ${FILE} ===  pages=${defaultParsed.numpages}  text=${defaultParsed.text.length} chars`);
  console.log('\n--- DEFAULT TEXT (first 60 lines) ---');
  defaultParsed.text.split(/\r?\n/).slice(0, 60).forEach((l, i) =>
    console.log(`${String(i).padStart(3)}: "${l}"`)
  );

  // 2) Positional items on first page for deeper inspection
  async function pagerender(pageData: any): Promise<string> {
    const content = await pageData.getTextContent({
      normalizeWhitespace: false,
      disableCombineTextItems: false,
    });
    const lines: string[] = [];
    for (const it of content.items as any[]) {
      const x = it.transform[4];
      const y = it.transform[5];
      const s = String(it.str).replace(/[\t\n\r]/g, ' ');
      lines.push(`${x.toFixed(1)}\t${y.toFixed(1)}\t${s}`);
    }
    return lines.join('\n');
  }
  const posParsed = await pdfParse(buf, { pagerender, max: 1 });
  const items = posParsed.text
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const p = l.split('\t');
      return { x: Number(p[0]), y: Number(p[1]), str: p.slice(2).join('\t') };
    });

  console.log(`\n--- POSITIONAL ITEMS, PAGE 1 (${items.length} items) ---`);
  const byLine = new Map<number, typeof items>();
  for (const it of items) {
    const key = Math.round(it.y / 2) * 2;
    if (!byLine.has(key)) byLine.set(key, []);
    byLine.get(key)!.push(it);
  }
  Array.from(byLine.keys())
    .sort((a, b) => b - a)
    .slice(0, 25)
    .forEach((y) => {
      const row = byLine.get(y)!.sort((a, b) => a.x - b.x);
      const pretty = row
        .map((i) => `[x=${i.x.toFixed(1)}]"${i.str}"`)
        .join(' | ');
      console.log(`y=${y.toFixed(1)}: ${pretty}`);
    });
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
