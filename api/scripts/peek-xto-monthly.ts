/**
 * Diagnostic: dump the pdf-parse text for PDSWDX-MP-XTO-MONTHLY.pdf
 * so we can discover the column layout before wiring a parser.
 *
 * Mirrors peek-eog-monthly.ts. We want to confirm:
 *   - visual column order (what the headers are called, x-coordinates)
 *   - which columns are cumulative (OilCum, GasCum) — we MUST exclude them
 *   - whether GasInj / Producing Status / Pressure Base / Well Status
 *     arrive as header cells we can match on
 *   - whether flat text or positional extraction is required
 *   - row y-spacing so we can pick the right bucket size (EOG needed 4 pt)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import pdfParse from 'pdf-parse';

const WORKSPACE = path.resolve(__dirname, '..', '..');
const FILE = 'PDSWDX-MP-XTO-MONTHLY.pdf';

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
  console.log('\n--- DEFAULT TEXT (first 80 lines) ---');
  defaultParsed.text.split(/\r?\n/).slice(0, 80).forEach((l, i) =>
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
    .slice(0, 30)
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
