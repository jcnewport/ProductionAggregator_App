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

// TODO: Mount route handlers
// app.use('/api/exports', exportRoutes);
// app.use('/api/emails', emailRoutes);
// app.use('/api/mappings', mappingRoutes);

app.listen(PORT, () => {
  console.log(`ProductionAggregator API running on port ${PORT}`);
});

export default app;
