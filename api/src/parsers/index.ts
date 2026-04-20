/**
 * Parser Dispatcher
 * ------------------
 * Given an attachment (bytes + filename + sender), figure out which operator
 * format it is and run the right parser.
 *
 * Architecture:
 *   1. Build a ParserContext: determine file kind + pre-read what every adapter
 *      might need (pdfText, sheetNames, sheetPreview) ONCE per file.
 *   2. Iterate the FORMAT_REGISTRY in order. For each adapter whose file kinds
 *      include ours, call detect(ctx). First match wins.
 *   3. If matched, call parse(ctx). Return a 'parsed' outcome.
 *   4. If a matched adapter is a stub (parse throws "not yet implemented"),
 *      the caller sees an error outcome — email_log flags it for manual review
 *      with the specific format name, not a generic "unknown".
 *   5. If nothing matched, return 'unrecognized' with the available signatures
 *      for debugging.
 *
 * Adding a new format: create a FormatAdapter in its own file and add a row to
 * parsers/registry.ts. No changes needed here.
 */

import pdfParse from 'pdf-parse';
import * as XLSX from 'xlsx';
import type { EmailAttachment } from '../services/gmail.js';
import type {
  FileKind,
  ParserContext,
  ProductionRecord,
} from './types.js';
import { FORMAT_REGISTRY } from './registry.js';

// Re-export so callers (services/productionStorage.ts) can keep their import.
export type { ProductionRecord } from './types.js';

export type ParserOutcome =
  | {
      kind: 'parsed';
      operatorName: string;
      formatName: string;
      dataType: 'monthly' | 'daily' | 'weekly';
      records: ProductionRecord[];
    }
  | {
      kind: 'unrecognized';
      reason: string;
    }
  | {
      kind: 'error';
      /** Human-readable error message. */
      message: string;
      /** If the format was identified before parse failed, we include it so the
       *  dashboard can show "Known format, parser pending" instead of a blank label. */
      matchedFormatName?: string;
    };

/* ────────────────────────────────────────────────────────────────
 * File kind detection — looks at mime, extension, and magic bytes.
 * ──────────────────────────────────────────────────────────────── */
function detectFileKind(att: EmailAttachment): FileKind {
  const lowerName = att.filename.toLowerCase();
  const mime = (att.mimeType || '').toLowerCase();

  if (mime === 'application/pdf' || lowerName.endsWith('.pdf')) return 'pdf';
  if (att.data.subarray(0, 4).toString() === '%PDF') return 'pdf';

  if (
    mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    lowerName.endsWith('.xlsx')
  ) {
    return 'xlsx';
  }

  if (mime === 'application/vnd.ms-excel' || lowerName.endsWith('.xls')) {
    return 'xls';
  }

  if (mime === 'text/csv' || lowerName.endsWith('.csv')) return 'csv';

  return 'unknown';
}

/* ────────────────────────────────────────────────────────────────
 * Lazy pre-readers — populate ParserContext once per attachment so
 * every adapter's detect() is cheap. Defensive: if any pre-read
 * fails we don't crash the whole dispatcher — we just leave the
 * field undefined and let adapters that need it skip themselves.
 * ──────────────────────────────────────────────────────────────── */
async function readPdfText(buffer: Buffer): Promise<string | undefined> {
  try {
    const result = await pdfParse(buffer);
    return result.text;
  } catch (err) {
    console.warn('[dispatcher] PDF pre-read failed:', err);
    return undefined;
  }
}

/** Read workbook structure: sheet names + first ~20 rows of first sheet as 2D. */
function readWorkbookPreview(
  buffer: Buffer,
  kind: 'xlsx' | 'xls' | 'csv'
): { sheetNames: string[]; sheetPreview: (string | number | null)[][] } | undefined {
  try {
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
    const sheetNames = wb.SheetNames;
    if (!sheetNames || sheetNames.length === 0) return undefined;

    const firstSheet = wb.Sheets[sheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(firstSheet, {
      header: 1,
      blankrows: false,
      raw: true,
    }) as (string | number | null)[][];

    const preview = aoa.slice(0, 20);
    return { sheetNames, sheetPreview: preview };
  } catch (err) {
    console.warn(`[dispatcher] ${kind} pre-read failed:`, err);
    return undefined;
  }
}

/* ────────────────────────────────────────────────────────────────
 * Build the full ParserContext from an attachment.
 * ──────────────────────────────────────────────────────────────── */
async function buildContext(
  attachment: EmailAttachment,
  senderEmail: string
): Promise<ParserContext> {
  const fileKind = detectFileKind(attachment);
  const ctx: ParserContext = {
    buffer: attachment.data,
    filename: attachment.filename,
    mimeType: attachment.mimeType || '',
    senderEmail,
    fileKind,
  };

  if (fileKind === 'pdf') {
    ctx.pdfText = await readPdfText(attachment.data);
  } else if (fileKind === 'xlsx' || fileKind === 'xls' || fileKind === 'csv') {
    const preview = readWorkbookPreview(attachment.data, fileKind);
    if (preview) {
      ctx.sheetNames = preview.sheetNames;
      ctx.sheetPreview = preview.sheetPreview;
    }
  }

  return ctx;
}

/* ────────────────────────────────────────────────────────────────
 * Main dispatch entry.
 * ──────────────────────────────────────────────────────────────── */
export async function dispatchParser(
  attachment: EmailAttachment,
  senderEmail: string
): Promise<ParserOutcome> {
  let ctx: ParserContext;
  try {
    ctx = await buildContext(attachment, senderEmail);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: 'error', message: `Failed to pre-read attachment: ${message}` };
  }

  if (ctx.fileKind === 'unknown') {
    return {
      kind: 'unrecognized',
      reason: `Unsupported file type: ${attachment.mimeType} (${attachment.filename})`,
    };
  }

  // Walk the registry in order; first adapter that accepts the file kind AND
  // signals detect() wins.
  for (const registered of FORMAT_REGISTRY) {
    const adapter = registered.adapter;
    if (!adapter.fileKinds.includes(ctx.fileKind)) continue;

    let matched = false;
    try {
      matched = adapter.detect(ctx);
    } catch (err) {
      console.warn(`[dispatcher] detect() threw for "${adapter.name}":`, err);
      continue;
    }
    if (!matched) continue;

    // Found a matching adapter — try to parse.
    try {
      const records = await adapter.parse(ctx);
      return {
        kind: 'parsed',
        operatorName: adapter.operatorName,
        formatName: adapter.name,
        dataType: adapter.dataType,
        records,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        kind: 'error',
        message,
        matchedFormatName: adapter.name,
      };
    }
  }

  // No adapter matched — return a descriptive unrecognized outcome so the
  // email_log row can show what we DID see (helps diagnose new operator formats).
  const snippet =
    ctx.pdfText?.slice(0, 200) ??
    (ctx.sheetNames ? `Sheet names: ${ctx.sheetNames.join(', ')}` : '(no preview available)');
  return {
    kind: 'unrecognized',
    reason:
      `No format signature matched. File kind: ${ctx.fileKind}. ` +
      `Filename: ${attachment.filename}. First look: ${snippet.replace(/\s+/g, ' ').trim()}`,
  };
}
