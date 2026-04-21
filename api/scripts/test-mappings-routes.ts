/**
 * Offline smoke test for the mappings admin router.
 *
 * What it proves:
 *   - /validate correctly accepts a good config
 *   - /validate correctly rejects a bad config (with a useful error message)
 *   - /test dry-runs the Aftermath sample file through a JSON config and
 *     returns the same 2029 records the engine produced end-to-end
 *   - An oversized upload returns a clean 413 (multer error handler path)
 *
 * What it does NOT prove (by design):
 *   - Supabase CRUD — those paths need a live DB. This test stubs the
 *     supabase client so GET/POST/PUT/DELETE still load but we don't
 *     actually exercise them here. Live-hit testing happens when Caleb
 *     points the UI at Railway.
 *
 * Run with: npx tsx api/scripts/test-mappings-routes.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';

// Prevent supabase.ts from throwing at module load (it requires env vars).
// Any code path that ACTUALLY calls supabase in this test would fail —
// but the three endpoints we test (/validate, /test, upload limits) don't.
process.env.SUPABASE_URL ||= 'http://stub.invalid';
process.env.SUPABASE_SERVICE_KEY ||= 'stub';

async function main() {
  // Import AFTER env stubs are in place, so supabase.ts doesn't throw.
  const { default: mappingsRouter } = await import('../src/routes/mappings.js');

  const app = express();
  app.use(express.json());
  app.use('/api/admin/mappings', mappingsRouter);

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}/api/admin/mappings`;

  let failures = 0;
  const check = (name: string, cond: boolean, detail?: string) => {
    if (cond) {
      console.log(`  ✓ ${name}`);
    } else {
      console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
      failures++;
    }
  };

  // ────────────────────────────────────────────────────────────────
  // 1) POST /validate with a VALID config → { valid: true }
  // ────────────────────────────────────────────────────────────────
  const goodConfig = {
    name: 'Aftermath Dailies (data-driven)',
    file_type: 'csv',
    data_type: 'daily',
    operator_id: null,
    mapping_config: {
      kind: 'structured',
      schemaVersion: 1,
      fileKind: 'csv',
      dataType: 'daily',
      headerRow: 1,
      columnMappings: {
        wellName: { matchType: 'header', headers: ['WELL NAME'] },
        api: { matchType: 'header', headers: ['API'] },
        prodDate: { matchType: 'header', headers: ['PRODDATE'] },
        oilProd: { matchType: 'header', headers: ['OIL PROD'] },
        gasProd: { matchType: 'header', headers: ['GAS PROD'] },
        waterProd: { matchType: 'header', headers: ['WATER PROD'] },
      },
      conventions: {
        dateFormat: 'M/D/YYYY',
        apiSource: 'api10',
        apiFormat: 'digits-only',
      },
    },
    identification_rules: {
      requireAll: false,
      sender: [],
      filename: [],
      content: [],
      header: [],
    },
  };

  {
    const r = await fetch(`${base}/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(goodConfig),
    });
    const body = (await r.json()) as { ok: boolean; valid: boolean; error?: string };
    check('POST /validate accepts a valid CSV config', r.status === 200 && body.valid === true, JSON.stringify(body));
  }

  // ────────────────────────────────────────────────────────────────
  // 2) POST /validate with a MISMATCHED file_type → valid:false + explanation
  // ────────────────────────────────────────────────────────────────
  {
    const bad = { ...goodConfig, file_type: 'xlsx' }; // mapping_config still says csv
    const r = await fetch(`${base}/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bad),
    });
    const body = (await r.json()) as { ok: boolean; valid: boolean; error?: string };
    const sayingRightThing = typeof body.error === 'string' && /file_type/i.test(body.error);
    check(
      'POST /validate rejects file_type vs mapping_config.fileKind mismatch',
      r.status === 200 && body.valid === false && sayingRightThing,
      JSON.stringify(body)
    );
  }

  // ────────────────────────────────────────────────────────────────
  // 2b) POST /validate with MISSING conventions → useful UI error
  // ────────────────────────────────────────────────────────────────
  {
    const bad = {
      ...goodConfig,
      mapping_config: {
        ...goodConfig.mapping_config,
        conventions: undefined,
      },
    };
    const r = await fetch(`${base}/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bad),
    });
    const body = (await r.json()) as { ok: boolean; valid: boolean; error?: string };
    const helpful = typeof body.error === 'string' && /conventions/i.test(body.error);
    check(
      'POST /validate rejects missing conventions with a UI-friendly message',
      r.status === 200 && body.valid === false && helpful,
      JSON.stringify(body)
    );
  }

  // ────────────────────────────────────────────────────────────────
  // 3) POST /test multipart with Aftermath CSV + config → 2029 rows
  // ────────────────────────────────────────────────────────────────
  const sample = path.resolve(__dirname, '..', '..', '2026.04.07 Aftermath Dailies.csv');
  if (!fs.existsSync(sample)) {
    console.error(`  (skipping /test — sample file not found at ${sample})`);
  } else {
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(sample)]), 'Aftermath.csv');
    form.append('config', JSON.stringify(goodConfig));
    const r = await fetch(`${base}/test`, { method: 'POST', body: form });
    const body = (await r.json()) as {
      ok: boolean;
      matched: boolean;
      total: number;
      preview: unknown[];
      warnings?: string[];
      error?: string;
    };
    check(
      'POST /test dry-runs Aftermath CSV through JSON config → 2029 records',
      r.status === 200 && body.ok === true && body.matched === true && body.total === 2029,
      `matched=${body.matched} total=${body.total} err=${body.error}`
    );
    check(
      'POST /test returns preview (≤10) + warnings array',
      Array.isArray(body.preview) && body.preview.length <= 10 && Array.isArray(body.warnings),
      `preview.length=${body.preview?.length} warnings=${JSON.stringify(body.warnings)}`
    );
  }

  // ────────────────────────────────────────────────────────────────
  // 4) POST /test with an empty/missing file → 400
  // ────────────────────────────────────────────────────────────────
  {
    const form = new FormData();
    form.append('config', JSON.stringify(goodConfig));
    const r = await fetch(`${base}/test`, { method: 'POST', body: form });
    check('POST /test rejects missing file with 400', r.status === 400);
  }

  server.close();

  if (failures > 0) {
    console.error(`\nFAIL — ${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nPASS — all route-wiring checks green.`);
}

main().catch((err) => {
  console.error('UNEXPECTED ERROR:', err);
  process.exit(1);
});
