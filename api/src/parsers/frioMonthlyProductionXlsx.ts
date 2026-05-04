/**
 * Format 12 — Frio Monthly Production XLSX ("Monthly Production for Sendout")
 * ---------------------------------------------------------------------------
 * Field-centric monthly snapshot covering many wells in a single field for
 * a single production month. Arrives on the email subject line pattern
 * "Fwd: Frio Monthly Production (Monthly Production for Sendout) a/o YYYY-MM-DD".
 *
 * This is the MONTHLY twin of Format 11 (Frio Daily Production XLSX). Both
 * are emitted by Frio's WEnergy / Joyn Analytics platform (originator
 * "Joynapp@wenergysoftware.com", forwarded by adavis@frioenergypartners.com).
 *
 * Sheet shape (single sheet, name = "Monthly Production for Sendout"):
 *
 *   Row 0 : "Monthly Production for Sendout"               (title)
 *   Row 1 : "Hierarchy"        | "Well Hierarchy"
 *   Row 2 : "Fieldname"        | <FIELD NAME>              (e.g. NORTH HARPOON)
 *   Row 3 : "Production Month" | "<Range Label>"           (e.g. "Last Month (Apr-2026 to Apr-2026)")
 *   Row 4 : (blank)
 *   Row 5 : HEADER — Production Month | Wellname | Oil Production |
 *                    Gas Production | Water Production       (5 cols, NO Gas Flare)
 *   Row 6+: data — one row per well; Production Month is a real datetime
 *           (typically first-of-month, e.g. 2026-04-01)
 *
 * Differences vs the Daily sibling (Format 11):
 *   - 5 columns vs 6 — Daily has an extra "Gas Flare" column the Monthly
 *     report does not emit. Detection here REQUIRES "Gas Flare" to be
 *     ABSENT (positive: requires the "Production Month" header label).
 *   - Header label is "Production Month" (Daily uses "Production Date").
 *   - Sheet name is "Monthly Production for Sendout" (Daily uses
 *     "Daily Production Report").
 *   - Date is already first-of-month — no normalization needed.
 *   - Column ORDER: date is column 0 (Daily puts date last).
 *
 * Same-as-Daily quirks the adapter handles:
 *   - NO API column. Downstream `well_name_aliases` lookup resolves wells
 *     by name (same pattern as BTA Daily XLSX, Hierarchical Monthly Report,
 *     and Frio Daily Production).
 *   - NO Sales columns. oilSales / gasSales stored as null — NOT 0.
 *   - NO pressure / choke / hours-down / downtime data. All null.
 *   - Fieldname (from row 2) preserved in extraFields.fieldname.
 *   - Production Month arrives as either a JS Date (cellDates: true path) or
 *     an Excel serial — both handled.
 *   - Rows where Wellname is blank are skipped silently (trailing padding).
 *   - "Wellname" repeats / "Total"/"Grand Total" rows filtered by name check.
 *
 * Detection signature (all four must hold — keeps the detect tight and
 * mutually exclusive vs Format 11):
 *   1. Sheet named "Monthly Production for Sendout" (case-insensitive).
 *   2. Row-0 title cell = "Monthly Production for Sendout".
 *   3. Header row (scanned in first 25 rows) contains BOTH "Wellname" and
 *      "Production Month" — Production Month at the header level uniquely
 *      identifies this format in our registry.
 *   4. Header row does NOT contain "Gas Flare" — anti-collision guard with
 *      the Daily sibling, in case a future Monthly file ever picks up the
 *      "Daily Production Report" sheet name by mistake.
 */

import * as XLSX from 'xlsx';
import type { FormatAdapter, ProductionRecord } from './types.js';

/* ────────────────────────────────────────────────────────────────
 * Small helpers (kept local — these mirror the Daily adapter's
 * helpers so the two siblings stay easy to compare side-by-side).
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

/** Convert an Excel serial OR date-string OR JS Date cell to a YYYY-MM-DD ISO date. */
function cellToIsoDate(cell: unknown): string | null {
  // JS Date — only happens if upstream reads with cellDates:true. We read with
  // cellDates:false in parse() to be deterministic, but be defensive.
  if (cell instanceof Date && !isNaN(cell.getTime())) {
    const y = cell.getUTCFullYear();
    const m = cell.getUTCMonth() + 1;
    const d = cell.getUTCDate();
    return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  if (typeof cell === 'number' && Number.isFinite(cell)) {
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
    // YYYY-MM-DD or YYYY-MM-DD HH:MM:SS
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    // "Apr-2026" / "Apr 2026" — accept and normalize to first-of-month.
    const monthYear = s.match(
      /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s-]+(\d{4})$/i
    );
    if (monthYear) {
      const monthIdx =
        ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(
          monthYear[1].toLowerCase()
        ) + 1;
      return `${monthYear[2]}-${String(monthIdx).padStart(2, '0')}-01`;
    }
  }
  return null;
}

/** Force a date to first-of-month (YYYY-MM-01). Monthly grain — keeps the
 *  database key stable even if the source ever ships mid-month or
 *  end-of-month dates. */
function toFirstOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

/* ────────────────────────────────────────────────────────────────
 * The adapter.
 * ──────────────────────────────────────────────────────────────── */
export const frioMonthlyProductionXlsxAdapter: FormatAdapter = {
  name: 'Frio Monthly Production XLSX',
  operatorName: 'Frio Energy Holdings (Monthly Report)',
  dataType: 'monthly',
  fileKinds: ['xlsx'],

  detect(ctx) {
    if (!ctx.sheetNames || !ctx.sheetPreview) return false;

    // 1. Sheet name
    const hasSheet = ctx.sheetNames.some(
      (s) => normCell(s) === 'monthly production for sendout'
    );
    if (!hasSheet) return false;

    // 2. Row 0 title
    const row0 = ctx.sheetPreview[0] || [];
    if (normCell(row0[0]) !== 'monthly production for sendout') return false;

    // 3. Header row in first 25 rows: must have BOTH "wellname" and
    //    "production month", and must NOT have "gas flare" (anti-collision
    //    with the Daily sibling).
    for (let i = 0; i < Math.min(25, ctx.sheetPreview.length); i++) {
      const row = (ctx.sheetPreview[i] || []).map(normCell);
      const hasWellname = row.includes('wellname');
      const hasProdMonth = row.includes('production month');
      const hasGasFlare = row.includes('gas flare');
      if (hasWellname && hasProdMonth && !hasGasFlare) return true;
    }
    return false;
  },

  async parse(ctx) {
    const wb = XLSX.read(ctx.buffer, { type: 'buffer', cellDates: false });
    const sheetName = wb.SheetNames.find(
      (s) => normCell(s) === 'monthly production for sendout'
    );
    if (!sheetName) {
      throw new Error(
        'Frio Monthly Production: expected a sheet named "Monthly Production for Sendout" but none found'
      );
    }
    const sheet = wb.Sheets[sheetName];

    // Full sheet as 2D array (detect() only saw the first 20 rows).
    const aoa = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      blankrows: false,
      raw: true,
    }) as (string | number | null)[][];

    // ─── Walk top of sheet for fieldname metadata AND find header row. ───
    let headerIdx = -1;
    let fieldname: string | null = null;

    for (let i = 0; i < Math.min(30, aoa.length); i++) {
      const row = aoa[i] || [];
      const firstCell = normCell(row[0]);
      if (firstCell === 'fieldname') {
        const v = row[1];
        if (v != null && String(v).trim() !== '') {
          fieldname = String(v).trim();
        }
      }
      // Header row: contains "Production Month" AND "Wellname" AND no "Gas Flare".
      // We anchor on the first cell being "production month" because that's the
      // canonical ordering observed; the AND-checks below are belt-and-braces.
      if (firstCell === 'production month') {
        const row2 = row.map(normCell);
        if (row2.includes('wellname') && !row2.includes('gas flare')) {
          headerIdx = i;
          break;
        }
      }
    }
    if (headerIdx < 0) {
      throw new Error(
        'Frio Monthly Production: header row (starts "Production Month", contains "Wellname", lacks "Gas Flare") not found in first 30 rows'
      );
    }

    // Index each column by its header label.
    const header = (aoa[headerIdx] || []).map(normCell);
    const colDate = header.indexOf('production month');
    const colWell = header.indexOf('wellname');
    const colOil = header.indexOf('oil production');
    const colGas = header.indexOf('gas production');
    const colWater = header.indexOf('water production');

    if (
      colDate < 0 ||
      colWell < 0 ||
      colOil < 0 ||
      colGas < 0 ||
      colWater < 0
    ) {
      throw new Error(
        `Frio Monthly Production: required columns missing in header row ${headerIdx} — ` +
          `date=${colDate} wellname=${colWell} oil=${colOil} gas=${colGas} water=${colWater}`
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

      // Defensive: skip header repeats / summary rows.
      const nameLower = wellName.toLowerCase();
      if (
        nameLower === 'wellname' ||
        nameLower === 'total' ||
        nameLower.startsWith('grand total')
      ) {
        continue;
      }

      const isoDate = cellToIsoDate(row[colDate]);
      if (!isoDate) {
        skippedNoDate++;
        continue;
      }
      // Monthly grain — collapse any mid/end-of-month dates to first-of-month.
      const prodDate = toFirstOfMonth(isoDate);

      const oilProd = toNumOrNull(row[colOil]);
      const gasProd = toNumOrNull(row[colGas]);
      const waterProd = toNumOrNull(row[colWater]);

      const extraFields: Record<string, unknown> = {};
      if (fieldname) extraFields.fieldname = fieldname;
      // Preserve raw source date when it differed from first-of-month — useful
      // if the report ever ships end-of-month dates and we want to audit.
      if (isoDate !== prodDate) extraFields.rawProdDate = isoDate;

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
        `Frio Monthly Production: parsed 0 records (skippedNoName=${skippedNoName}, skippedNoDate=${skippedNoDate}). ` +
          'Sheet found, header found — but every data row was blank or missing a date.'
      );
    }

    return records;
  },
};
