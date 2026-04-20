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
import { startEmailPollerCron, runPollingPass } from './services/emailPoller.js';

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

// TODO: Mount additional route handlers
// app.use('/api/exports', exportRoutes);
// app.use('/api/emails', emailRoutes);
// app.use('/api/mappings', mappingRoutes);

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
