/**
 * Non-Production Files Routes
 * ---------------------------
 * Two endpoints:
 *
 *   GET /api/non-production-files
 *     Returns recent rows from non_production_files (denormalized email
 *     context included) for the dashboard's bottom section. Defaults to
 *     50 most recent.
 *
 *   GET /api/non-production-files/:id/url
 *     Returns a short-lived signed URL the browser can use to view the
 *     PDF/HTML inline. TTL = 5 minutes. The dashboard "View" link calls
 *     this on click and opens the result in a new tab.
 *
 * Both endpoints are read-only and rely on Supabase Auth + RLS for
 * tenant isolation when called via authenticated user; the signed URL
 * is generated server-side with the service-role client because the
 * non-production-files bucket is private.
 */

import { Router, type Request, type Response } from 'express';
import {
  listRecentNonProductionFiles,
  signedUrlForNonProductionFile,
} from '../services/nonProductionFilesStore.js';

const router = Router();

/* ────────────────────────────────────────────────────────────────
 * GET /api/non-production-files
 * Optional query: ?limit=N (default 50, max 200).
 * ──────────────────────────────────────────────────────────────── */
router.get('/', async (req: Request, res: Response) => {
  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, 200)
    : 50;

  const rows = await listRecentNonProductionFiles(limit);
  res.json({ ok: true, rows });
});

/* ────────────────────────────────────────────────────────────────
 * GET /api/non-production-files/:id/url
 * Returns { ok, url, expiresInSeconds } or { ok: false, error }.
 * ──────────────────────────────────────────────────────────────── */
router.get('/:id/url', async (req: Request, res: Response) => {
  const id = String(req.params.id || '').trim();
  if (!id) {
    res.status(400).json({ ok: false, error: 'Missing :id' });
    return;
  }
  const ttlSeconds = 300;
  const url = await signedUrlForNonProductionFile(id, ttlSeconds);
  if (!url) {
    res.status(404).json({ ok: false, error: 'File not found or signing failed' });
    return;
  }
  res.json({ ok: true, url, expiresInSeconds: ttlSeconds });
});

export default router;
