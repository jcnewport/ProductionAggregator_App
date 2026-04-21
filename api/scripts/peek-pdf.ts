/**
 * Throwaway helper — download a PDF from Supabase Storage and dump
 * its extracted text so we can see column layout. Used for Task #80
 * diagnosis (4 rejected Frio PDS PDFs).
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... npx tsx scripts/peek-pdf.ts <storage-path>
 */

import { createClient } from '@supabase/supabase-js';
// @ts-expect-error: pdf-parse has no types
import pdfParse from 'pdf-parse';

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: peek-pdf.ts <storage-path>');
    process.exit(1);
  }
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_KEY!;
  const supabase = createClient(url, key);

  const { data, error } = await supabase.storage
    .from('production-files')
    .download(path);
  if (error || !data) {
    console.error('download error:', error?.message);
    process.exit(1);
  }

  const buf = Buffer.from(await data.arrayBuffer());
  const parsed = await pdfParse(buf);
  console.log('── TEXT (first 4000 chars) ──');
  console.log(parsed.text.slice(0, 4000));
  console.log('── TOTAL CHARS:', parsed.text.length, '──');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
