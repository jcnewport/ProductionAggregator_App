/**
 * Diagnostic: dump BTA WIO Mailout text items with their x/y positions by
 * overriding pdf-parse's `pagerender` option. This lets us rebuild columns
 * from the underlying pdfjs text items — the default pdf-parse output
 * concatenates the 4 numeric columns together without any separator.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import pdfParse from 'pdf-parse';

const WORKSPACE = path.resolve(__dirname, '..', '..');
const FILE = 'February 2026 West Pecos Trading WIO Mailout.pdf';

async function main() {
  const full = path.join(WORKSPACE, FILE);
  const buf = fs.readFileSync(full);

  // Custom pagerender: serialize each item as  "{x}\t{y}\t{str}\n"
  // so we can re-parse it here without losing positional info.
  async function pagerender(pageData: any): Promise<string> {
    const content = await pageData.getTextContent({
      normalizeWhitespace: false,
      disableCombineTextItems: false,
    });
    const lines: string[] = [];
    for (const it of content.items as any[]) {
      const x = it.transform[4];
      const y = it.transform[5];
      const s = it.str.replace(/\t/g, ' ');
      lines.push(`${x.toFixed(2)}\t${y.toFixed(2)}\t${s}`);
    }
    return lines.join('\n');
  }

  const parsed = await pdfParse(buf, { pagerender });
  const items = parsed.text
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const parts = l.split('\t');
      return { x: Number(parts[0]), y: Number(parts[1]), str: parts.slice(2).join('\t') };
    });

  console.log(`Total items: ${items.length}`);

  // Group by y-bucket
  const byLine = new Map<number, typeof items>();
  for (const it of items) {
    const key = Math.round(it.y / 2) * 2;
    if (!byLine.has(key)) byLine.set(key, []);
    byLine.get(key)!.push(it);
  }
  const sortedKeys = Array.from(byLine.keys()).sort((a, b) => b - a);
  for (const y of sortedKeys) {
    const line = byLine.get(y)!.sort((a, b) => a.x - b.x);
    const pretty = line
      .map((i) => `[x=${i.x.toFixed(1)}]"${i.str}"`)
      .join(' | ');
    console.log(`y=${y.toFixed(1)}: ${pretty}`);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
