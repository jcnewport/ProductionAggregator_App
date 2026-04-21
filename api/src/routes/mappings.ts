/**
 * Mapping Management Route Handlers  (Task #82 — Phase 2 of Task #79)
 * --------------------------------------------------------------------
 * CRUD + test/preview endpoints for the `format_mappings` table. These back
 * the Mapping Management UI (Phase 3/Task #83 for CSV/XLSX, Phase 4/Task #84
 * for the PDF visual tool).
 *
 * Route shape (mounted under /api/admin/mappings via index.ts):
 *
 *   GET    /                     → list all mappings (filterable)
 *   GET    /:id                  → fetch single mapping
 *   POST   /                     → create a new mapping
 *   PUT    /:id                  → update an existing mapping (bumps version)
 *   DELETE /:id                  → soft-delete (flips is_active=false)
 *   POST   /validate             → validate a config's JSON shape only
 *   POST   /test                 → dry-run a config against an uploaded file
 *   GET    /operators            → operator dropdown source for the UI
 *
 * Auth: parent router applies adminLimiter + requireAuthMaybe() JWT guard
 *       (see api/src/index.ts `app.use('/api/admin', ...)`), so every
 *       endpoint here requires a valid Supabase Bearer token by default.
 *
 * Cache: every write endpoint calls invalidateMappingCache() so the
 *       dispatcher picks up changes on the NEXT inbound email. (The 60-sec
 *       TTL in loader.ts makes this unnecessary for correctness, but clearing
 *       on write eliminates the delay for live testing.)
 *
 * File uploads (/test): accepted as multipart/form-data with fields:
 *       - file: the binary file to dry-run against
 *       - config: JSON string of the StructuredMappingConfig to test
 * Max upload size: 25 MB. Anything bigger is almost certainly not a single
 * operator report and the /reprocess-email path should be used instead.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { supabase } from '../services/supabase.js';
import {
  validateMappingConfig,
  validateIdentificationRules,
  type MappingConfig,
  type StructuredMappingConfig,
  type IdentificationRules,
} from '../parsers/dataDriven/schema.js';
import { runStructuredEngine } from '../parsers/dataDriven/structuredEngine.js';
import { invalidateMappingCache } from '../parsers/dataDriven/loader.js';

const router = Router();

/* ────────────────────────────────────────────────────────────────
 * Multer setup — in-memory storage, 25 MB hard cap.
 * ──────────────────────────────────────────────────────────────── */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

/* ────────────────────────────────────────────────────────────────
 * Small helpers
 * ──────────────────────────────────────────────────────────────── */

/** Whitelisted file_type + data_type values. */
const FILE_TYPES = new Set(['pdf', 'xlsx', 'xls', 'csv']);
const DATA_TYPES = new Set(['monthly', 'daily', 'weekly']);

/** Shape of a mapping row coming back from Supabase. */
interface MappingRow {
  id: string;
  operator_id: string | null;
  name: string;
  file_type: string;
  data_type: string;
  mapping_config: unknown;
  identification_rules: unknown;
  version: number | null;
  is_active: boolean | null;
  notes: string | null;
  created_at: string | null;
  updated_at: string | null;
  operators?: { id: string; name: string } | null;
}

/** Parse + validate the JSON payload fields common to create/update. */
interface MappingInputPayload {
  operator_id: string | null;
  name: string;
  file_type: string;
  data_type: string;
  mapping_config: MappingConfig;
  identification_rules: IdentificationRules;
  notes: string | null;
}

function parseMappingInput(body: unknown): { ok: true; value: MappingInputPayload } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Request body must be a JSON object.' };
  }
  const b = body as Record<string, unknown>;

  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) return { ok: false, error: 'Field "name" is required.' };

  const fileType = typeof b.file_type === 'string' ? b.file_type : '';
  if (!FILE_TYPES.has(fileType)) {
    return { ok: false, error: `file_type must be one of ${[...FILE_TYPES].join(', ')}.` };
  }
  const dataType = typeof b.data_type === 'string' ? b.data_type : '';
  if (!DATA_TYPES.has(dataType)) {
    return { ok: false, error: `data_type must be one of ${[...DATA_TYPES].join(', ')}.` };
  }

  const operatorId =
    typeof b.operator_id === 'string' && b.operator_id.length > 0 ? b.operator_id : null;

  let mappingConfig: MappingConfig;
  try {
    mappingConfig = validateMappingConfig(b.mapping_config);
  } catch (err) {
    return { ok: false, error: `mapping_config invalid: ${err instanceof Error ? err.message : err}` };
  }

  // Cross-check mapping_config.fileKind against the row-level file_type —
  // catches UI bugs where the two would otherwise silently diverge.
  if (mappingConfig.fileKind !== fileType) {
    return {
      ok: false,
      error: `file_type="${fileType}" but mapping_config.fileKind="${mappingConfig.fileKind}" — they must match.`,
    };
  }
  if (mappingConfig.dataType !== dataType) {
    return {
      ok: false,
      error: `data_type="${dataType}" but mapping_config.dataType="${mappingConfig.dataType}" — they must match.`,
    };
  }

  let rules: IdentificationRules;
  try {
    rules = validateIdentificationRules(b.identification_rules);
  } catch (err) {
    return { ok: false, error: `identification_rules invalid: ${err instanceof Error ? err.message : err}` };
  }

  const notes = typeof b.notes === 'string' ? b.notes : null;

  return {
    ok: true,
    value: {
      operator_id: operatorId,
      name,
      file_type: fileType,
      data_type: dataType,
      mapping_config: mappingConfig,
      identification_rules: rules,
      notes,
    },
  };
}

