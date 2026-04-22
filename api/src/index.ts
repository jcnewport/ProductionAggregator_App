/**
 * ProductionAggregator API Server
 *
 * Main entry point for the backend service.
 * Handles:
 * - Email polling (Gmail API)
 * - File parsing (PDF, Excel, CSV)
 * - Data storage (Supabase)
 * - Export generation
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { startEmailPollerCron, runPollingPass } from './services/emailPoller.js';
import { startRetryWorkerCron } from './services/retryWorker.js';
import exportsRouter from './routes/exports.js';
import exportHistoryRouter from './routes/exportHistory.js';
import adminRouter from './routes/admin.js';
import mappingsRouter from './routes/mappings.js';
import flaggedRecordsRouter from './routes/flaggedRecords.js';
import {
  adminLimiter,
  buildCorsOptions,
  globalLimiter,
  requireAuthMaybe,
  requireTenantMaybe,
  requireSuperAdmin,
} from './middleware/security.js';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Security + parsing middleware ───────────────────────────────
// Order matters — we set security headers and rate limits BEFORE
// any business logic runs, so even a bad-request path still gets
// the protection.
//
// 1. helmet       → sets a bundle of well-known security headers
//                    (X-Content-Type-Options, Referrer-Policy, etc.)
// 2. cors         → allowlisted origins only (see middleware/security.ts)
// 3. globalLimiter → generous per-IP rate limit on every route
// 4. express.json → parse JSON bodies (req.body)
//
// helmet's default CSP is strict enough to block Vite's production
// bundle (it uses inline styles). Disabling contentSecurityPolicy here
// keeps the SPA rendering while still leaving the other protections on.
// A future hardening pass can introduce a custom CSP if we want one.
app.use(
  helmet({
    contentSecurityPolicy: false,
    // Don't force HSTS in dev — Railway already terminates HTTPS and
    // sets HSTS at the edge. Explicitly disabling avoids surprises if
    // someone runs the API on plain-HTTP locally.
    strictTransportSecurity: false,
  })
);
app.use(cors(buildCorsOptions()));
app.use(globalLimiter);
app.use(express.json());

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'ProductionAggregator API',
    timestamp: new Date().toISOString()
  });
});

// Manual trigger for the email poller — useful for testing without waiting for the cron.
// POST /api/poll  →  runs one polling pass now and returns the count of messages processed.
//
// Phase 4 multi-tenancy: the poller spans ALL tenant aliases in a single pass,
// so only super-admins (Caleb) can trigger it. A regular tenant user hitting
// this would be touching another client's mail, which we never want.
app.post(
  '/api/poll',
  adminLimiter,
  requireAuthMaybe(),
  requireTenantMaybe(),
  requireSuperAdmin,
  async (_req, res) => {
    try {
      const result = await runPollingPass();
      res.json({ ok: true, ...result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: msg });
    }
  }
);

// ComboCurve export endpoints:
//   GET /api/export/monthly?start=YYYY-MM&end=YYYY-MM
//   GET /api/export/daily?start=YYYY-MM-DD&end=YYYY-MM-DD
//
// Phase 4 multi-tenancy: auth + tenant required. Tenant users only see
// their own data (handled inside comboCurveExport.queryProduction).
// Super-admin bypasses the tenant filter and exports across tenants.
app.use(
  '/api/export',
  requireAuthMaybe(),
  requireTenantMaybe(),
  exportsRouter
);

// Export history (Task #77):
//   GET /api/exports                     — paginated list, newest first
//   GET /api/exports/:id                 — single row
//   GET /api/exports/:id/download        — 302 redirect to signed URL
//
// Phase 4 multi-tenancy: same auth + tenant gating as /api/export.
app.use(
  '/api/exports',
  requireAuthMaybe(),
  requireTenantMaybe(),
  exportHistoryRouter
);

// Mapping management (Task #82 — Phase 2 of Task #79).
//   GET    /api/admin/mappings                list (filterable)
//   GET    /api/admin/mappings/:id            single
//   POST   /api/admin/mappings                create
//   PUT    /api/admin/mappings/:id            update (bumps version)
//   DELETE /api/admin/mappings/:id            soft-delete (is_active=false)
//   POST   /api/admin/mappings/validate       structural JSON check only
//   POST   /api/admin/mappings/test           multipart: dry-run config vs file
//   GET    /api/admin/mappings/operators/list operator dropdown source
//
// IMPORTANT: this mount MUST come before `app.use('/api/admin', ...)` below.
// Express matches in registration order and routes the first-prefix hit, so
// putting the more-specific `/api/admin/mappings` first prevents the general
// admin router from swallowing these calls. Both mounts share the same
// adminLimiter + requireAuthMaybe() guard so auth + rate-limit behavior is
// identical.
//
// Phase 4 multi-tenancy: mappings are SHARED reference data (operator catalog,
// parser format configs) — not tenant-scoped. Only Caleb (super-admin) edits
// them. requireSuperAdmin blocks regular tenant users from touching the
// catalog that every other tenant's ingestion relies on.
app.use(
  '/api/admin/mappings',
  adminLimiter,
  requireAuthMaybe(),
  requireTenantMaybe(),
  requireSuperAdmin,
  mappingsRouter
);

// Admin operations — reprocess failed emails, retry passes, alert sends.
//   POST /api/admin/reprocess-email     { emailLogId?, gmailMessageId? }
//   POST /api/admin/reprocess-failed    { statuses?, limit? }
//   POST /api/admin/retry-now           { emailLogId }
//   POST /api/admin/retry-pass          { max? }
//   POST /api/admin/send-alert          { emailLogId, force? }
//   GET  /api/admin/retries-due         ?limit=
//
// Gated by:
//   • adminLimiter       — tighter rate ceiling (30 req / 15 min / IP)
//   • requireAuthMaybe   — valid Supabase Bearer token required
//   • requireTenantMaybe — user must belong to a tenant
//   • requireSuperAdmin  — only super-admins can run these (Phase 4)
//     (bypass all three with ADMIN_AUTH_DISABLED=true for local debugging only)
//
// Phase 4 rationale: every endpoint under /api/admin mutates global state
// (re-polling Gmail, reprocessing email_log rows, forcing retries, sending
// failure alerts). These span tenants — a regular tenant user hitting them
// would be touching other clients' data, which we never want.
app.use(
  '/api/admin',
  adminLimiter,
  requireAuthMaybe(),
  requireTenantMaybe(),
  requireSuperAdmin,
  adminRouter
);

// Flagged records — rows rejected by storage-layer validators
//   GET /api/flagged-records?limit=50&since=YYYY-MM-DD
//   GET /api/flagged-records/summary
//
// Phase 4 multi-tenancy: auth + tenant required. Tenant users only see their
// own flagged rows (filter applied inside the router). Super-admin sees all.
app.use(
  '/api/flagged-records',
  requireAuthMaybe(),
  requireTenantMaybe(),
  flaggedRecordsRouter
);

// TODO: Mount additional route handlers
// app.use('/api/emails', emailRoutes);
// (mappings router is mounted under /api/admin/mappings above)

// ─── Serve the React frontend in production ──────────────────────────────
// When this file is compiled, it sits at /api/dist/index.js. The web app's
// built static files live at /web/dist (relative to the repo root). Traversing
// two levels up from __dirname gives us the repo root, and then /web/dist.
//
//   /api/dist/index.js  →  __dirname = /api/dist
//   ../../web/dist     →  /web/dist
//
// We also handle the dev case where there's no /web/dist yet (skip static
// serving so the API can run standalone while we're developing the React app
// via `npm run dev` in /web with its Vite dev server proxy).
const WEB_DIST = path.resolve(__dirname, '..', '..', 'web', 'dist');
if (fs.existsSync(WEB_DIST)) {
  console.log(`[web] Serving React static files from ${WEB_DIST}`);
  app.use(express.static(WEB_DIST));
  // SPA fallback: anything that ISN'T /api/* and ISN'T a file we served above
  // should return index.html so React Router can take over client-side.
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(WEB_DIST, 'index.html'));
  });
} else {
  console.warn(`[web] No frontend build found at ${WEB_DIST} — running API only.`);
}

app.listen(PORT, () => {
  console.log(`ProductionAggregator API running on port ${PORT}`);

  // Start the Gmail polling cron. Guarded so the server still boots if Gmail env vars are missing
  // (useful while setup is in progress — you'll just see a log warning).
  try {
    if (
      process.env.GMAIL_CLIENT_ID &&
      process.env.GMAIL_CLIENT_SECRET &&
      process.env.GMAIL_REFRESH_TOKEN
    ) {
      startEmailPollerCron();
      // Task #62: retry worker runs in-process alongside the poller.
      // Offset schedule (:07/:22/:37/:52) keeps it out of the poller's
      // quota window when both hit in the same 15-min tick.
      startRetryWorkerCron();
    } else {
      console.warn(
        '[index] Gmail env vars not configured — email poller disabled. Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN to enable.'
      );
    }
  } catch (err) {
    console.error('[index] Failed to start email poller:', err);
  }
});

export default app;
