/**
 * Format 11 — Frio Daily Production XLSX ("Daily Production Report")
 * -------------------------------------------------------------------
 * Field-centric daily snapshot covering many wells in a single field on
 * a single production date. Arrives on the email subject line pattern
 * "Fw: Frio Daily Production (Daily Production Report) a/o YYYY-MM-DD".
 *
 * Sheet shape (single sheet, name = "Daily Production Report"):
 *
 *   Row 0 : "Daily Production Report"                     (title)
 *   Row 1 : "Hierarchy"          | "Well Hierarchy"
 *   Row 2 : "Fieldname"          | <FIELD NAME>           (e.g. NORTH HARPOON)
 *   Row 3 : "Production  Date"   | "MM/DD/YYYY to MM/DD/YYYY"
 *   Row 4 : HEADER — Wellname | Oil Production | Gas Production |
 *                    Gas Flare | Water Production | Production Date
 *   Row 5+: data — one row per well; Production Date cell is an Excel
 *           serial (e.g. 46112 = 2026-03-31)
 *
 * Quirks the adapter handles:
 *   - NO API column. Downstream `well_name_aliases` lookup resolves
 *     wells by name (same pattern as BTA Daily XLSX + Hierarchical
 *     Monthly Report).
 *   - NO Sales columns. oilSales / gasSales stored as null — NOT 0,
 *     because "absent" and "zero" are semantically different.
 *   - NO pressure / choke / hours-down / downtime data. All null.
 *   - Gas Flare is NOT in the ComboCurve 16-column template. We preserve
 *     it in `extraFields.gasFlare` so nothing is lost.
 *   - Fieldname (from row 2) is a geographic reporting-area label —
 *     captured in `extraFields.fieldname` on every record for context.
 *   - Production Date arrives as an Excel serial number — converted via
 *     `XLSX.SSF.parse_date_code`. Defensive fallback handles string
 *     dates (M/D/YYYY or YYYY-MM-DD) in case a future file ships text
 *     dates instead of serials.
 *   - Rows where Wellname is blank are skipped silently (trailing
 *     empty rows from Excel padding).
 *   - Rows with an accidental "Wellname" repeat (merged-cell artifacts)
 *     or "Total" summary rows are filtered by a string check.
 *
 * Detection signature (all three must hold — keeps the detect tight):
 *   1. Sheet named "Daily Production Report" (case-insensitive).
 *   2. Row-0 title cell = "Daily Production Report".
 *   3. Header row (scanned in first 20 rows) contains BOTH "Wellname"
 *      and "Gas Flare" — Gas Flare is unique to this format in our
 *      registry, so this is the real anti-false-match guard.
 */

import * as XLSX from 'xlsx';
import type { FormatAdapter, ProductionRecord } from './types.js';

/* ────────────────────────────────────────────────────────────────
 * Small helpers (kept local — these are not general enough to live
 * in a shared util).
 * ──────────────────────────────────────────────────────────────── */

