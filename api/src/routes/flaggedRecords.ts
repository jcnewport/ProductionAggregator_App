/**
 * Flagged Records Route Handler
 * -----------------------------
 * Exposes rows that failed API10 validation (or other storage-time checks)
 * so the dashboard widget can show Caleb what needs manual review.
 *
 * Endpoint:
 *
 *   GET /api/flagged-records?limit=50&since=YYYY-MM-DD
 *     limit: defaults to 50, max 500 (safety rail)
 *     since: optional ISO date — only return rows created on or after this date
 *
 *   GET /api/flagged-records/summary
 *     Returns aggregate counts for the dashboard summary card:
 *       { total, last_7_days, distinct_reasons, latest_created_at }
 *
 * Why this is a separate router (not on /api/admin):
 *   Admin operations mutate state (reprocess, retry). This is read-only
 *   visibility and the UI should be able to pull it without elevated auth.
 */

import { Router, type Request, type Response } from 'express';
import { supabase } from '../services/supabase.js';

const router = Router();

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;

function parseLimit(raw: unknown): number {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/**
 * GET /api/flagged-records
 * Paginated list (most recent first). No cursor pagination for now — if we
 * ever exceed 500 unresolved flagged rows, that's a parser bug worth
 * investigating, not a UX problem to paper over.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const limit = parseLimit(req.query.limit);
    const since = typeof req.query.since === 'string' ? req.query.since : null;

    let q = supabase
      .from('flagged_records')
      .select(
        'id, email_log_id, source_file_name, row_number, reason, attempted_well_name, attempted_api10, attempted_api14, raw_fields, created_at'
      )
      .order('created_at', { ascending: false })
      .limit(limit);

    if (since) q = q.gte('created_at', since);

    const { data, error } = await q;
    if (error) throw error;

    res.json({ ok: true, count: data?.length ?? 0, records: data ?? [] });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: msg });
  }
});

/**
 * GET /api/flagged-records/summary
 * Single aggregate row for the dashboard card — cheap call, safe to poll.
 */
router.get('/summary', async (_req: Request, res: Response) => {
  try {
    // Total count (all time).
    const { count: total, error: totalErr } = await supabase
      .from('flagged_records')
      .select('id', { count: 'exact', head: true });
    if (totalErr) throw totalErr;

    // Last-7-days count.
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { count: last7, error: last7Err } = await supabase
      .from('flagged_records')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', sevenDaysAgo);
    if (last7Err) throw last7Err;

    // Distinct reasons + most recent timestamp — one small query.
    // (We pull up to 1000 reason rows; cardinality is tiny.)
    const { data: reasonRows, error: reasonErr } = await supabase
      .from('flagged_records')
      .select('reason, created_at')
      .order('created_at', { ascending: false })
      .limit(1000);
    if (reasonErr) throw reasonErr;

    const distinctReasons = new Set((reasonRows ?? []).map((r) => r.reason)).size;
    const latestCreatedAt = reasonRows && reasonRows.length > 0 ? reasonRows[0].created_at : null;

    res.json({
      ok: true,
      total: total ?? 0,
      last_7_days: last7 ?? 0,
      distinct_reasons: distinctReasons,
      latest_created_at: latestCreatedAt,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: msg });
  }
});

export default router;