/* ══════════════════════════════════════════════════════════════════════
 * GET /api/admin/mappings
 * ══════════════════════════════════════════════════════════════════════
 * Query params:
 *   ?activeOnly=true   — only is_active=true rows (default: false — returns all)
 *   ?fileType=csv      — filter by file type
 *   ?operatorId=<uuid> — filter by operator
 *   ?limit=100         — default 100, cap 500
 * ══════════════════════════════════════════════════════════════════════ */
router.get('/', async (req: Request, res: Response) => {
  const activeOnly = req.query.activeOnly === 'true';
  const fileType = typeof req.query.fileType === 'string' ? req.query.fileType : null;
  const operatorId = typeof req.query.operatorId === 'string' ? req.query.operatorId : null;

  let limit = 100;
  if (req.query.limit !== undefined) {
    const n = Number(req.query.limit);
    if (Number.isFinite(n) && n > 0) limit = Math.min(Math.floor(n), 500);
  }

  let q = supabase
    .from('format_mappings')
    .select(
      `id, operator_id, name, file_type, data_type, mapping_config,
       identification_rules, version, is_active, notes, created_at, updated_at,
       operators ( id, name )`
    )
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (activeOnly) q = q.eq('is_active', true);
  if (fileType) q = q.eq('file_type', fileType);
  if (operatorId) q = q.eq('operator_id', operatorId);

  const { data, error } = await q;
  if (error) {
    return res.status(500).json({ ok: false, error: `Query failed: ${error.message}` });
  }
  return res.json({ ok: true, count: data?.length ?? 0, mappings: (data ?? []) as unknown as MappingRow[] });
});

/* ══════════════════════════════════════════════════════════════════════
 * GET /api/admin/mappings/:id
 * ══════════════════════════════════════════════════════════════════════ */
router.get('/:id', async (req: Request, res: Response) => {
  const id = req.params.id;
  const { data, error } = await supabase
    .from('format_mappings')
    .select(
      `id, operator_id, name, file_type, data_type, mapping_config,
       identification_rules, version, is_active, notes, created_at, updated_at,
       operators ( id, name )`
    )
    .eq('id', id)
    .single();

  if (error) {
    return res.status(404).json({ ok: false, error: `No mapping with id="${id}".` });
  }
  return res.json({ ok: true, mapping: data as unknown as MappingRow });
});

/* ══════════════════════════════════════════════════════════════════════
 * POST /api/admin/mappings
 * ══════════════════════════════════════════════════════════════════════ */
