# 02 · Secrets & Environment Variables

Every environment variable the system reads, where it lives, and how to rotate it.

## Where they live

- **Production:** Railway service → Variables tab (`ProductionAggregator_App` service)
- **Dev:** `api/.env` and `web/.env` (both gitignored)
- **Templates:** `api/.env.example`, `web/.env.example` (committed; values are placeholders)

## Backend variables (`api/.env` and Railway)

### Supabase

| Var | Required | Description | Where to find |
|---|---|---|---|
| `SUPABASE_URL` | yes | `https://<project-ref>.supabase.co` | Supabase dashboard → Project Settings → API |
| `SUPABASE_SERVICE_KEY` | yes | Service-role key (bypasses RLS) | Same page; **secret**, do not expose to frontend |

The service-role key is the most sensitive credential in the system. If leaked: an attacker can read/write ALL tenant data. Rotate IMMEDIATELY if any of the following happen:
- Pushed to a public repo
- Pasted into a public chat
- Left in a screenshot
- Suspected device compromise

Rotation procedure:
1. Supabase dashboard → Project Settings → API → Regenerate service-role key
2. Update `SUPABASE_SERVICE_KEY` in Railway env vars
3. Trigger a redeploy (Railway dashboard → Restart, or push an empty commit)
4. The old key stops working immediately

### Gmail

| Var | Required | Description | Where to find |
|---|---|---|---|
| `GMAIL_CLIENT_ID` | yes | OAuth client ID for the Gmail integration | Google Cloud Console → APIs & Services → Credentials |
| `GMAIL_CLIENT_SECRET` | yes | OAuth client secret | Same place |
| `GMAIL_REFRESH_TOKEN` | yes | Long-lived refresh token authorizing `S.IS_AD_Prod@` access | Generated once via `api/scripts/get-gmail-refresh-token.ts`; see [backend/03-email-poller.md](../backend/03-email-poller.md#gmail-api-setup) |
| `GMAIL_MONITORED_EMAIL` | yes | `S.IS_AD_Prod@stewardship.is` | Hardcoded constant |

Rotation: if the refresh token is revoked or expires, regenerate via the script. The client_id/client_secret only need rotation if you suspect they've leaked — they're less sensitive than the service key because access still requires the refresh token.

### Server

| Var | Required | Description | Default |
|---|---|---|---|
| `PORT` | no | HTTP port to listen on | `3001` (overridden to `3000` by Railway in production) |
| `NODE_ENV` | no | `development` or `production` | `production` in Railway |
| `CORS_ALLOWLIST` | no | Comma-separated origin allowlist; if unset uses defaults in `buildCorsOptions()` | (built-in defaults: localhost + the Railway domain) |

## Frontend variables (`web/.env` and Railway)

These are **compile-time** — Vite inlines them into the JS bundle. They are not runtime env vars; you cannot change them without rebuilding.

| Var | Required | Description | Sensitive? |
|---|---|---|---|
| `VITE_SUPABASE_URL` | yes | Same value as backend `SUPABASE_URL` | No (public) |
| `VITE_SUPABASE_ANON_KEY` | yes | Supabase **anon** key (gated by RLS) | No (designed to be public) |

**Important:** the anon key is fine to expose. The service-role key is NOT. Confusing the two would be a P0 leak. Always look at the `VITE_` prefix:
- `VITE_SUPABASE_ANON_KEY` ← shipped to the browser, public-safe
- `SUPABASE_SERVICE_KEY` ← server-only, never expose

## What's NOT an env var

The following are intentionally hardcoded constants in the codebase (not env vars) because they don't change between environments:

- `STORAGE_BUCKET = 'production-files'` in `api/src/routes/exports.ts`
- The polling cron schedule `*/5 * * * *` in `api/src/index.ts`
- The retry cadence `5min → 15min → 1hr → 4hr → 24hr` in `services/retryWorker.ts`
- The 16-column ComboCurve template column order in `services/comboCurveExport.ts`

If one of these ever needs to be different per environment, promote it to an env var.

## Rotating ALL secrets at once (the "we've been breached" procedure)

1. **Supabase service-role key:** regenerate (see above)
2. **Supabase anon key:** regenerate → update `VITE_SUPABASE_ANON_KEY` → rebuild (push a commit)
3. **Gmail OAuth client secret:** Google Cloud Console → rotate → update `GMAIL_CLIENT_SECRET`
4. **Gmail refresh token:** regenerate via the script → update `GMAIL_REFRESH_TOKEN`
5. **GitHub PAT** (the one Cowork uses for direct pushes, stored at `~/Code/ProductionAggregator_App/.cowork/gh-token`): regenerate in GitHub Settings → Developer settings → Fine-grained tokens → write the new value to that file
6. **Railway API tokens** (if you've ever used them for automation): rotate in Railway → Account Settings → Tokens
7. **Domain DNS records:** verify they still point to Railway and haven't been tampered with

Order matters: rotate the Supabase service key LAST in the database tier, because revoking it kills the API mid-flight until you redeploy.

## Local development env hygiene

- `.env` files in `api/` and `web/` are gitignored. Never commit them.
- The repo's `.gitignore` lists `.env`, `.env.local`, `.env.*.local` to be safe.
- If you accidentally commit a secret, do NOT just delete the file — Git history retains it. Rotate the secret (above), then optionally rewrite history (`git filter-repo`) and force-push.

## Verifying current env vars

Railway dashboard → service → Variables. Compare to this doc. Any var in the dashboard not listed here is either:
- Undocumented (please add it to this doc)
- Stale (delete it)

Any var listed here not in the dashboard means the production deploy is missing it; the app may crash on startup.
