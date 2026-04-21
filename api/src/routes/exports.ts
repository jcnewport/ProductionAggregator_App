/**
 * Exports Route Handlers
 * ----------------------
 * Two generation endpoints (unchanged UX from the client's POV):
 *
 *   GET /api/export/monthly?start=YYYY-MM&end=YYYY-MM[&operator_id=UUID]
 *       Streams an XLSX in the ComboCurve 16-column template with all
 *       MONTHLY production rows in the range. "start" and "end" are inclusive
 *       months; internally we expand to first-of-start-month through
 *       last-of-end-month.
 *
 *   GET /api/export/daily?start=YYYY-MM-DD&end=YYYY-MM-DD[&operator_id=UUID]
 *       Same structure, pulls from production_daily. Daily data is NEVER
 *       rolled up into monthly per project rules.
 *
 * Response: binary XLSX with Content-Disposition: attachment.
 * Errors: JSON { ok:false, error:"..." } with a 4xx/5xx.
 *
 * TASK #77 ADDITION (2026-04-21): every successful generation now ALSO:
 *   1. uploads the XLSX buffer to Supabase Storage (bucket 'production-files',
 *      path 'exports/YYYY/MM/<uuid>.xlsx'), and
 *   2. inserts a row into the `exports` table for the history page.
 * Both steps are best-effort — if either fails, we still stream the XLSX
 * back to the user. The whole point of this endpoint is the download; the
 * history log is a nice-to-have.
 */

import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'crypto';
import { generateComboCurveExport, type ExportType } from '../services/comboCurveExport.js';
import { supabase } from '../services/supabase.js';

const router = Router();

// The private bucket where we also stash original production attachments.
// Exports live under the 'exports/' prefix so they're easy to list/prune.
const STORAGE_BUCKET = 'production-files';

/**
 * Parse + validate a YYYY-MM string. Returns first day of that month as YYYY-MM-DD.
 * Throws Error with a user-readable message on bad input.
 */
function parseMonthStart(s: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`Invalid month "${s}". Expected format YYYY-MM (e.g. 2026-01).`);
  const [, yyyy, mm] = m;
  const monthNum = parseInt(mm, 10);
  if (monthNum < 1 || monthNum > 12) throw new Error(`Invalid month number in "${s}".`);
  return `${yyyy}-${mm}-01`;
}

/**
 * Parse a YYYY-MM string to the LAST day of that month as YYYY-MM-DD.
 */
function parseMonthEnd(s: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`Invalid month "${s}". Expected format YYYY-MM (e.g. 2026-03).`);
  const [, yyyy, mm] = m;
  const year = parseInt(yyyy, 10);
  const monthNum = parseInt(mm, 10);
  if (monthNum < 1 || monthNum > 12) throw new Error(`Invalid month number in "${s}".`);
  // Day 0 of month+1 == last day of month (JS Date trick)
  const lastDay = new Date(year, monthNum, 0).getDate();
  return `${yyyy}-${mm}-${String(lastDay).padStart(2, '0')}`;
}

/**
 * Parse + validate a YYYY-MM-DD string. Returns it as-is if valid.
 */
function parseYmd(s: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`Invalid date "${s}". Expected format YYYY-MM-DD.`);
  return s;
}

/**
 * Build a safe output filename for the XLSX download.
 */
function buildFileName(type: ExportType, start: string, end: string): string {
  const tag = type === 'monthly' ? 'Monthly' : 'Daily';
  return `ComboCurve_${tag}_${start}_to_${end}.xlsx`;
}

/**
 * Best-effort persistence pass. Returns null on any failure so the caller
 * can just ignore it and keep streaming the download. We never throw from
 * here — persistence is a side-bonus, not the critical path.
 */
