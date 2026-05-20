# 00 · Fresh Install — Cold-Start Playbook

Standing up a brand-new copy of the Production Aggregator from scratch (different customer, different region, disaster recovery, sandbox environment).

**Time required:** 60–90 minutes the first time you do it. About 30 minutes once you've done it before.

**Prerequisites:**
- A GitHub account with access to (or a fork of) this repo
- Ability to create a new Supabase project (free tier is fine to start)
- Ability to create a new Railway service ($5–20/mo)
- Access to a Google Workspace tenant for the inbound email address
- A domain (or subdomain) to point at the new Railway service

---

## Step 1 · Fork or clone the repo

```bash
# Option A: fork on GitHub (preferred — preserves history, simpler future updates)
# Then clone your fork:
git clone https://github.com/<your-org>/ProductionAggregator_App.git
cd ProductionAggregator_App

# Option B: clone-then-push to a new private repo
git clone https://github.com/jcnewport/ProductionAggregator_App.git
cd ProductionAggregator_App
git remote set-url origin https://github.com/<your-org>/<your-repo>.git
git push -u origin main
```

---

## Step 2 · Create a new Supabase project

1. Go to [supabase.com](https://supabase.com) → sign in → "New project"
2. Pick a name (e.g. `production-aggregator-acme`) and a region close to your users
3. Set a strong database password (save it — you'll need it for migrations)
4. Wait ~2 min for provisioning
5. From the project's Settings → API, capture:
   - **Project URL** (`https://xxxx.supabase.co`)
   - **anon public key**
   - **service_role key** (KEEP THIS SECRET — it bypasses RLS)

---

## Step 3 · Apply migrations in order

You have two directories of migrations: `supabase/migrations/` (core schema) and `api/migrations/` (multi-tenancy). They MUST be applied in numerical order across both directories.

**Recommended order:**
```
supabase/migrations/001_create_core_tables.sql
supabase/migrations/002_setup_rls_and_storage.sql
api/migrations/0001_multitenancy_phase1.sql          ← SEE FRESH-INSTALL NOTE BELOW
api/migrations/0002_multitenancy_phase2_rls.sql
api/migrations/0003_multitenancy_phase2_drop_legacy_policies.sql
api/migrations/0004_multitenancy_phase3_unique_constraints.sql
supabase/migrations/003_non_production_files.sql
supabase/migrations/004_monthly_production_totals_rpc.sql
```

**FRESH-INSTALL NOTE for migration 0001:** by default, it seeds a "Frio Energy Holdings" tenant. For a different customer, you want to skip that:

In the Supabase SQL editor, before pasting `0001_multitenancy_phase1.sql`, run:
```sql
SET pa.bootstrap_frio = 'false';
```
Then paste and run the migration in the same SQL editor tab (the setting only applies to the current session). You'll see a NOTICE: "Skipping Frio tenant seed (pa.bootstrap_frio is false)."

**To apply each migration:**
1. Supabase dashboard → SQL Editor → "New query"
2. Paste the migration SQL
3. Click "Run" (or Cmd+Enter)
4. Confirm success (no red errors)
5. Repeat for the next migration

After all migrations:
- 13 tables in `public` schema
- 5 user-defined functions: `current_tenant_id`, `is_super_admin`, `monthly_production_totals`, `exec_sql_json`, `update_updated_at`
- 2 storage buckets: `production-files`, `non-production-files`
- RLS enabled on every data table

Verify with:
```sql
SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';
-- → 13
SELECT id FROM storage.buckets;
-- → production-files, non-production-files
```

---

## Step 4 · Create the first tenant + super-admin

The Admin UI in the app is gated by super-admin status. You can't make the first super-admin via the UI — chicken-and-egg. Use the bootstrap script.

From your local machine (with the repo cloned):

```bash
cd api
npm install   # if you haven't already

# Set env vars pointing at the NEW Supabase project
export SUPABASE_URL='https://<your-new-project-ref>.supabase.co'
export SUPABASE_SERVICE_KEY='<service-role-key-from-step-2>'

# Run the bootstrap
npx tsx scripts/bootstrap-first-tenant.ts \
  --tenant-name "Acme Energy"                   \
  --tenant-slug acme                            \
  --tenant-alias acme.prod@stewardship.is       \
  --admin-email founder@acme.example
```

The script:
1. Inserts a row into `tenants` for the new customer
2. Calls Supabase Auth's admin API to invite the super-admin user (they get a magic-link email)
3. Inserts a row into `user_tenants` linking the user to the tenant with `is_super_admin = true`

The super-admin clicks the magic link, sets a password, and they're in.

---

## Step 5 · Set up Gmail for the inbound address

The system polls a Google Workspace mailbox via the Gmail API. Two parts:

### 5a. Choose the mailbox and create aliases

Pick the mailbox the poller will read from. The existing system uses `S.IS_AD_Prod@stewardship.is`. For a fresh install, this can be:
- The same mailbox (if you have access) — just add a new alias for the new tenant
- A new mailbox in your own Google Workspace tenant

Either way, in **Google Workspace Admin Console → Users → [the mailbox user] → User information → Email aliases**, add an alias matching the `email_alias` you used in the bootstrap (e.g. `acme.prod@stewardship.is`). Operators send to this alias; Google routes it to the underlying mailbox.

### 5b. Create OAuth credentials

1. **Google Cloud Console** → APIs & Services → Library → enable "Gmail API"
2. APIs & Services → Credentials → Create credentials → OAuth client ID
   - Application type: Desktop
   - Name: `production-aggregator-poller`
3. Note the **client ID** and **client secret** that appear
4. (If your Workspace requires it) Verify the app via the consent screen flow

### 5c. Generate the refresh token

From your local machine:
```bash
cd api
# Add to api/.env (gitignored):
#   GMAIL_CLIENT_ID=...
#   GMAIL_CLIENT_SECRET=...

npx tsx scripts/get-gmail-refresh-token.ts
```
The script prints a URL. Open it in a browser logged in as the polling mailbox user (e.g. `S.IS_AD_Prod@`). Click "Allow." Paste the redirected code back into the script. It prints the refresh token. **Save it** — you'll need it for Railway env vars.

---

## Step 6 · Create the Railway service

1. Railway dashboard → New project → "Deploy from GitHub repo" → pick your repo
2. Set environment variables (Settings → Variables):

   | Variable | Value |
   |---|---|
   | `SUPABASE_URL` | from Step 2 |
   | `SUPABASE_SERVICE_KEY` | from Step 2 |
   | `GMAIL_CLIENT_ID` | from Step 5b |
   | `GMAIL_CLIENT_SECRET` | from Step 5b |
   | `GMAIL_REFRESH_TOKEN` | from Step 5c |
   | `GMAIL_MONITORED_EMAIL` | the mailbox address (e.g. `S.IS_AD_Prod@stewardship.is`) |
   | `VITE_SUPABASE_URL` | same as `SUPABASE_URL` |
   | `VITE_SUPABASE_ANON_KEY` | from Step 2 (the anon key) |
   | `NODE_ENV` | `production` |

3. Railway auto-builds and deploys on the next push. Watch the Deployments tab.
4. After ~3–4 min, the service should be running. Test:
   ```bash
   curl https://<your-railway-domain>.up.railway.app/health
   # Expected: {"status":"ok","service":"ProductionAggregator API",...}
   ```

For a deeper Railway walkthrough, see [`RAILWAY_SETUP.md`](../../RAILWAY_SETUP.md).

---

## Step 7 · Custom domain (optional)

1. Railway → Settings → Domains → "Add custom domain" → enter your domain
2. Railway gives you a CNAME target. In your DNS provider, add a CNAME record pointing your subdomain (e.g. `productionaggregator.acme.com`) at Railway's target.
3. Wait ~5–60 min for DNS propagation.
4. Railway auto-provisions a TLS cert.

---

## Step 8 · First-login verification

1. Open `https://<your-domain>` → you should see the login page
2. Sign in as the super-admin user (from Step 4 — they should have set a password via the magic-link email)
3. You should land on `/dashboard`. It will be empty (no emails ingested yet).
4. Click "Admin" in the sidebar — you should see the tenant management UI. If you DON'T see "Admin" in the sidebar, the user isn't flagged as super-admin. Verify via SQL:
   ```sql
   SELECT * FROM user_tenants WHERE user_id IN (
     SELECT id FROM auth.users WHERE email = 'founder@acme.example'
   );
   -- is_super_admin should be true
   ```
5. Click "Monthly Export" → pick any month range → click "Generate & Download" → should download a valid empty XLSX (header row only, no data — because nothing's been ingested yet).

---

## Step 9 · First real email

To exercise the full pipeline:
1. Have an operator send a production report to the tenant's alias (or forward one of the sample files from the repo root — `PDSWDX-MP-Anadarko-MONTHLY.pdf` etc — to `acme.prod@stewardship.is`)
2. Wait up to 5 min for the next poll cycle (or trigger immediately: `curl -X POST https://<your-domain>/api/poll`)
3. Check the dashboard's "Recent activity" section — you should see the email appear with status `completed`
4. Run a sanity query:
   ```sql
   SELECT COUNT(*) FROM production_monthly;
   -- Should be > 0
   ```

---

## Step 10 · (Optional) Import the ComboCurve well catalog

If the new customer uses ComboCurve, get a well-header export from their ComboCurve account and import:

```bash
cd api
npx tsx scripts/import-combocurve-catalog.ts /path/to/well-headers.csv
```

This populates `combocurve_wells` so the export's "Well ID" column is filled in.

---

## What to do if something doesn't work

- **Migrations fail** → read the error. Most common: applied out of order. Check `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'` to see what's already there.
- **Login works but app is empty** → see [database/02-rls-and-tenancy.md](../database/02-rls-and-tenancy.md#the-i-just-deployed-and-now-every-query-returns-nothing-failure-mode)
- **Email arrives but isn't ingested** → see [runbooks/gmail-poller-stopped.md](../runbooks/gmail-poller-stopped.md)
- **Email ingested but parser failed** → see [runbooks/parser-failing.md](../runbooks/parser-failing.md)
- **Railway build failing** → check the Deployments tab logs; most build failures are env-var or Node-version related

---

## Checklist for a verified fresh install

- [ ] Repo cloned/forked
- [ ] New Supabase project provisioned
- [ ] All 8 migrations applied (Frio seed skipped if not Stewardship.IS)
- [ ] First tenant + super-admin created via bootstrap script
- [ ] Gmail mailbox + alias + OAuth credentials set up
- [ ] Refresh token generated and stored
- [ ] Railway service deployed with all 9 env vars
- [ ] `/health` returns 200
- [ ] Custom domain (if any) resolving via TLS
- [ ] Super-admin can log in and reach `/admin`
- [ ] Empty Monthly Export download succeeds (header-only XLSX)
- [ ] First real operator email ingests with status=completed
- [ ] (Optional) ComboCurve catalog imported

At that point you have a working clone. Ongoing operations: see [03-monitoring.md](03-monitoring.md) and the [runbooks/](../runbooks/).
