# 01 · Deployment

How code gets from commit to production. Both the API and the frontend ride the same deploy.

## The platforms

- **Railway** — runs the Node process (Express + cron) and serves the built frontend
- **Supabase** — Postgres, Auth, Storage (not auto-deployed; migrations are applied manually)
- **GitHub** — `jcnewport/ProductionAggregator_App`, `main` is the deployment branch

## The flow

```
1. Developer pushes to main on GitHub
2. Railway watches main; webhook fires
3. Railway pulls the code
4. Railway runs `npm install` in root (postinstall hooks run)
5. Railway runs `npm run build` (from api/package.json):
   a. cd web && npm install && npm run build    ← builds the frontend into web/dist/
   b. cd api && npm run build                   ← tsc compiles api/src to api/dist
6. Railway runs `npm run start` → `node api/dist/index.js`
7. Express serves /api/* + static /assets/* + index.html fallback
8. node-cron registers the email poller and retry worker in-process
9. App is live; LIVE indicator should pulse in the top bar
```

**Build time:** ~2–4 minutes. **Deploy total wallclock from `git push` to live:** ~3–5 minutes.

## Watching a deploy

- Railway dashboard → `ProductionAggregator_App` service → Deployments tab
- The most recent deploy is at the top with a colored status dot
- Click it to see logs (build + runtime)

## What's deployed where

| Asset | Where | Built by |
|---|---|---|
| Backend code | Railway service, `/api/dist/*.js` | `tsc` during build |
| Frontend bundle | Railway service, `/web/dist/index.html` + `/web/dist/assets/*` | Vite during build |
| Database schema | Supabase project `sdnpvclmfezesgqeudzu` | Manual SQL migrations |
| Secrets | Railway env vars (NOT in repo) | Set in Railway dashboard |

The frontend is **not** deployed to a separate CDN. Express static-serves it. At our scale (single tenant) this is fine; the gzipped bundle is ~124 KB.

## Configuration

### Railway service

- Service: `ProductionAggregator_App`
- Root directory: `/` (the repo root)
- Build command: (defaults — runs `npm install && npm run build` per root `package.json`)
- Start command: `npm run start`
- Domain: `productionaggregator.stewardship.is` (custom domain CNAMEd to Railway)
- Region: pick the one closest to Supabase (us-east-1 since Supabase project is us-east-1)

### Environment variables

See [02-secrets-and-env.md](02-secrets-and-env.md).

## Branching strategy

- `main` is always deployable. Railway deploys every push to `main`.
- Small/cosmetic changes: push directly to `main`.
- Risky changes (DB migrations, parser logic, schema changes, anything touching production data): create a feature branch, push, manually review on github.com, then merge.

The repo has had a small number of PRs (the merged "Non-Production Files" feature was PR #1). Most work has been direct pushes to `main` because the rollback path is fast (one revert, ~3 min back to previous version).

## Rolling back a bad deploy

See [runbooks/rollback-a-bad-deploy.md](../runbooks/rollback-a-bad-deploy.md).

TL;DR: `git revert HEAD && git push origin main`. Railway redeploys the reverted state in ~3 min.

## First-time deploy (provisioning)

These steps are only needed if you're standing up a brand-new copy of the system (disaster recovery, second region, etc.). For day-to-day work, skip this section.

See:
- [`RAILWAY_SETUP.md`](../../RAILWAY_SETUP.md) — Railway provisioning (project creation, service config, env vars)
- [`GITHUB_SETUP.md`](../../GITHUB_SETUP.md) — GitHub repo creation
- For Supabase: create a new project in the Supabase dashboard, then run every migration in `supabase/migrations/` and `api/migrations/` in numerical order via the SQL editor

## Local development

```bash
# 1. clone
git clone https://github.com/jcnewport/ProductionAggregator_App.git
cd ProductionAggregator_App

# 2. install
npm install
cd api && npm install
cd ../web && npm install

# 3. set env vars
cp api/.env.example api/.env       # fill in Supabase + Gmail creds (a service-role key for dev is fine)
cp web/.env.example web/.env       # fill in Supabase URL + ANON key

# 4. run frontend
cd web && npm run dev          # Vite on http://localhost:5173

# 5. in a second terminal, run api
cd api && npm run dev          # tsx watch, restarts on save, listens on http://localhost:3001
```

The frontend proxies API calls to `http://localhost:3001` (configured in `web/vite.config.ts`).

## Production troubleshooting checklist

If something is broken in production:

1. Railway dashboard → `ProductionAggregator_App` service → Logs (live tail)
2. Look for the last error before the symptom you're investigating
3. Check `/health` is responding (visit `productionaggregator.stewardship.is/health`)
4. Check Supabase: project dashboard → DB → Health. Verify the DB is up.
5. Check Gmail: try sending a test email to the tenant alias and watch the next poll cycle (5 min)
6. Compare current Git commit (`git log -1`) to what's deployed (Railway dashboard → Settings → most-recent-deployed-commit)

See [03-monitoring.md](03-monitoring.md) for ongoing health-watch routines.

## What happens on a failed deploy

Railway only switches traffic to the new build if `npm run build` exits 0 AND the resulting process starts cleanly. If the build fails, the previous version keeps running. You'll see a red status dot on the failed deploy; the previous green deploy is still active.

If the build succeeds but the new process crashes on startup, Railway restarts it a few times before giving up and rolling back. Watch the logs.

## Deploys are atomic per service

There's no separate "frontend deploy" you can do without a backend deploy. Both build artifacts come from the same Git commit. That's by design — eliminates skew between frontend and backend.
