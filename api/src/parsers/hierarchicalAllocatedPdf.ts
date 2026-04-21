/**
 * Parser: Hierarchical Allocated-Production PDF  (sibling of Formats 10 + 35)
 * ----------------------------------------------------------------------------
 * ONE adapter that handles the PDF export of the "Partner Report" layout
 * already implemented for XLSX in `hierarchicalAllocatedXlsx.ts`. Same
 * operators, same column semantics — only the container changes.
 *
 * Known source files:
 *   • PARTNER REPORT - WEST PECOS.pdf
 *   • Tap Rock Partner Report *.pdf  (analogous format, same template)
 *
 * Why a PDF variant:
 *   Some operators email the PDF instead of (or in addition to) the XLSX.
 *   Without this adapter those attachments fall to "unrecognized" and end
 *   up in the flagged-review queue even though we already have the XLSX
 *   parsed in the same inbox. Having this adapter means we don't lose a
 *   well-day just because the operator shipped the PDF version.
 *
 * ──────────────────────────────────────────────────────────────────────
 * PDF text structure (verified against pdf-parse output):
 * ──────────────────────────────────────────────────────────────────────
 *
 *   [page header — repeats on every page]
 *     Completion Well Name/DateUnit API - 14OpTm (hr)DT (hr)
 *     Alloc Oil
 *     (bbl)
 *     Alloc Gas
 *     (MCF)
 *     Alloc Wat
 *     (bbl)
 *     Well Param
 *     Chk Sz
 *     (1/64")
 *     Well Param P
 *     (tub) (psi)
 *     Well Param P
 *     (cas) (psi)
 *
 *   [well-identity block — 1-2 text lines, then a totals row]
 *     COORS FEDERAL COM          ← well name line 1
 *     #211H                      ← well name line 2 (optional)
 *     672.000.0029,116.16...     ← 8 concatenated decimals = monthly totals
 *
 *   [per-day rows — repeat]
 *     2/1/2026                   ← date
 *     30015568670                ← API part 1 (11 digits)
 *     000                        ← API part 2 (3 digits) → api14 = 30015568670000
 *     24.000.001,035.053,012.41... ← 8 concatenated decimals = day's values
 *
 *   [page footer — on every page]
 *     1/13
 *     Partner Report
 *     Printed: 3/3/2026 7:17 AM
 *     Date: 2/1/2026 to 2/28/2026
 *
 * Column order of the 8 concatenated values (matches header L→R):
 *   [0] OpTm (hr)       → extraFields.opTmHr  (NOT in ComboCurve template)
 *   [1] DT (hr)         → hoursDown
 *   [2] Alloc Oil (bbl) → oilProd
 *   [3] Alloc Gas (MCF) → gasProd
 *   [4] Alloc Wat (bbl) → waterProd
 *   [5] Well Param Chk Sz (1/64") → choke (string, per project rules)
 *   [6] Well Param P (tub) (psi)  → tubingPres
 *   [7] Well Param P (cas) (psi)  → casingPres
 *
 * PDF-rendering quirk worth naming out loud:
 *   Occasionally a row comes back with only 7 decimal matches instead of 8.
 *   The missing slot is always the tubing pressure (a zero value that the
 *   PDF text layer failed to emit, e.g. "40.00" "0.00" "1,280.70" rendered
 *   as "40.001,280.70" — impossible to distinguish from "40.00" "1,280.70"
 *   without column-x coordinates). We detect the short row and null out
 *   tubingPres rather than mis-shifting Pcas into the Ptub slot, which
 *   would corrupt pressure-trend analytics. Oil/Gas/Water are ALWAYS in
 *   positions 0-4 and never affected by this quirk.
 *
 * Data never dropped:
 *   - Missing API is allowed (spec says some hierarchical sources have
 *     no API at all — we'd fall back to well_name_aliases). Here the PDF
 *     always has API, but we keep the null-safe path for parity with the
 *     XLSX sibling.
 *   - Negative allocated values are preserved as-is (accounting corrections,
 *     per project_instructions).
 *   - The well-totals row is captured in extraFields.wellTotalBlock on the
 *     FIRST daily record of each well, so the monthly roll-up number is
 *     never lost.
 */

import type { FormatAdapter, ParserContext, ProductionRecord } from './types.js';

/* ────────────────────────────────────────────────────────────────
 * Utilities — intentionally local (no cross-file coupling).
 * ──────────────────────────────────────────────────────────────── */