async function persistExport(params: {
  type: ExportType;
  buffer: Buffer;
  filename: string;
  startDate: string;
  endDate: string;
  operatorIds: string[];
  wellIds: string[];
  rowCount: number;
  generatedBy: string | null;
}): Promise<string | null> {
  try {
    // Stash in Supabase Storage first. Path scheme:
    //   exports/YYYY/MM/<uuid>__<filename>
    // Grouping by year+month keeps the bucket browsable + prune-friendly.
    const id = randomUUID();
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const storagePath = `exports/${yyyy}/${mm}/${id}__${params.filename}`;

    const { error: uploadErr } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, params.buffer, {
        contentType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        upsert: false,
      });
    if (uploadErr) {
      console.warn(
        `[exports] Storage upload failed for ${storagePath}: ${uploadErr.message}`
      );
      return null;
    }

    // Then log the export row. Note: we use `id` as the PK so it matches
    // the storage path prefix — easy to trace one to the other if you're
    // debugging a single export.
    const { error: insertErr } = await supabase.from('exports').insert({
      id,
      export_type: params.type,
      date_range_start: params.startDate,
      date_range_end: params.endDate,
      operator_filter: params.operatorIds.length > 0 ? params.operatorIds : null,
      well_filter: params.wellIds.length > 0 ? params.wellIds : null,
      row_count: params.rowCount,
      file_path: storagePath,
      file_size_bytes: params.buffer.length,
      generated_by: params.generatedBy,
    });
    if (insertErr) {
      console.warn(
        `[exports] exports table insert failed for ${id}: ${insertErr.message}`
      );
      // Leave the storage object in place — the history page just won't list it.
      return null;
    }

    return id;
  } catch (err) {
    console.warn(
      `[exports] persistExport threw (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return null;
  }
}

/** Shared handler body — route-specific parts are the type + date parsers. */
async function handleExport(
  req: Request,
  res: Response,
  type: ExportType,
  parseStart: (s: string) => string,
  parseEnd: (s: string) => string,
  rawStart: string,
  rawEnd: string
): Promise<void> {
  try {
    if (!rawStart || !rawEnd) {
      res.status(400).json({ ok: false, error: 'Both "start" and "end" query params are required.' });
      return;
    }

    const startDate = parseStart(rawStart);
    const endDate = parseEnd(rawEnd);

    if (startDate > endDate) {
      res.status(400).json({ ok: false, error: 'start must be <= end.' });
      return;
    }

    // Optional filters
    const operatorIds = toArray(req.query.operator_id);
    const wellIds = toArray(req.query.well_id);

    const { buffer, rowCount, wellCount } = await generateComboCurveExport(type, {
      startDate,
      endDate,
      operatorIds: operatorIds.length > 0 ? operatorIds : undefined,
      wellIds: wellIds.length > 0 ? wellIds : undefined,
    });

    const filename = buildFileName(type, rawStart, rawEnd);

    // ─── Task #77: persist before streaming ───
    // We do the persistence BEFORE res.send so (a) if the client abandons
    // the download mid-flight we still have the file, and (b) we can set
    // X-Export-Id as a header so the frontend can remember the ID.
    // We await it, but any failure is swallowed and logged — the user still
    // gets their download.
    const exportId = await persistExport({
      type,
      buffer,
      filename,
      startDate,
      endDate,
      operatorIds,
      wellIds,
      rowCount,
      generatedBy: extractUserId(req),
    });

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Export-Row-Count', String(rowCount));
    res.setHeader('X-Export-Well-Count', String(wellCount));
    if (exportId) {
      res.setHeader('X-Export-Id', exportId);
      // CORS-expose the custom headers so the browser's JS can read them.
      // (Without this, the frontend's fetch response can't see X-Export-* at all.)
      res.setHeader(
        'Access-Control-Expose-Headers',
        'X-Export-Id, X-Export-Row-Count, X-Export-Well-Count, Content-Disposition'
      );
    } else {
      res.setHeader(
        'Access-Control-Expose-Headers',
        'X-Export-Row-Count, X-Export-Well-Count, Content-Disposition'
      );
    }
    res.setHeader('Content-Length', String(buffer.length));
    res.status(200).send(buffer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Validation errors -> 400; everything else -> 500
    const isValidation = /^Invalid /.test(msg) || /query params/.test(msg) || /start must be/.test(msg);
    res.status(isValidation ? 400 : 500).json({ ok: false, error: msg });
  }
}

/**
 * Best-effort user-id extraction from the Supabase JWT in the Authorization
 * header. We don't want to block on this — the endpoint was permissive
 * pre-Task #77 and we're keeping that for now. If the JWT is malformed or
 * missing, we just store NULL in exports.generated_by.
 *
 * The JWT payload (middle segment) has a `sub` claim that's the user UUID.
 */
function extractUserId(req: Request): string | null {
  try {
    const auth = req.header('Authorization') ?? '';
    const m = /^Bearer\s+([A-Za-z0-9\-_.]+)$/.exec(auth);
    if (!m) return null;
    const parts = m[1].split('.');
    if (parts.length !== 3) return null;
    // Base64url → base64 for Node's Buffer
    const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf-8'));
    if (typeof payload?.sub === 'string') return payload.sub;
    return null;
  } catch {
    return null;
  }
}

/** Convert a querystring param (string | string[] | undefined) to string[]. */
function toArray(v: unknown): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String);
  return [String(v)];
}

// ─── Monthly export ───
// GET /api/export/monthly?start=2026-01&end=2026-03
router.get('/monthly', async (req, res) => {
  await handleExport(
    req,
    res,
    'monthly',
    parseMonthStart,
    parseMonthEnd,
    String(req.query.start ?? ''),
    String(req.query.end ?? '')
  );
});

// ─── Daily export ───
// GET /api/export/daily?start=2026-03-01&end=2026-03-31
router.get('/daily', async (req, res) => {
  await handleExport(
    req,
    res,
    'daily',
    parseYmd,
    parseYmd,
    String(req.query.start ?? ''),
    String(req.query.end ?? '')
  );
});

export default router;
