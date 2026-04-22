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
import type { AuthenticatedRequest } from '../middleware/security.js';

const router = Router();

/**
 * Phase 4 multi-tenancy helper — pulls tenant context off the request
 * or responds with 500 if the middleware chain forgot to attach it.
 */
function requireTenantContext(
  req: Request,
  res: Response
): { tenantId: string; isSuperAdmin: boolean } | null {
  const tenant = (req as AuthenticatedRequest).tenant;
  if (!tenant) {
    res.status(500).json({
      ok: false,
      error:
        'flaggedRecords handler reached without req.tenant — middleware wiring is broken.',
    });
    return null;
  }
  return tenant;
}

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
    const tenant = requireTenantContext(req, res);
    if (!tenant) return;

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

    // Phase 4 multi-tenancy: tenant users only see their own flagged rows;
    // super-admins see everything (useful for diagnosing parser issues
    // across all clients).
    if (!tenant.isSuperAdmin) {
      q = q.eq('tenant_id', tenant.tenantId);
    }

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
router.get('/summary', async (req: Request, res: Response) => {
  try {
    const tenant = requireTenantContext(req, res);
    if (!tenant) return;

    // Total count (scoped to tenant unless super-admin).
    let totalQ = supabase
      .from('flagged_records')
      .select('id', { count: 'exact', head: true });
    if (!tenant.isSuperAdmin) totalQ = totalQ.eq('tenant_id', tenant.tenantId);
    const { count: total, error: totalErr } = await totalQ;
    if (totalErr) throw totalErr;

    // Last-7-days count (same tenant scoping).
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    let last7Q = supabase
      .from('flagged_records')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', sevenDaysAgo);
    if (!tenant.isSuperAdmin) last7Q = last7Q.eq('tenant_id', tenant.tenantId);
    const { count: last7, error: last7Err } = await last7Q;
    if (last7Err) throw last7Err;

    // Distinct reasons + most recent timestamp — one small query.
    // (We pull up to 1000 reason rows; cardinality is tiny.)
    let reasonQ = supabase
      .from('flagged_records')
      .select('reason, created_at')
      .order('created_at', { ascending: false })
      .limit(1000);
    if (!tenant.isSuperAdmin) reasonQ = reasonQ.eq('tenant_id', tenant.tenantId);
    const { data: reasonRows, error: reasonErr } = await reasonQ;
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
