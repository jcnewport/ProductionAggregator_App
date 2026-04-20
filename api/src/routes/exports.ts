/**
 * Exports Route Handlers
 * ----------------------
 * Two endpoints:
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
 */

import { Router, type Request, type Response } from 'express';
import { generateComboCurveExport, type ExportType } from '../services/comboCurveExport.js';

const router = Router();

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

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Export-Row-Count', String(rowCount));
    res.setHeader('X-Export-Well-Count', String(wellCount));
    res.setHeader('Content-Length', String(buffer.length));
    res.status(200).send(buffer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Validation errors -> 400; everything else -> 500
    const isValidation = /^Invalid /.test(msg) || /query params/.test(msg) || /start must be/.test(msg);
    res.status(isValidation ? 400 : 500).json({ ok: false, error: msg });
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
