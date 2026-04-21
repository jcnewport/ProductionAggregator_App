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
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { startEmailPollerCron, runPollingPass } from './services/emailPoller.js';
import exportsRouter from './routes/exports.js';
import adminRouter from './routes/admin.js';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
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
app.post('/api/poll', async (_req, res) => {
  try {
    const result = await runPollingPass();
    res.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: msg });
  }
});

// ComboCurve export endpoints:
//   GET /api/export/monthly?start=YYYY-MM&end=YYYY-MM
//   GET /api/export/daily?start=YYYY-MM-DD&end=YYYY-MM-DD
app.use('/api/export', exportsRouter);

// Admin operations — reprocess failed emails, etc.
//   POST /api/admin/reprocess-email     { emailLogId?, gmailMessageId? }
//   POST /api/admin/reprocess-failed    { statuses?, limit? }
app.use('/api/admin', adminRouter);

// TODO: Mount additional route handlers
// app.use('/api/emails', emailRoutes);
// app.use('/api/mappings', mappingRoutes);

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
