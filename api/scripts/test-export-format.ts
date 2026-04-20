/**
 * Offline smoke test for the ComboCurve export formatter.
 *
 * Feeds synthetic rows (shaped like real Supabase query results, values copied
 * from actual DB rows) into buildWorkbook() and writes an xlsx to disk.
 * We then inspect it with a Python/openpyxl check to confirm:
 *   - 16 columns in the exact right order
 *   - "Water\nInj" header contains an actual newline
 *   - API10 + API14 are TEXT cells (not numbers, not scientific)
 *   - Well ID is a number (bigint)
 *   - Prod Date is M/D/YYYY (no zero padding)
 *
 * Run with:   npx tsx scripts/test-export-format.ts
 */

import * as fs from 'node:fs';
import * as XLSX from 'xlsx';
import {
  buildWorkbook,
  toRowCells,
  type ProductionQueryRow,
} from '../src/services/comboCurveExport.js';

// Real-ish rows pulled from the live DB (2024-09 FLEA FLICKER pad)
const sampleRows: ProductionQueryRow[] = [
  {
    prod_date: '2024-09-01',
    well_name: 'FLEA FLICKER A 1BS',
    api14: '42301368360000',
    api10: '4230136836',
    gas_prod: '8042.9',
    gas_sales: '8042.9',
    oil_prod: '4268.42',
    oil_sales: '4268.42',
    water_prod: '43383.1',
    choke: null,
    tubing_pres: null,
    casing_pres: null,
    hours_down: null,
    water_inj: '0',
    downtime_reason: null,
    wells: {
      combocurve_well_id: 4230136836,
      well_name: 'FLEA FLICKER A 1BS',
      api14: '42301368360000',
      api10: '4230136836',
    },
  },
  {
    prod_date: '2024-09-01',
    well_name: 'FLEA FLICKER B 1WA',
    api14: '42301368370000',
    api10: '4230136837',
    gas_prod: '13676.7',
    gas_sales: '13676.7',
    oil_prod: '7640.47',
    oil_sales: '7640.47',
    water_prod: '41503',
    choke: null,
    tubing_pres: null,
    casing_pres: null,
    hours_down: null,
    water_inj: '0',
    downtime_reason: null,
    wells: {
      combocurve_well_id: 4230136837,
      well_name: 'FLEA FLICKER B 1WA',
      api14: '42301368370000',
      api10: '4230136837',
    },
  },
  // Simulate a row where wells comes back as an array (supabase-js default shape)
  {
    prod_date: '2026-03-01',
    well_name: 'FLEA FLICKER D 2BS',
    api14: '42301368390000',
    api10: '4230136839',
    gas_prod: '5123.45',
    gas_sales: null,
    oil_prod: '2101.99',
    oil_sales: null,
    water_prod: '9001.5',
    choke: '64/64',
    tubing_pres: '1234.5',
    casing_pres: '250',
    hours_down: '2.5',
    water_inj: null,
    downtime_reason: 'Lease outage',
    wells: [
      {
        combocurve_well_id: 4230136839,
        well_name: 'FLEA FLICKER D 2BS',
        api14: '42301368390000',
        api10: '4230136839',
      },
    ],
  },
];

const dataRows = sampleRows.map(toRowCells);
const wb = buildWorkbook(dataRows, 'Monthly Production');

// Write to an absolute /tmp path so we can inspect with python
const outPath = '/tmp/combocurve_export_test.xlsx';
const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellStyles: true });
fs.writeFileSync(outPath, buffer);

console.log(`Wrote ${dataRows.length} rows → ${outPath} (${buffer.length} bytes)`);
console.log('\nFirst row cells:');
console.log(dataRows[0]);
