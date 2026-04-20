/**
 * Parser Dispatcher
 * ------------------
 * Given an attachment (file bytes + filename + sender), figure out which
 * operator format it is and run the right parser.
 *
 * Phase 1 supports: PDS Anadarko Monthly PDF. More formats will be added
 * as identifier rules + parser implementations in Phase 2.
 */

import {
  parseAnadarkoMonthlyPdf,
  isPdsAnadarkoMonthly,
  ProductionRecord,
} from './pdsAnadarkoMonthly.js';
import { PDFParse } from 'pdf-parse';
import type { EmailAttachment } from '../services/gmail.js';

export type ParserOutcome =
  | {
      kind: 'parsed';
      operatorName: string;
      formatName: string;
      dataType: 'monthly' | 'daily';
      records: ProductionRecord[];
    }
  | {
      kind: 'unrecognized';
      reason: string;
    }
  | {
      kind: 'error';
      message: string;
    };

/**
 * Quick test: is this a PDF?
 */
function isPdf(attachment: EmailAttachment): boolean {
  if (attachment.mimeType === 'application/pdf') return true;
  if (attachment.filename.toLowerCase().endsWith('.pdf')) return true;
  // Magic bytes check: PDFs start with "%PDF"
  return attachment.data.subarray(0, 4).toString() === '%PDF';
}

/**
 * Extract the raw text from a PDF for format-signature sniffing.
 * We intentionally DON'T call the full parser yet — just grab text so the
 * dispatcher can route to the right parser.
 */
async function sniffPdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  return result.text;
}

/**
 * Main entry point for the dispatcher.
 */
export async function dispatchParser(
  attachment: EmailAttachment,
  _senderEmail: string
): Promise<ParserOutcome> {
  try {
    // === PDF FILES ===
    if (isPdf(attachment)) {
      const sniffed = await sniffPdfText(attachment.data);

      // --- PDS Anadarko Monthly ---
      if (isPdsAnadarkoMonthly(sniffed)) {
        const records = await parseAnadarkoMonthlyPdf(attachment.data);
        return {
          kind: 'parsed',
          operatorName: 'Anadarko (Oxy)',
          formatName: 'PDS Anadarko Monthly',
          dataType: 'monthly',
          records,
        };
      }

      // --- Future PDS formats will be routed here (EOG, Mewbourne, XTO, ConocoPhillips) ---
      return {
        kind: 'unrecognized',
        reason:
          'PDF does not match any known operator format signature. Flagged for manual review.',
      };
    }

    // === XLSX / XLS / CSV — Phase 2 ===
    // (Aftermath CSV, Arlo XLSX, BTA Daily, Monthly Report — all land here eventually)

    return {
      kind: 'unrecognized',
      reason: `Unsupported file type: ${attachment.mimeType} (${attachment.filename})`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: 'error', message };
  }
}