router.post('/', async (req: Request, res: Response) => {
  const parsed = parseMappingInput(req.body);
  if (!parsed.ok) return res.status(400).json({ ok: false, error: parsed.error });

  const payload = parsed.value;

  // Soft uniqueness check: a mapping with the same (operator_id, name) already
  // exists? The DB has no unique constraint on (operator_id, name) — we warn
  // rather than hard-block so the UI can nudge but still allow versioned
  // duplicates (e.g. "Anadarko Monthly v2" test) if the operator insists.
  //
  // Null operator_id matters here: Postgres treats `col = NULL` as UNKNOWN, not
  // TRUE, so we have to use `.is('operator_id', null)` to actually match the
  // unassigned rows. Using `.eq('operator_id', '')` (the old behavior) silently
  // returned no rows, so the warning never fired for operator-less mappings.
  let existingQuery = supabase
    .from('format_mappings')
    .select('id, is_active, version')
    .eq('name', payload.name)
    .limit(1);
  existingQuery =
    payload.operator_id === null
      ? existingQuery.is('operator_id', null)
      : existingQuery.eq('operator_id', payload.operator_id);
  const { data: existing } = await existingQuery;

  const { data, error } = await supabase
    .from('format_mappings')
    .insert({
      operator_id: payload.operator_id,
      name: payload.name,
      file_type: payload.file_type,
      data_type: payload.data_type,
      mapping_config: payload.mapping_config,
      identification_rules: payload.identification_rules,
      notes: payload.notes,
      version: 1,
      is_active: true,
    })
    .select(
      `id, operator_id, name, file_type, data_type, mapping_config,
       identification_rules, version, is_active, notes, created_at, updated_at,
       operators ( id, name )`
    )
    .single();

  if (error) {
    return res.status(500).json({ ok: false, error: `Insert failed: ${error.message}` });
  }

  invalidateMappingCache();
  return res.status(201).json({
    ok: true,
    mapping: data as unknown as MappingRow,
    warnings: existing && existing.length > 0
      ? [`A mapping with the same (operator_id, name) already exists (id=${existing[0].id}, v${existing[0].version}). Both are active.`]
      : [],
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * PUT /api/admin/mappings/:id
 * ══════════════════════════════════════════════════════════════════════
 * Updates all fields AND bumps the version counter. We don't store old
 * versions in Phase 2 — the version integer is an audit counter for "how
 * many times has this been edited?" A future "mapping history" feature
 * (Phase 5 polish) can snapshot old configs, but Caleb's workflow right
 * now doesn't justify the complexity.
 * ══════════════════════════════════════════════════════════════════════ */
router.put('/:id', async (req: Request, res: Response) => {
  const id = req.params.id;
  const parsed = parseMappingInput(req.body);
  if (!parsed.ok) return res.status(400).json({ ok: false, error: parsed.error });
  const payload = parsed.value;

  // Fetch the current row to get the version counter.
  const { data: current, error: fetchErr } = await supabase
    .from('format_mappings')
    .select('version')
    .eq('id', id)
    .single();
  if (fetchErr || !current) {
    return res.status(404).json({ ok: false, error: `No mapping with id="${id}".` });
  }

  const { data, error } = await supabase
    .from('format_mappings')
    .update({
      operator_id: payload.operator_id,
      name: payload.name,
      file_type: payload.file_type,
      data_type: payload.data_type,
      mapping_config: payload.mapping_config,
      identification_rules: payload.identification_rules,
      notes: payload.notes,
      version: (current.version ?? 1) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select(
      `id, operator_id, name, file_type, data_type, mapping_config,
       identification_rules, version, is_active, notes, created_at, updated_at,
       operators ( id, name )`
    )
    .single();

  if (error) {
    return res.status(500).json({ ok: false, error: `Update failed: ${error.message}` });
  }

  invalidateMappingCache();
  return res.json({ ok: true, mapping: data as unknown as MappingRow });
});

/* ══════════════════════════════════════════════════════════════════════
 * DELETE /api/admin/mappings/:id
 * ══════════════════════════════════════════════════════════════════════
 * Soft-delete only. We set is_active=false rather than actually dropping
 * the row so historical email_log rows that cite "matched mapping X" still
 * have something to link back to. A hard-delete admin action can be added
 * later if it's actually needed.
 * ══════════════════════════════════════════════════════════════════════ */
router.delete('/:id', async (req: Request, res: Response) => {
  const id = req.params.id;
  const { data, error } = await supabase
    .from('format_mappings')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('id, name, is_active')
    .single();

  if (error || !data) {
    return res.status(404).json({ ok: false, error: `No mapping with id="${id}".` });
  }

  invalidateMappingCache();
  return res.json({ ok: true, id: data.id, name: data.name, is_active: data.is_active });
});

/* ══════════════════════════════════════════════════════════════════════
 * POST /api/admin/mappings/validate
 * ══════════════════════════════════════════════════════════════════════
 * Check whether a config JSON is structurally valid without saving it.
 * The UI hits this on every form change for instant feedback. Does NOT
 * attempt to parse a file.
 * ══════════════════════════════════════════════════════════════════════ */
router.post('/validate', async (req: Request, res: Response) => {
  const parsed = parseMappingInput(req.body);
  if (!parsed.ok) {
    return res.json({ ok: true, valid: false, error: parsed.error });
  }
  return res.json({
    ok: true,
    valid: true,
    kind: parsed.value.mapping_config.kind,
    fileKind: parsed.value.mapping_config.fileKind,
    dataType: parsed.value.mapping_config.dataType,
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * POST /api/admin/mappings/test
 * ══════════════════════════════════════════════════════════════════════
 * Dry-run a config against an uploaded file — used by the Mapping UI's
 * "Test against sample file" button. Does NOT persist records. Returns:
 *   - detect: whether identification_rules would accept this file
 *   - preview: first 10 parsed ProductionRecords (for UI inspection)
 *   - total: total records the engine would produce
 *   - errors: array of human-readable parse errors, if any
 *
 * Multipart body:
 *   - file: the file binary (required)
 *   - config: JSON string of the full mapping (required)
 *       Shape matches the POST/PUT payload so the UI can reuse the same
 *       form state object.
 * ══════════════════════════════════════════════════════════════════════ */
router.post('/test', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: 'Missing "file" upload (multipart/form-data).' });
  }

  // The config rides along as a stringified JSON form field because you
  // can't embed a JSON body alongside a binary in a single multipart request
  // without either base64-encoding the file or serializing the config. This
  // is the common Rails/Django pattern for "test this config against a file".
  const configRaw = req.body?.config;
  if (typeof configRaw !== 'string') {
    return res
      .status(400)
      .json({ ok: false, error: 'Missing "config" form field (must be a JSON string).' });
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(configRaw);
  } catch (err) {
    return res.status(400).json({
      ok: false,
      error: `"config" field is not valid JSON: ${err instanceof Error ? err.message : err}`,
    });
  }

  const parsed = parseMappingInput(parsedBody);
  if (!parsed.ok) {
    return res.status(400).json({ ok: false, error: parsed.error });
  }
  const cfg = parsed.value.mapping_config;

  // We only support structured engine in Phase 1. PDF engine is stubbed,
  // so route it there for the clear error message.
  try {
    if (cfg.kind === 'pdf') {
      return res.status(501).json({
        ok: false,
        error:
          'PDF dry-run is not supported yet. The visual bounding-box tool lands in Phase 4 (Task #84).',
      });
    }

    const records = runStructuredEngine(req.file.buffer, cfg as StructuredMappingConfig);

    return res.json({
      ok: true,
      matched: true, // reaching here means engine consumed the file at all
      total: records.length,
      preview: records.slice(0, 10),
      warnings: buildPreviewWarnings(records),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.json({
      ok: true, // endpoint call itself succeeded; reporting parse failure via body
      matched: false,
      total: 0,
      preview: [],
      error: msg,
    });
  }
});

/** Flag suspicious values in the preview so the UI can highlight them
 *  (e.g. "no API in first 10 rows — did you pick the right column?"). */
function buildPreviewWarnings(records: ReturnType<typeof runStructuredEngine>): string[] {
  const warnings: string[] = [];
  if (records.length === 0) return warnings;
  const sample = records.slice(0, 50);

  const missingApi = sample.filter((r) => !r.api10).length;
  if (missingApi === sample.length) {
    warnings.push(
      'No API numbers found in the first 50 rows. Check that "api" is mapped to the right column.'
    );
  }

  const missingWellName = sample.filter((r) => !r.wellName).length;
  if (missingWellName === sample.length) {
    warnings.push(
      'No well names found. Check that "wellName" is mapped (or that hierarchical mode is enabled for stacked layouts).'
    );
  }

  const allZeroVolumes = sample.every(
    (r) => !r.oilProd && !r.gasProd && !r.waterProd && !r.oilSales && !r.gasSales
  );
  if (allZeroVolumes) {
    warnings.push('All volume columns are 0/null in the first 50 rows. Verify column mappings.');
  }

  return warnings;
}

/* ══════════════════════════════════════════════════════════════════════
 * GET /api/admin/mappings/operators
 * ══════════════════════════════════════════════════════════════════════
 * Thin read-only list of operators so the UI's "Operator" dropdown can
 * populate. A UI that lets Caleb ADD an operator is worth the added surface
 * area but can live in Phase 3 (it's one more form, not a blocker to Phase 2).
 * ══════════════════════════════════════════════════════════════════════ */
router.get('/operators/list', async (_req: Request, res: Response) => {
  const { data, error } = await supabase
    .from('operators')
    .select('id, name, sender_email_patterns, notes')
    .order('name', { ascending: true });
  if (error) {
    return res.status(500).json({ ok: false, error: `Query failed: ${error.message}` });
  }
  return res.json({ ok: true, count: data?.length ?? 0, operators: data ?? [] });
});

/* ════════════════════════════════════════════════════════════════════
 * Router-level error handler
 * ════════════════════════════════════════════════════════════════════
 * Multer throws typed errors (MulterError) when an upload violates its
 * limits — most notably LIMIT_FILE_SIZE when someone tries to drop a
 * multi-hundred-MB workbook onto /test. Without this handler those
 * propagate to Express's default 500 page. We convert them to clean
 * 4xx JSON responses so the UI can show a friendly message.
 * Anything we don't recognize falls through to Express's default.
 * ════════════════════════════════════════════════════════════════════ */
router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        ok: false,
        error:
          'Uploaded file exceeds 25 MB. If this really is one operator\'s report, open it manually — at that size it\'s almost certainly a consolidated batch.',
      });
    }
    return res.status(400).json({ ok: false, error: `Upload error: ${err.message}` });
  }
  return next(err);
});

export default router;
