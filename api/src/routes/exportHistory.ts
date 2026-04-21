/**
 * Export History Route Handlers (Task #77)
 * ----------------------------------------
 *
 *   GET  /api/exports?limit=50&offset=0&type=monthly|daily
 *        Returns the list of prior exports, newest first. The frontend's
 *        Export History page hits this.
 *
 *   GET  /api/exports/:id/download
 *        Generates a short-lived Supabase Storage signed URL for the file
 *        and redirects the browser to it. Browser starts the download
 *        automatically (Supabase sets the right content-disposition).
 *
 *   GET  /api/exports/:id
 *        Returns a single export row as JSON. Useful for the detail view
 *        or for client code that wants to show metadata without triggering
 *        a download.
 *
 * The `exports` table is populated by the generation endpoints in
 * ./exports.ts — this router is the read-side.
 */

import { Router, type Request, type Response } from 'express';
import { supabase } from '../services/supabase.js';

const router = Router();

const STORAGE_BUCKET = 'production-files';

// How long signed download URLs stay valid. 60 seconds is plenty — the
// browser redirects + starts streaming within a second or two. Short TTL
// is a defense-in-depth move: even if a URL leaks, it's useless tomorrow.
const SIGNED_URL_TTL_SECONDS = 60;

/**
 * GET /api/exports
 *
 * Query params (all optional):
 *   limit   — default 50, max 200
 *   offset  — default 0
 *   type    — 'monthly' | 'daily' to filter
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const rawLimit = parseInt(String(req.query.limit ?? '50'), 10);
    const rawOffset = parseInt(String(req.query.offset ?? '0'), 10);
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 50, 1), 200);
    const offset = Math.max(Number.isFinite(rawOffset) ? rawOffset : 0, 0);

    const typeFilter = String(req.query.type ?? '');
    const validType = typeFilter === 'monthly' || typeFilter === 'daily';

    let q = supabase
      .from('exports')
      .select(
        'id, export_type, date_range_start, date_range_end, operator_filter, well_filter, row_count, file_path, file_size_bytes, generated_by, generated_at',
        { count: 'exact' }
      )
      .order('generated_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (validType) {
      q = q.eq('export_type', typeFilter);
    }

    const { data, count, error } = await q;
    if (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }

    return res.json({
      ok: true,
      rows: data ?? [],
      total: count ?? 0,
      limit,
      offset,
    });
  } catch (err) {
    return res
      .status(500)
      .json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * GET /api/exports/:id
 * Single-row read. Mostly for potential future UIs; not used by the list page.
 */
router.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const { data, error } = await supabase
      .from('exports')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) return res.status(500).json({ ok: false, error: error.message });
    if (!data) return res.status(404).json({ ok: false, error: 'Export not found' });
    return res.json({ ok: true, row: data });
  } catch (err) {
    return res
      .status(500)
      .json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * GET /api/exports/:id/download
 *
 * Looks up the export's storage path, generates a signed URL, and redirects
 * the browser to it. Signed URL expires in 60s — plenty for an automated
 * redirect, not enough for a leaked link to be useful.
 *
 * Why signed URL + redirect rather than streaming via this endpoint?
 *   • Supabase Storage is the source of truth — no need to double-buffer
 *     a potentially large XLSX through our Node process.
 *   • The signed URL's content-disposition puts the right filename on the
 *     download, preserving the original filename the user generated.
 */
router.get('/:id/download', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const { data: row, error: selErr } = await supabase
      .from('exports')
      .select('file_path')
      .eq('id', id)
      .maybeSingle();

    if (selErr) return res.status(500).json({ ok: false, error: selErr.message });
    if (!row || !row.file_path) {
      return res.status(404).json({ ok: false, error: 'Export not found' });
    }

    // Pull the filename from the storage path — last segment after the
    // "__" separator we used when saving (see exports.ts persistExport).
    const pathParts = row.file_path.split('/');
    const lastSegment = pathParts[pathParts.length - 1] ?? '';
    const filename = lastSegment.includes('__')
      ? lastSegment.slice(lastSegment.indexOf('__') + 2)
      : lastSegment || 'ComboCurve_Export.xlsx';

    const { data: signed, error: signErr } = await supabase.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(row.file_path, SIGNED_URL_TTL_SECONDS, {
        download: filename,
      });

    if (signErr || !signed?.signedUrl) {
      return res
        .status(500)
        .json({ ok: false, error: signErr?.message ?? 'Failed to sign URL' });
    }

    // 302 redirect — browser will follow and trigger the download.
    return res.redirect(302, signed.signedUrl);
  } catch (err) {
    return res
      .status(500)
      .json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