/** Parse a value like "1,035.05" or "24.00" → number. NaN-safe. */
function parseVal(s: string): number | null {
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** M/D/YYYY → YYYY-MM-DD. Returns null if not a date-looking string. */
function mdyToIso(line: string): string | null {
  const m = line.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const mm = Number(m[1]);
  const dd = Number(m[2]);
  const yyyy = Number(m[3]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

/** Pad a digits-only string out to 14 with trailing zeros. */
function toApi14(digits: string): string {
  const d = digits.replace(/\D/g, '');
  if (d === '') return '';
  if (d.length >= 14) return d.slice(0, 14);
  return d.padEnd(14, '0');
}

/** Return the first 10 digits of a digits-only string. */
function toApi10(digits: string): string {
  const d = digits.replace(/\D/g, '');
  if (d === '') return '';
  return d.slice(0, 10).padStart(10, '0');
}

/**
 * Extract all concatenated decimal values from a row like
 * "24.000.001,035.053,012.414,316.3342.000.001,394.73"
 * → [24.00, 0.00, 1035.05, 3012.41, 4316.33, 42.00, 0.00, 1394.73]
 *
 * Pattern [\d,]+\.\d{2} matches:
 *   - one or more digits/commas
 *   - a literal dot
 *   - exactly 2 digits (the decimal tail all values use)
 */
function extractDecimals(line: string): number[] {
  const out: number[] = [];
  const re = /[\d,]+\.\d{2}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const v = parseVal(m[0]);
    if (v !== null) out.push(v);
  }
  return out;
}

/**
 * True if a line is a concatenated-value row (composed ONLY of digits,
 * commas, and dots). Used to distinguish from the other line types.
 */
function looksLikeValueLine(line: string): boolean {
  return line.length > 0 && /^[\d,.\s]+$/.test(line) && /\.\d{2}/.test(line);
}

/**
 * Lines that belong to the repeating page header / footer. We skip them
 * silently. The header sublines are broken across multiple text items in
 * pdf-parse's output, so we match fragments.
 */
const HEADER_FRAG_PREFIX_RE = /^(Completion\s+Well\s+Name\/Date|Alloc\s+(Oil|Gas|Wat)|Well\s+Param|Chk\s+Sz|\(bbl\)|\(MCF\)|\(1\/64"\)|\(tub\)\s+\(psi\)|\(cas\)\s+\(psi\))/i;
const FOOTER_LINE_RE = /^(Partner Report|Printed:\s.*|Date:\s.*\s+to\s+.*|Tap Rock|West Pecos)\s*$/i;
const PAGE_NUM_RE = /^\d{1,3}\/\d{1,3}$/;

/* ────────────────────────────────────────────────────────────────
 * Core parser
 * ──────────────────────────────────────────────────────────────── */

export function parseHierarchicalAllocatedPdf(pdfText: string): ProductionRecord[] {
  // Line-split and normalize whitespace per line. Preserve blank lines so
  // we can use them as well-block separators if needed (we don't strictly
  // need them — the state machine is driven by line-type transitions).
  const rawLines = pdfText.split(/\r?\n/);
  const lines = rawLines.map((l) => l.replace(/\u00a0/g, ' ').trim());

  const records: ProductionRecord[] = [];

  // State:
  //   wellNameBuf — accumulates 1-2 text lines until we hit a totals row
  //   currentWellName — the confirmed well name after a totals row finalizes it
  //   currentWellTotalBlock — the 8 numbers from the totals row (flows into extraFields.wellTotalBlock)
  //   firstRecordForCurrentWell — gate so totals only attach to the first daily record
  //   pendingDate / pendingApi1 / pendingApi2 — accumulate before a value row emits
  let wellNameBuf: string[] = [];
  let currentWellName = '';
  let currentWellTotalBlock: Record<string, unknown> | null = null;
  let firstRecordForCurrentWell = true;

  let pendingDate: string | null = null;
  let pendingApi1: string | null = null;
  let pendingApi2: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') continue;

    // --- page header/footer noise: skip silently ---
    if (HEADER_FRAG_PREFIX_RE.test(line)) continue;
    if (FOOTER_LINE_RE.test(line)) continue;
    if (PAGE_NUM_RE.test(line)) continue;

    // --- date line (single-line MM/DD/YYYY) ---
    const iso = mdyToIso(line);
    if (iso !== null) {
      pendingDate = iso;
      pendingApi1 = null;
      pendingApi2 = null;
      continue;
    }

    // --- API part 1 (11 digits) ---
    if (/^\d{11}$/.test(line)) {
      // Only treat as API1 if we already have a date pending — otherwise
      // this is probably a run of digits inside the totals block.
      if (pendingDate !== null) {
        pendingApi1 = line;
        continue;
      }
    }

    // --- API part 2 (3 digits) ---
    if (/^\d{3}$/.test(line)) {
      if (pendingApi1 !== null) {
        pendingApi2 = line;
        continue;
      }
    }

    // --- concatenated-value row (totals or daily) ---
    if (looksLikeValueLine(line)) {
      const values = extractDecimals(line);

      // Case A: we are still accumulating a well-name buffer → this is the
      // monthly-totals row for that well. Finalize the name, capture totals,
      // do NOT emit a daily record.
      if (wellNameBuf.length > 0) {
        currentWellName = wellNameBuf.join(' ').replace(/\s+/g, ' ').trim();
        wellNameBuf = [];
        currentWellTotalBlock = packTotalsBlock(values);
        firstRecordForCurrentWell = true;
        // Any pendingDate/api state from before was noise — reset.
        pendingDate = null;
        pendingApi1 = null;
        pendingApi2 = null;
        continue;
      }

      // Case B: this is a daily row — needs a date to anchor it. If there
      // isn't one, we're out of sync (almost certainly a stray numeric line
      // we didn't recognize). Skip, don't throw.
      if (pendingDate === null || !currentWellName) {
        continue;
      }

      // Resolve API from parts (may be empty if the PDF omitted them for
      // a given row — parity with the XLSX sibling which also tolerates this).
      const apiDigits = `${pendingApi1 ?? ''}${pendingApi2 ?? ''}`;
      const api10 = apiDigits ? toApi10(apiDigits) : '';
      const api14 = apiDigits ? toApi14(apiDigits) : '';

      // Map values into named columns. The "7 values instead of 8" quirk
      // (PDF lost a zero tubing pressure) is handled here: we null Ptub
      // rather than shift Pcas into the wrong slot.
      let opTm: number | null = null;
      let dt: number | null = null;
      let oil: number | null = null;
      let gas: number | null = null;
      let wat: number | null = null;
      let chk: string | null = null;
      let ptub: number | null = null;
      let pcas: number | null = null;
      let parseWarning: string | null = null;

      if (values.length === 8) {
        opTm = values[0];
        dt = values[1];
        oil = values[2];
        gas = values[3];
        wat = values[4];
        chk = formatChoke(values[5]);
        ptub = values[6];
        pcas = values[7];
      } else if (values.length === 7) {
        // PDF rendering dropped a zero-valued Ptub. Oil/Gas/Water always
        // survive at positions 0-4; ChkSz at 5; remaining value is Pcas.
        opTm = values[0];
        dt = values[1];
        oil = values[2];
        gas = values[3];
        wat = values[4];
        chk = formatChoke(values[5]);
        ptub = null;
        pcas = values[6];
        parseWarning = 'pdf-short-row-7: tubing pressure likely zero (PDF dropped it)';
      } else if (values.length >= 5) {
        // Partial — keep the safe-position volumes, null the rest.
        opTm = values[0];
        dt = values[1];
        oil = values[2];
        gas = values[3];
        wat = values[4];
        if (values.length >= 6) chk = formatChoke(values[5]);
        parseWarning = `pdf-short-row-${values.length}: choke/pressures unavailable`;
      } else {
        // Fewer than 5 numbers → row is so malformed we can't even trust
        // the volume columns. Skip with a warning — do NOT emit a bogus
        // row whose Oil value might actually be ChkSz.
        console.warn(
          `[hierarchicalAllocatedPdf] Skipping under-parsed value row ` +
            `(${values.length} decimals) for well="${currentWellName}" date=${pendingDate}: "${line}"`
        );
        pendingDate = null;
        pendingApi1 = null;
        pendingApi2 = null;
        continue;
      }

      const extraFields: Record<string, unknown> = {};
      if (opTm !== null) extraFields.opTmHr = opTm;
      if (firstRecordForCurrentWell && currentWellTotalBlock) {
        extraFields.wellTotalBlock = currentWellTotalBlock;
        firstRecordForCurrentWell = false;
      }
      if (parseWarning) extraFields.pdfParseWarning = parseWarning;

      records.push({
        api14,
        api10,
        wellName: currentWellName,
        combocurveWellId: null,
        operatorWellId: null,
        prodDate: pendingDate,
        oilProd: oil,
        gasProd: gas,
        waterProd: wat,
        oilSales: null, // not reported in allocated format — never 0
        gasSales: null,
        waterInj: null,
        daysOn: null,
        choke: chk,
        tubingPres: ptub,
        casingPres: pcas,
        hoursDown: dt,
        downtimeReason: null,
        extraFields,
      });

      pendingDate = null;
      pendingApi1 = null;
      pendingApi2 = null;
      continue;
    }

    // --- any other text line is a well-name fragment ---
    // Well names span 1-2 lines (e.g. "COORS FEDERAL COM" + "#211H"). We
    // accumulate and flush when the next value row arrives. A fresh name
    // mid-block (page break re-asserting the same well) is harmless —
    // we'll re-finalize the same string and skip the same totals row.
    wellNameBuf.push(line);
  }

  return records;
}

/* ────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────── */

/**
 * Convert the 8 totals-row numbers into a named record so downstream code
 * can eyeball the monthly figure without re-parsing the PDF.
 */
function packTotalsBlock(values: number[]): Record<string, unknown> | null {
  if (values.length < 5) return null;
  const block: Record<string, unknown> = {};
  if (values.length > 0) block.opTmHr = values[0];
  if (values.length > 1) block.hoursDown = values[1];
  if (values.length > 2) block.oilProd = values[2];
  if (values.length > 3) block.gasProd = values[3];
  if (values.length > 4) block.waterProd = values[4];
  if (values.length > 5) block.choke = formatChoke(values[5]);
  if (values.length > 6) block.tubingPres = values[6];
  if (values.length > 7) block.casingPres = values[7];
  return block;
}

/**
 * Choke is reported as an integer 1/64"ths (e.g. 42 for 42/64"). Preserve
 * the numeric form as a string (per project rules — choke is column type
 * "text" in the ComboCurve template because some operators report "64/64").
 */
function formatChoke(n: number | null | undefined): string | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  // Integer-valued chokes render without the trailing .00.
  if (Number.isInteger(n)) return String(n);
  return String(n);
}

/* ────────────────────────────────────────────────────────────────
 * Adapter registration
 * ──────────────────────────────────────────────────────────────── */

export const hierarchicalAllocatedPdfAdapter: FormatAdapter = {
  name: 'Hierarchical Allocated Production PDF',
  operatorName: 'Various (Tap Rock / West Pecos / EFG)',
  dataType: 'daily',
  fileKinds: ['pdf'],

  /**
   * Detect fingerprint:
   *   - The column-header string "Completion Well Name/Date" AND
   *   - An "Alloc <Oil|Gas|Wat>" column marker AND
   *   - The "Well Param Chk Sz" block (distinguishes this format from the
   *     much-simpler BTA WIO Mailout which ALSO has "Alloc"-style columns
   *     in some revisions but never has Chk Sz / P(tub) / P(cas)).
   *   - Excludes: "PDS Well Data Exchange" (so we never steal a match from
   *     one of the PDS adapters that also have Oil/Gas/Water columns).
   */
  detect(ctx: ParserContext): boolean {
    const text = ctx.pdfText ?? '';
    if (!text) return false;

    if (/PDS Well Data Exchange/i.test(text)) return false;

    const hasNameDateCol = /Completion\s+Well\s+Name\/Date/i.test(text);
    if (!hasNameDateCol) return false;

    const hasAllocCol =
      /Alloc\s+Oil\s*\(bbl\)/i.test(text) ||
      /Alloc\s+Gas\s*\(MCF\)/i.test(text) ||
      /Alloc\s+Wat\s*\(bbl\)/i.test(text);
    if (!hasAllocCol) return false;

    const hasChokeCol = /Well\s+Param\s+Chk\s+Sz/i.test(text) || /Chk\s+Sz\s*\(1\/64/i.test(text);
    if (!hasChokeCol) return false;

    return true;
  },

  async parse(ctx: ParserContext): Promise<ProductionRecord[]> {
    const text = ctx.pdfText ?? '';
    if (!text) {
      throw new Error('Hierarchical Allocated PDF: no pdfText available in context');
    }
    const records = parseHierarchicalAllocatedPdf(text);
    if (records.length === 0) {
      throw new Error(
        'Hierarchical Allocated PDF: zero records extracted — format signature matched ' +
          'but the line-state-machine produced nothing. This usually means the PDF text ' +
          'layer rendered in an unexpected order; a positional (x/y) parser may be needed.'
      );
    }
    return records;
  },
};
