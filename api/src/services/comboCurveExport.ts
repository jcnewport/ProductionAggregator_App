/**
 * ComboCurve Export Service
 * ---------------------------------------------------------------
 * Generates XLSX files in the exact 16-column ComboCurve Production
 * Template format used by Stewardship.IS / Frio Energy Holdings I.
 *
 * Column order locked in from client's `ComboCurve_Prod_Template.csv`
 * sample (2026-04). Per Kyle Parker (client) 2026-04-20:
 *   "Our Chosen ID is API10. The Chosen ID maps all data into CC,
 *    making it the critical number here."
 * So column 1 "Well ID" = Chosen ID = API10 as integer.
 * Column 4 "API10" = the same value, but as 10-character text (preserving
 *   leading zeros — important for certain states where API10 begins with "0").
 *
 * Output works for BOTH monthly and daily exports — identical column structure,
 * only the source table changes and the prod_date granularity differs.
 */

import * as XLSX from 'xlsx';
import { supabase } from './supabase.js';

// ─── Column Spec (exactly matches the client's ComboCurve_Prod_Template.csv) ───
export const COMBOCURVE_HEADERS: readonly string[] = [
  'Well ID',          // 1  — Chosen ID = API10 as integer (bigint)
  'Well Name',        // 2
  'API14',            // 3  — 14-char text
  'API10',            // 4  — 10-char text (leading zeros preserved)
  'Prod Date',        // 5  — M/D/YYYY, no zero padding
  'Gas Prod',         // 6  — MCF
  'Gas Sales',        // 7  — MCF
  'Oil Prod',         // 8  — BBL
  'Oil Sales',        // 9  — BBL
  'Water Prod',       // 10 — BBL
  'Choke',            // 11
  'Tubing Pres.',     // 12 — WITH trailing period (matches template exactly)
  'Casing Pres',      // 13 — NO trailing period (matches template exactly)
  'Hours Down',       // 14
  'Water\nInj',       // 15 — two-line header (literal newline inside the cell)
  'Downtime Reason',  // 16
];

export type ExportType = 'monthly' | 'daily';

export interface ExportFilters {
  /** YYYY-MM-DD (inclusive) */
  startDate: string;
  /** YYYY-MM-DD (inclusive) */
  endDate: string;
  /** Optional: restrict to one or more operator UUIDs */
  operatorIds?: string[];
  /** Optional: restrict to one or more well UUIDs */
  wellIds?: string[];
}

/**
 * Format a YYYY-MM-DD (ISO) date string as M/D/YYYY — no zero padding, matching
 * the ComboCurve sample template exactly. Works without pulling in a date lib.
 */
export function formatMdYyyy(isoDate: string): string {
  // isoDate looks like "2026-02-01" (or "2026-02-01T00:00:00Z" — slice off time if present)
  const datePart = isoDate.substring(0, 10);
  const [yyyy, mm, dd] = datePart.split('-');
  const month = String(parseInt(mm, 10));   // strip leading zero
  const day = String(parseInt(dd, 10));     // strip leading zero
  return `${month}/${day}/${yyyy}`;
}

/**
 * Normalize a numeric-ish DB value. DECIMAL columns come back as strings from
 * supabase-js by default. We return null for empty/nullish, else Number().
 * Numbers are kept as numbers (not formatted strings) so Excel treats them as data.
 */
function asNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Database row shape — matches columns we SELECT from production_monthly/_daily.
 * We also LEFT JOIN wells to pick up combocurve_well_id (Chosen ID) since the
 * production_monthly table's own combocurve_well_id is not always populated
 * at parse-time (parser sets null; it's resolved by the backfill).
 */
export interface ProductionQueryRow {
  prod_date: string;
  well_name: string | null;
  api14: string | null;
  api10: string | null;
  gas_prod: string | number | null;
  gas_sales: string | number | null;
  oil_prod: string | number | null;
  oil_sales: string | number | null;
  water_prod: string | number | null;
  choke: string | null;
  tubing_pres: string | number | null;
  casing_pres: string | number | null;
  hours_down: string | number | null;
  water_inj: string | number | null;
  downtime_reason: string | null;
  // supabase-js returns FK joins as an array when the relationship isn't
  // statically declared as one-to-one. Treat it as an array and pick [0].
  wells?:
    | {
        combocurve_well_id: number | null;
        well_name: string | null;
        api14: string | null;
        api10: string | null;
      }
    | {
        combocurve_well_id: number | null;
        well_name: string | null;
        api14: string | null;
        api10: string | null;
      }[]
    | null;
}

/** Given a production row, return the joined wells row (or null) regardless of shape. */
function pickWellsJoin(row: ProductionQueryRow) {
  const w = row.wells;
  if (!w) return null;
  if (Array.isArray(w)) return w[0] ?? null;
  return w;
}

/**
 * Query production rows for export. Joins wells so we can pull combocurve_well_id
 * (the Chosen ID = API10 as bigint) which is column 1 in the export.
 */
async function queryProduction(
  type: ExportType,
  filters: ExportFilters
): Promise<ProductionQueryRow[]> {
  const table = type === 'monthly' ? 'production_monthly' : 'production_daily';

  let query = supabase
    .from(table)
    .select(
      `
      prod_date,
      well_name,
      api14,
      api10,
      gas_prod,
      gas_sales,
      oil_prod,
      oil_sales,
      water_prod,
      choke,
      tubing_pres,
      casing_pres,
      hours_down,
      water_inj,
      downtime_reason,
      wells:well_id (
        combocurve_well_id,
        well_name,
        api14,
        api10
      )
    `
    )
    .gte('prod_date', filters.startDate)
    .lte('prod_date', filters.endDate)
    .order('prod_date', { ascending: true })
    .order('well_name', { ascending: true });

  if (filters.operatorIds && filters.operatorIds.length > 0) {
    query = query.in('operator_id', filters.operatorIds);
  }
  if (filters.wellIds && filters.wellIds.length > 0) {
    query = query.in('well_id', filters.wellIds);
  }

  // Bump default limit — Supabase caps at 1000 rows per select by default.
  // For an 11-well, 3-year monthly export that's ~400 rows; for daily over a year
  // it's ~4,000 rows. Set the range generously.
  query = query.range(0, 99999);

  const { data, error } = await query;
  if (error) throw new Error(`Export query failed: ${error.message}`);

  return (data ?? []) as ProductionQueryRow[];
}

/**
 * Convert a DB row into the 16-cell array for the spreadsheet row.
 * Cell types are explicit so numbers render as numbers and API10 stays a string
 * (so leading zeros don't get eaten by Excel).
 */
export function toRowCells(row: ProductionQueryRow): (string | number | null)[] {
  const wellsJoin = pickWellsJoin(row);

  // Prefer the wells.* values when available (authoritative; aligns with CC mapping).
  // Fall back to the production_monthly row's own columns if the join didn't resolve.
  const wellId = wellsJoin?.combocurve_well_id ?? null;
  const wellName = wellsJoin?.well_name ?? row.well_name ?? '';
  const api14 = wellsJoin?.api14 ?? row.api14 ?? '';
  const api10 = wellsJoin?.api10 ?? row.api10 ?? '';

  return [
    wellId,                        // 1  Well ID (number or null)
    wellName,                      // 2  Well Name
    api14,                         // 3  API14 (text)
    api10,                         // 4  API10 (text, leading zeros)
    formatMdYyyy(row.prod_date),   // 5  Prod Date M/D/YYYY
    asNum(row.gas_prod),           // 6
    asNum(row.gas_sales),          // 7
    asNum(row.oil_prod),           // 8
    asNum(row.oil_sales),          // 9
    asNum(row.water_prod),         // 10
    row.choke ?? null,             // 11
    asNum(row.tubing_pres),        // 12
    asNum(row.casing_pres),        // 13
    asNum(row.hours_down),         // 14
    asNum(row.water_inj),          // 15
    row.downtime_reason ?? null,   // 16
  ];
}

/**
 * Build an XLSX workbook from an array of 16-cell data rows + header row.
 * Sets column widths and forces API14/API10 to text cells so Excel doesn't
 * convert them to scientific notation or drop leading zeros.
 */
export function buildWorkbook(
  dataRows: (string | number | null)[][],
  sheetName: string
): XLSX.WorkBook {
  // Row 0: headers. Rows 1+: data.
  const aoa: (string | number | null)[][] = [
    [...COMBOCURVE_HEADERS],
    ...dataRows,
  ];

  const sheet = XLSX.utils.aoa_to_sheet(aoa);

  // Force API14 (col C) and API10 (col D) to text so Excel preserves leading zeros
  // and doesn't rewrite 14-digit values into scientific notation.
  const forceTextCols = ['C', 'D']; // API14, API10
  for (let r = 1; r <= dataRows.length; r++) {
    for (const col of forceTextCols) {
      const ref = `${col}${r + 1}`;
      const cell = sheet[ref];
      if (cell && cell.v !== null && cell.v !== undefined && cell.v !== '') {
        cell.t = 's';
        cell.v = String(cell.v);
        cell.z = '@'; // "text" number format
      }
    }
  }

  // Note on the "Water\nInj" two-line header (column O, row 1):
  // The actual newline character IS in the cell value (verified with openpyxl),
  // which is what matters for ComboCurve's import parsing. However, the open-source
  // `xlsx` (SheetJS CE) build strips cell-level style attributes like wrap_text on
  // write, so Excel will display the cell with the newline but without auto-wrapping
  // the row height unless the user toggles "Wrap Text" manually. Cosmetic only; if we
  // need true styling we can swap to `xlsx-js-style` (drop-in fork) in a follow-up.

  // Column widths (characters) — tuned for readability at a glance
  sheet['!cols'] = [
    { wch: 10 }, // Well ID
    { wch: 30 }, // Well Name
    { wch: 16 }, // API14
    { wch: 12 }, // API10
    { wch: 11 }, // Prod Date
    { wch: 10 }, // Gas Prod
    { wch: 10 }, // Gas Sales
    { wch: 10 }, // Oil Prod
    { wch: 10 }, // Oil Sales
    { wch: 11 }, // Water Prod
    { wch: 8 },  // Choke
    { wch: 12 }, // Tubing Pres.
    { wch: 11 }, // Casing Pres
    { wch: 11 }, // Hours Down
    { wch: 8 },  // Water\nInj
    { wch: 24 }, // Downtime Reason
  ];

  // Taller row for the wrapped "Water\nInj" header
  sheet['!rows'] = [{ hpt: 28 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, sheetName);
  return wb;
}

/**
 * Generate a ComboCurve-format export and return the XLSX as a Buffer.
 *   type     = 'monthly' | 'daily'  (pulls from production_monthly or production_daily)
 *   filters  = { startDate, endDate, operatorIds?, wellIds? } — all inclusive
 */
export async function generateComboCurveExport(
  type: ExportType,
  filters: ExportFilters
): Promise<{ buffer: Buffer; rowCount: number; wellCount: number }> {
  const rows = await queryProduction(type, filters);

  const dataRows = rows.map(toRowCells);
  const uniqueWells = new Set(
    rows.map((r) => pickWellsJoin(r)?.api10 ?? r.api10 ?? '').filter((s) => s !== '')
  );

  const sheetName = type === 'monthly' ? 'Monthly Production' : 'Daily Production';
  const wb = buildWorkbook(dataRows, sheetName);

  // Write options:
  //   - type: 'buffer'   → return raw bytes (so we can stream to the HTTP response)
  //   - bookType: 'xlsx' → modern Excel format
  //   - compression: true → smaller files; required to avoid some Mac Excel quirks
  //   - cellStyles is intentionally OMITTED. When enabled, SheetJS writes a
  //     customUI14.xml fragment with an `mso:AutoSaveSwitch` control Excel for Mac
  //     doesn't recognize, which pops an "Error Loading Custom UI XML" dialog on
  //     first open. The file itself is valid; the dialog is cosmetic but alarming.
  //     We don't rely on cell styles anyway (SheetJS CE strips wrap_text on write).
  const buffer: Buffer = XLSX.write(wb, {
    type: 'buffer',
    bookType: 'xlsx',
    compression: true,
  });

  return {
    buffer,
    rowCount: dataRows.length,
    wellCount: uniqueWells.size,
  };
}
