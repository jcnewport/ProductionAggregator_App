/**
 * Production Storage Service
 * ---------------------------
 * Takes parsed ProductionRecord[] from any parser and persists them to Supabase.
 *
 * Responsibilities:
 *   - Upsert the operator (so we have a stable operator_id FK)
 *   - Upsert each well by API10 (so production rows join to a single well row)
 *   - Upsert production_monthly / production_daily rows keyed on (well_id, prod_date)
 *   - Link back to the source email + source file for audit trail
 *
 * Design notes:
 *   - We use upsert so re-processing the same email is idempotent (no duplicate rows).
 *   - Negative production values are preserved as-is (they represent valid accounting
 *     corrections in oil & gas — see project_instructions).
 */

import { supabase } from './supabase.js';
import type { ProductionRecord } from '../parsers/pdsAnadarkoMonthly.js';

export interface StorageContext {
  sourceEmailId: string;      // email_log.id (UUID)
  sourceFileName: string;     // Original attachment filename
  sourceStoragePath: string;  // Path in Supabase Storage
  operatorName: string;       // From the parser outcome
}

/**
 * Upsert an operator by name. Returns its UUID.
 */
async function upsertOperator(operatorName: string): Promise<string> {
  const { data: existing } = await supabase
    .from('operators')
    .select('id')
    .eq('name', operatorName)
    .maybeSingle();

  if (existing) return existing.id;

  const { data, error } = await supabase
    .from('operators')
    .insert({ name: operatorName })
    .select('id')
    .single();

  if (error) throw new Error(`Failed to create operator "${operatorName}": ${error.message}`);
  return data.id;
}

/**
 * Look up the ComboCurve Well ID (chosen_id) for a given API10 in the
 * combocurve_wells catalog. Returns null if the well isn't in the catalog
 * yet — that's fine, we'll just leave combocurve_well_id null and a future
 * catalog refresh + backfill can close the gap.
 *
 * Why we do this every insert instead of relying on the parser: most
 * operator reports don't include the ComboCurve Well ID at all (it's
 * an internal identifier). Centralizing the lookup here means EVERY
 * parser benefits without each one needing its own join logic.
 */
async function lookupCombocurveWellId(api10: string): Promise<number | null> {
  const { data, error } = await supabase
    .from('combocurve_wells')
    .select('chosen_id')
    .eq('api10', api10)
    .maybeSingle();
  if (error) {
    // Log but don't throw — a missing catalog match is an enrichment gap,
    // not a blocker. The well row will still get created with null id.
    console.warn(`[productionStorage] combocurve_wells lookup for api10=${api10} failed: ${error.message}`);
    return null;
  }
  return data?.chosen_id ?? null;
}

/**
 * Upsert a well by API10. Returns its UUID.
 * Matching strategy: API10 is the authoritative key (unique constraint in DB).
 * If the well name drifts between reports, we keep the first-seen name but track
 * the alias in well_name_aliases (Phase 2).
 *
 * Catalog enrichment: on insert, AND on existing rows where combocurve_well_id
 * is null, we look up chosen_id from combocurve_wells and populate the column.
 * This keeps the 16-col ComboCurve export's "Well ID" field filled in
 * automatically as the catalog grows — no manual reconciliation step.
 */
async function upsertWell(
  record: ProductionRecord,
  operatorId: string
): Promise<string> {
  const { data: existing } = await supabase
    .from('wells')
    .select('id, well_name, combocurve_well_id')
    .eq('api10', record.api10)
    .maybeSingle();

  if (existing) {
    // If the name differs, track the alias for fuzzy matching later
    if (existing.well_name !== record.wellName) {
      await supabase
        .from('well_name_aliases')
        .upsert(
          {
            alias: record.wellName,
            well_id: existing.id,
            source: 'auto-detected-during-import',
          },
          { onConflict: 'alias', ignoreDuplicates: true }
        );
    }
    // Backfill combocurve_well_id opportunistically — if this well was created
    // before the catalog had it, but the catalog has it now, close the gap.
    if (existing.combocurve_well_id === null || existing.combocurve_well_id === undefined) {
      const ccId = await lookupCombocurveWellId(record.api10);
      if (ccId !== null) {
        const { error } = await supabase
          .from('wells')
          .update({ combocurve_well_id: ccId })
          .eq('id', existing.id);
        if (error) {
          console.warn(
            `[productionStorage] Failed to backfill combocurve_well_id for well ${record.api10}: ${error.message}`
          );
        }
      }
    }
    return existing.id;
  }

  // New well — enrich with the catalog lookup BEFORE the insert so the
  // ID lands on row creation (saves a round-trip and avoids a transient
  // null state that a concurrent export could pick up).
  const combocurveWellId = await lookupCombocurveWellId(record.api10);

  const { data, error } = await supabase
    .from('wells')
    .insert({
      well_name: record.wellName,
      api10: record.api10,
      api14: record.api14,
      operator_id: operatorId,
      combocurve_well_id: combocurveWellId,
    })
    .select('id')
    .single();

  if (error) throw new Error(`Failed to create well ${record.api10}: ${error.message}`);
  return data.id;
}

