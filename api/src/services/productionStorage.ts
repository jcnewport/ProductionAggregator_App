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
import { isValidApi10, normalizeAndValidateApi } from '../parsers/apiNormalization.js';

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
 * Dedupe rows by (well_id, prod_date) before sending to Supabase.
 *
 * Why this is needed:
 *   Postgres rejects an INSERT ... ON CONFLICT statement when the same
 *   conflict key appears twice in a single INSERT batch with the error
 *   "ON CONFLICT DO UPDATE command cannot affect row a second time".
 *   This would otherwise take down an entire email's import just because
 *   the source workbook had two rows for the same well on the same date
 *   (which happens legitimately — it's usually a correction, sometimes
 *   a parser quirk like reading a merged cell twice).
 *
 * Semantics:
 *   LAST record wins. This matches O&G accounting convention: when a
 *   workbook has the same well+date appearing twice, the second row is
 *   almost always an adjustment/correction meant to supersede the first.
 *   Same outcome you'd get if you ran two upserts sequentially.
 *
 * Observability:
 *   We log each dedupe event with the source filename + count so it
 *   shows up in Railway logs. If a file is producing HUNDREDS of dupes
 *   that's usually a parser bug and worth investigating; a handful of
 *   dupes per file is normal for many operator formats.
 */
interface WithConflictKey {
  well_id: string;
  prod_date: string;
  [k: string]: unknown;
}

