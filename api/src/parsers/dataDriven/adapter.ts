/**
 * Data-Driven Adapter Factory
 * ---------------------------
 * Given a LoadedMapping (one row from format_mappings), produce a FormatAdapter
 * that conforms to the exact same interface as every hand-written adapter in
 * /api/src/parsers/*.ts. This is what lets the dispatcher loop be completely
 * unaware of whether an adapter came from a TS file or from the database.
 *
 * How detection works:
 *   IdentificationRules.requireAll decides whether signals are ANDed or ORed.
 *   Default = ORed (any hit counts). Each individual rule is its own helper
 *   below so a future UI can preview which rule triggered the match.
 *
 * How parse works:
 *   MappingConfig.kind routes to the right engine:
 *     - 'structured' → runStructuredEngine (Phase 1, works now)
 *     - 'pdf'        → runPdfEngine (stub until Phase 4)
 */

import type { FormatAdapter, ParserContext, ProductionRecord, FileKind } from '../types.js';
import type { LoadedMapping, IdentificationRules } from './schema.js';
import { runStructuredEngine } from './structuredEngine.js';
import { runPdfEngine } from './pdfEngine.js';

/* ══════════════════════════════════════════════════════════════════════
 * Detection helpers — each returns true if the rule matches, false if not
 * present / not matched. Used by the combined decider below.
 * ═════════════════════════════════════════════════════════════════════ */

function senderMatches(ctx: ParserContext, rules: IdentificationRules): boolean | null {
  const patterns = rules.senderEmailPatterns;
  if (!patterns || patterns.length === 0) return null;
  for (const p of patterns) {
    try {
      if (new RegExp(p, 'i').test(ctx.senderEmail)) return true;
    } catch {
      // Bad regex string saved in DB — ignore that rule rather than crash.
    }
  }
  return false;
}

function filenameMatches(ctx: ParserContext, rules: IdentificationRules): boolean | null {
  const patterns = rules.filenamePatterns;
  if (!patterns || patterns.length === 0) return null;
  for (const p of patterns) {
    try {
      if (new RegExp(p, 'i').test(ctx.filename)) return true;
    } catch {
      // ignore bad pattern
    }
  }
  return false;
}

function contentSigMatches(ctx: ParserContext, rules: IdentificationRules): boolean | null {
  const sigs = rules.contentSignatures;
  if (!sigs || sigs.length === 0) return null;

  // Build a haystack: pdfText if PDF, otherwise the sheet preview flattened.
  const haystack = ctx.pdfText
    ? ctx.pdfText
    : (ctx.sheetPreview ?? []).flat().map((c) => String(c ?? '')).join(' ');
  if (!haystack) return false;

  for (const s of sigs) {
    try {
      if (new RegExp(s, 'i').test(haystack)) return true;
    } catch {
      // ignore bad pattern
    }
  }
  return false;
}

function requiredHeadersMatch(ctx: ParserContext, rules: IdentificationRules): boolean | null {
  const tokens = rules.requiredHeaders;
  if (!tokens || tokens.length === 0) return null;
  const headerRow = (ctx.sheetPreview?.[0] ?? []).map((c) => String(c ?? '').trim().toUpperCase());
  if (headerRow.length === 0) return false;
  return tokens.every((t) => headerRow.includes(t.trim().toUpperCase()));
}

/** Combine all rules per requireAll. Returns true if the adapter claims ownership. */
function detectFromRules(ctx: ParserContext, rules: IdentificationRules): boolean {
  const results = [
    senderMatches(ctx, rules),
    filenameMatches(ctx, rules),
    contentSigMatches(ctx, rules),
    requiredHeadersMatch(ctx, rules),
  ].filter((r): r is boolean => r !== null);

  // No rules at all → never auto-match. Forces the operator to configure
  // at least one identification signal before the mapping goes live.
  if (results.length === 0) return false;

  if (rules.requireAll) return results.every(Boolean);
  return results.some(Boolean);
}

/* ══════════════════════════════════════════════════════════════════════
 * The factory
 * ═════════════════════════════════════════════════════════════════════ */

/**
 * Build a FormatAdapter from a DB mapping row. The returned adapter is shaped
 * exactly like a hand-written one so the dispatcher treats them identically.
 */
export function buildAdapterFromMapping(mapping: LoadedMapping): FormatAdapter {
  // Map fileType (DB) → FileKind[] (adapter interface).
  const fileKinds: readonly FileKind[] = [mapping.fileType] as const;

  // Operator label: prefer joined operators.name, fall back to stored mapping name.
  const operatorName = mapping.operatorName ?? 'Unknown operator';

  // Stable display name — shown in dashboard "Format" column. Prefix lets
  // Caleb instantly see whether a row was matched via DB config or code.
  const displayName = `${mapping.name} [DB]`;

  const adapter: FormatAdapter = {
    name: displayName,
    operatorName,
    dataType: mapping.dataType,
    fileKinds,

    detect(ctx: ParserContext): boolean {
      // Skip outright if file kind doesn't match.
      if (!fileKinds.includes(ctx.fileKind)) return false;
      return detectFromRules(ctx, mapping.rules);
    },

    async parse(ctx: ParserContext): Promise<ProductionRecord[]> {
      if (mapping.config.kind === 'structured') {
        if (mapping.config.fileKind !== ctx.fileKind) {
          throw new Error(
            `[${displayName}] config.fileKind='${mapping.config.fileKind}' but file kind is '${ctx.fileKind}'`
          );
        }
        return runStructuredEngine(ctx.buffer, mapping.config);
      }
      if (mapping.config.kind === 'pdf') {
        return runPdfEngine(ctx.buffer, mapping.config);
      }
      // Should be unreachable due to validateMappingConfig guarding the union.
      throw new Error(`[${displayName}] unknown config.kind`);
    },
  };

  return adapter;
}