/**
 * Convert a ProductionRecord into the DB row shape.
 */
function toRowShape(
  record: ProductionRecord,
  wellId: string,
  operatorId: string,
  context: StorageContext
) {
  return {
    well_id: wellId,
    well_name: record.wellName,
    api14: record.api14,
    api10: record.api10,
    combocurve_well_id: record.combocurveWellId,
    prod_date: record.prodDate,
    gas_prod: record.gasProd,
    gas_sales: record.gasSales,
    oil_prod: record.oilProd,
    oil_sales: record.oilSales,
    water_prod: record.waterProd,
    choke: record.choke,
    tubing_pres: record.tubingPres,
    casing_pres: record.casingPres,
    hours_down: record.hoursDown,
    water_inj: record.waterInj,
    downtime_reason: record.downtimeReason,
    days_on: record.daysOn,
    operator_id: operatorId,
    source_email_id: context.sourceEmailId,
    source_file_name: context.sourceFileName,
    extra_fields: {
      ...record.extraFields,
      sourceStoragePath: context.sourceStoragePath,
    },
  };
}

/**
 * Store monthly production records. Upserts on (well_id, prod_date).
 */
export async function storeMonthlyRecords(
  records: ProductionRecord[],
  context: StorageContext
): Promise<{ inserted: number; operatorId: string }> {
  if (records.length === 0) return { inserted: 0, operatorId: '' };

  const operatorId = await upsertOperator(context.operatorName);

  // Upsert all wells first (in parallel-ish — but serialize to avoid race on API10 unique)
  const uniqueByApi10 = new Map<string, ProductionRecord>();
  for (const r of records) uniqueByApi10.set(r.api10, r);

  const apiToWellId = new Map<string, string>();
  for (const rec of uniqueByApi10.values()) {
    const wellId = await upsertWell(rec, operatorId);
    apiToWellId.set(rec.api10, wellId);
  }

  // Build rows
  const rows = records.map((r) => toRowShape(r, apiToWellId.get(r.api10)!, operatorId, context));

  // Chunked upsert — Supabase default row limit per request is ~1000; keep us safely below
  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error, count } = await supabase
      .from('production_monthly')
      .upsert(chunk, { onConflict: 'well_id,prod_date', count: 'exact' });
    if (error) throw new Error(`Monthly upsert failed: ${error.message}`);
    inserted += count ?? chunk.length;
  }

  return { inserted, operatorId };
}

/**
 * Same as storeMonthlyRecords but writes to production_daily.
 * Daily data is NEVER rolled up into monthly per project rules.
 */
export async function storeDailyRecords(
  records: ProductionRecord[],
  context: StorageContext
): Promise<{ inserted: number; operatorId: string }> {
  if (records.length === 0) return { inserted: 0, operatorId: '' };

  const operatorId = await upsertOperator(context.operatorName);
  const uniqueByApi10 = new Map<string, ProductionRecord>();
  for (const r of records) uniqueByApi10.set(r.api10, r);

  const apiToWellId = new Map<string, string>();
  for (const rec of uniqueByApi10.values()) {
    const wellId = await upsertWell(rec, operatorId);
    apiToWellId.set(rec.api10, wellId);
  }

  const rows = records.map((r) => toRowShape(r, apiToWellId.get(r.api10)!, operatorId, context));

  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error, count } = await supabase
      .from('production_daily')
      .upsert(chunk, { onConflict: 'well_id,prod_date', count: 'exact' });
    if (error) throw new Error(`Daily upsert failed: ${error.message}`);
    inserted += count ?? chunk.length;
  }

  return { inserted, operatorId };
}