function dedupeByWellDate<T extends WithConflictKey>(
  rows: T[],
  context: StorageContext,
  granularity: 'monthly' | 'daily'
): T[] {
  if (rows.length <= 1) return rows;
  const byKey = new Map<string, T>();
  let duplicates = 0;
  for (const row of rows) {
    const key = `${row.well_id}|${row.prod_date}`;
    if (byKey.has(key)) duplicates++;
    byKey.set(key, row); // last wins
  }
  if (duplicates > 0) {
    console.warn(
      `[productionStorage] Deduped ${duplicates} duplicate (well_id, prod_date) ${granularity} ` +
        `rows from "${context.sourceFileName}". ${rows.length} → ${byKey.size}. ` +
        `Last-row-wins. If this count is high, check the parser for row-emission bugs.`
    );
  }
  return Array.from(byKey.values());
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
 * Partition records into (valid, skipped) based on api10 validity.
 *
 * Why this is a storage-boundary concern:
 *   Parsers SHOULD emit only valid APIs, but we treat storage as the last
 *   line of defense. If a parser bug (or a new format we haven't hardened
 *   against yet) emits a malformed api10 like "0042301413" or "4230000000",
 *   we refuse to create a well for it — rather than polluting the wells
 *   table with garbage that has to be hand-cleaned later (as happened in
 *   Task #54 Phase B).
 *
 * Per project rule "never silently fail": we DO NOT abort the whole import
 * on one bad row. We log loudly (one line per reject, source file included)
 * so the issue surfaces in Railway logs, and the caller can count skipped.
 */
function partitionByValidApi10(
  records: ProductionRecord[],
  context: StorageContext,
  granularity: 'monthly' | 'daily'
): { valid: ProductionRecord[]; skipped: SkippedRecord[] } {
  const valid: ProductionRecord[] = [];
  const skipped: SkippedRecord[] = [];
  for (const r of records) {
    if (isValidApi10(r.api10)) {
      valid.push(r);
    } else {
      // Re-run the full normalize+validate to capture a human-readable reason.
      // (We already know it's invalid; we just want the "why" for the dashboard.)
      const validation = normalizeAndValidateApi(r.api10 || r.api14 || '');
      skipped.push({
        record: r,
        reason: validation.reason ?? 'invalid api10 (reason unknown)',
      });
    }
  }
  if (skipped.length > 0) {
    console.warn(
      `[productionStorage] Skipped ${skipped.length} ${granularity} records with invalid api10 ` +
        `from "${context.sourceFileName}". Sample: ` +
        skipped
          .slice(0, 3)
          .map(
            (s) =>
              `api10="${s.record.api10}" well="${s.record.wellName}" date=${s.record.prodDate} reason="${s.reason}"`
          )
          .join(' | ')
    );
  }
  return { valid, skipped };
}

/** A skipped record paired with the reason it failed validation. */
interface SkippedRecord {
  record: ProductionRecord;
  reason: string;
}

/**
 * Persist skipped rows to the `flagged_records` table so they surface on the
 * dashboard instead of being buried in Railway logs.
 *
 * Design notes:
 *   - Best-effort: a write failure here must NEVER break the main import.
 *     We catch + warn + return. The console.warn above is still the source
 *     of truth if the DB write happens to fail.
 *   - Chunked to stay well below Supabase's ~1000-row request cap.
 *   - `raw_fields` captures the ProductionRecord shape as JSONB so the
 *     reviewer has enough context to retry or hand-correct the row later,
 *     without needing to re-open the source file.
 */
async function writeFlaggedRecords(
  skipped: SkippedRecord[],
  context: StorageContext
): Promise<void> {
  if (skipped.length === 0) return;
  try {
    const rows = skipped.map(({ record, reason }) => ({
      email_log_id: context.sourceEmailId || null,
      source_file_name: context.sourceFileName,
      row_number: null, // parsers don't currently surface a row number
      reason,
      attempted_well_name: record.wellName || null,
      attempted_api10: record.api10 || null,
      attempted_api14: record.api14 || null,
      raw_fields: record as unknown as Record<string, unknown>,
    }));
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const { error } = await supabase.from('flagged_records').insert(chunk);
      if (error) {
        console.warn(
          `[productionStorage] Failed to persist ${chunk.length} flagged rows ` +
            `from "${context.sourceFileName}": ${error.message}`
        );
        return; // fail open — don't throw
      }
    }
  } catch (err) {
    console.warn(
      `[productionStorage] Unexpected error persisting flagged rows ` +
        `from "${context.sourceFileName}": ${(err as Error).message}`
    );
  }
}

/**
 * Store monthly production records. Upserts on (well_id, prod_date).
 */
export async function storeMonthlyRecords(
  records: ProductionRecord[],
  context: StorageContext
): Promise<{ inserted: number; skipped: number; operatorId: string }> {
  if (records.length === 0) return { inserted: 0, skipped: 0, operatorId: '' };

  const { valid: validRecords, skipped: skippedRecords } = partitionByValidApi10(
    records,
    context,
    'monthly'
  );
  // Persist flagged rows BEFORE the early-return so rejections still surface
  // on the dashboard even when the entire file was rejected.
  await writeFlaggedRecords(skippedRecords, context);
  if (validRecords.length === 0) {
    return { inserted: 0, skipped: skippedRecords.length, operatorId: '' };
  }

  const operatorId = await upsertOperator(context.operatorName);

  // Upsert all wells first (in parallel-ish — but serialize to avoid race on API10 unique)
  const uniqueByApi10 = new Map<string, ProductionRecord>();
  for (const r of validRecords) uniqueByApi10.set(r.api10, r);

  const apiToWellId = new Map<string, string>();
  for (const rec of uniqueByApi10.values()) {
    const wellId = await upsertWell(rec, operatorId);
    apiToWellId.set(rec.api10, wellId);
  }

  // Build rows
  const rawRows = validRecords.map((r) => toRowShape(r, apiToWellId.get(r.api10)!, operatorId, context));

  // Dedupe by (well_id, prod_date) BEFORE upsert — Postgres rejects an ON CONFLICT
  // batch that targets the same row twice. Last-row-wins matches O&G correction semantics.
  const rows = dedupeByWellDate(rawRows, context, 'monthly');

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

  return { inserted, skipped: skippedRecords.length, operatorId };
}

/**
 * Same as storeMonthlyRecords but writes to production_daily.
 * Daily data is NEVER rolled up into monthly per project rules.
 */
export async function storeDailyRecords(
  records: ProductionRecord[],
  context: StorageContext
): Promise<{ inserted: number; skipped: number; operatorId: string }> {
  if (records.length === 0) return { inserted: 0, skipped: 0, operatorId: '' };

  const { valid: validRecords, skipped: skippedRecords } = partitionByValidApi10(
    records,
    context,
    'daily'
  );
  // See storeMonthlyRecords comment — flagged rows are persisted up-front.
  await writeFlaggedRecords(skippedRecords, context);
  if (validRecords.length === 0) {
    return { inserted: 0, skipped: skippedRecords.length, operatorId: '' };
  }

  const operatorId = await upsertOperator(context.operatorName);
  const uniqueByApi10 = new Map<string, ProductionRecord>();
  for (const r of validRecords) uniqueByApi10.set(r.api10, r);

  const apiToWellId = new Map<string, string>();
  for (const rec of uniqueByApi10.values()) {
    const wellId = await upsertWell(rec, operatorId);
    apiToWellId.set(rec.api10, wellId);
  }

  const rawRows = validRecords.map((r) => toRowShape(r, apiToWellId.get(r.api10)!, operatorId, context));

  // Same dedupe rationale as storeMonthlyRecords — prevents ON CONFLICT crashes
  // when the source file has multiple rows for the same (well, day).
  const rows = dedupeByWellDate(rawRows, context, 'daily');

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

  return { inserted, skipped: skippedRecords.length, operatorId };
}