/** Lowercase + trim a header cell for comparison. */
function normCell(v: unknown): string {
  return String(v ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** Parse a cell into a finite number, or null if blank / NaN. */
function toNumOrNull(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Convert an Excel serial OR date-string cell to a YYYY-MM-DD ISO date. */
function cellToIsoDate(cell: unknown): string | null {
  if (typeof cell === 'number' && Number.isFinite(cell)) {
    // XLSX serials: integer part = days since 1900-01-00 (with the Lotus
    // 1900-leap-year bug preserved). SSF.parse_date_code handles that.
    const dc = XLSX.SSF.parse_date_code(cell);
    if (dc && dc.y && dc.m && dc.d) {
      return `${String(dc.y).padStart(4, '0')}-${String(dc.m).padStart(2, '0')}-${String(dc.d).padStart(2, '0')}`;
    }
    return null;
  }
  if (typeof cell === 'string') {
    const s = cell.trim();
    // M/D/YYYY or MM/DD/YYYY or M/D/YY
    const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (mdy) {
      const yyyy = mdy[3].length === 2 ? `20${mdy[3]}` : mdy[3];
      return `${yyyy}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
    }
    // YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  }
  return null;
}

/* ────────────────────────────────────────────────────────────────
 * The adapter.
 * ──────────────────────────────────────────────────────────────── */
export const frioDailyProductionXlsxAdapter: FormatAdapter = {
  name: 'Frio Daily Production XLSX',
  operatorName: 'Frio Energy Holdings (Daily Report)',
  dataType: 'daily',
  fileKinds: ['xlsx'],

  detect(ctx) {
    if (!ctx.sheetNames || !ctx.sheetPreview) return false;

    // 1. Sheet name
    const hasSheet = ctx.sheetNames.some(
      (s) => normCell(s) === 'daily production report'
    );
    if (!hasSheet) return false;

    // 2. Row 0 title (short-circuit if the sheet name matched by coincidence
    // but the layout is something else entirely).
    const row0 = ctx.sheetPreview[0] || [];
    if (normCell(row0[0]) !== 'daily production report') return false;

    // 3. Header row somewhere in the first 20 rows with BOTH wellname
    // and gas flare. Scanning (rather than hardcoding index 4) protects
    // against future files that insert or remove metadata rows.
    for (let i = 0; i < Math.min(20, ctx.sheetPreview.length); i++) {
      const row = (ctx.sheetPreview[i] || []).map(normCell);
      const hasWellname = row.includes('wellname');
      const hasGasFlare = row.includes('gas flare');
      if (hasWellname && hasGasFlare) return true;
    }
    return false;
  },

  async parse(ctx) {
    const wb = XLSX.read(ctx.buffer, { type: 'buffer', cellDates: false });
    const sheetName = wb.SheetNames.find(
      (s) => normCell(s) === 'daily production report'
    );
    if (!sheetName) {
      throw new Error(
        'Frio Daily Production: expected a sheet named "Daily Production Report" but none found'
      );
    }
    const sheet = wb.Sheets[sheetName];

    // Full sheet as 2D array (detect() only saw the first 20 rows).
    const aoa = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      blankrows: false,
      raw: true,
    }) as (string | number | null)[][];

    // ─── Walk the top of the sheet for metadata (fieldname) AND find
    //     the real header row by its content, not its index. ───
    let headerIdx = -1;
    let fieldname: string | null = null;

    for (let i = 0; i < Math.min(25, aoa.length); i++) {
      const row = aoa[i] || [];
      const firstCell = normCell(row[0]);
      if (firstCell === 'fieldname') {
        const v = row[1];
        if (v != null && String(v).trim() !== '') {
          fieldname = String(v).trim();
        }
      }
      // Header row: starts with "wellname" AND contains "gas flare"
      // (defensive against a raw "Wellname" appearing as a label in
      // some other context).
      if (firstCell === 'wellname') {
        const row2 = row.map(normCell);
        if (row2.includes('gas flare')) {
          headerIdx = i;
          break;
        }
      }
    }
    if (headerIdx < 0) {
      throw new Error(
        'Frio Daily Production: header row (starts "Wellname", contains "Gas Flare") not found in first 25 rows'
      );
    }

    // Index each column by its header label.
    const header = (aoa[headerIdx] || []).map(normCell);
    const colWell = header.indexOf('wellname');
    const colOil = header.indexOf('oil production');
    const colGas = header.indexOf('gas production');
    const colFlare = header.indexOf('gas flare'); // may be present but optional
    const colWater = header.indexOf('water production');
    const colDate = header.indexOf('production date');

    if (colWell < 0 || colOil < 0 || colGas < 0 || colWater < 0 || colDate < 0) {
      throw new Error(
        `Frio Daily Production: required columns missing in header row ${headerIdx} — ` +
          `wellname=${colWell} oil=${colOil} gas=${colGas} water=${colWater} date=${colDate}`
      );
    }

    const records: ProductionRecord[] = [];
    let skippedNoDate = 0;
    let skippedNoName = 0;

    for (let i = headerIdx + 1; i < aoa.length; i++) {
      const row = aoa[i] || [];
      const rawName = row[colWell];

      // Blank well name → end of data or padding row → skip.
      if (rawName == null || String(rawName).trim() === '') {
        skippedNoName++;
        continue;
      }
      const wellName = String(rawName).trim();

      // Defensive: skip accidental header-repeat / summary rows.
      const nameLower = wellName.toLowerCase();
      if (
        nameLower === 'wellname' ||
        nameLower === 'total' ||
        nameLower.startsWith('grand total')
      ) {
        continue;
      }

      const prodDate = cellToIsoDate(row[colDate]);
      if (!prodDate) {
        // Can't build a record without a date — skip but DON'T throw
        // (one malformed row shouldn't kill the whole report).
        skippedNoDate++;
        continue;
      }

      const oilProd = toNumOrNull(row[colOil]);
      const gasProd = toNumOrNull(row[colGas]);
      const waterProd = toNumOrNull(row[colWater]);
      const gasFlare = colFlare >= 0 ? toNumOrNull(row[colFlare]) : null;

      const extraFields: Record<string, unknown> = {};
      if (gasFlare != null) extraFields.gasFlare = gasFlare;
      if (fieldname) extraFields.fieldname = fieldname;

      records.push({
        api14: '',
        api10: '',
        wellName,
        combocurveWellId: null,
        operatorWellId: null,
        prodDate,
        oilProd,
        gasProd,
        waterProd,
        gasSales: null,
        oilSales: null,
        waterInj: null,
        daysOn: null,
        choke: null,
        tubingPres: null,
        casingPres: null,
        hoursDown: null,
        downtimeReason: null,
        extraFields,
      });
    }

    if (records.length === 0) {
      throw new Error(
        `Frio Daily Production: parsed 0 records (skippedNoName=${skippedNoName}, skippedNoDate=${skippedNoDate}). ` +
          'Sheet found, header found — but every data row was blank or missing a date.'
      );
    }

    return records;
  },
};
