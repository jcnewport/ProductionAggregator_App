# Runbook · Rolling Back a Bad Deploy

**Symptom:** A recent push broke production. The app is misbehaving, returning errors, or producing wrong data.

You have ~3 minutes to roll back before users notice. Move with intention but not panic.

## Step 1 · Confirm it's actually the recent deploy

Check:
- Was there a push to `main` in the last hour?
- Does the symptom correlate with that push? (Compare timestamp of first user complaint vs `git log` on `main`)
- Does the deploy on Railway show the new commit hash?

If the answer to all three is yes, roll back.

If the symptom predates the deploy: don't roll back. Instead, investigate the actual root cause. Rolling back will not help and you'll lose forward progress.

## Step 2 · The fast revert

From your local Cowork session:

```bash
cd /sessions/<your-session>/repo

# Identify the bad commit:
git log --oneline -5

# Revert it:
git revert HEAD --no-edit       # for a single bad commit
# OR
git revert HEAD~2..HEAD --no-edit   # for the last 3 commits

# Push:
git push origin main
```

Railway sees the new commit and starts a fresh deploy. Within ~3 min, the reverted state is live.

If `git revert` produces conflicts (because subsequent commits depend on the reverted one), you have a harder call:
- Revert ALL the conflicting commits (back further in time)
- OR forward-fix instead of reverting

## Step 3 · If you can't push (network down, GitHub auth broken)

Roll back from the Railway dashboard:

1. Railway dashboard → service → Deployments tab
2. Find the previous good deployment (green dot, before the bad one)
3. Three-dot menu → "Redeploy"
4. Railway redeploys from that commit's build artifacts (no rebuild needed; very fast)

**Important:** this leaves `main` in a "deployed = older than HEAD" state. As soon as you push again, you redeploy whatever's at HEAD — which may still be broken. You MUST follow up with a real `git revert` and push, or your next push will reintroduce the bug.

## Step 4 · Verify the rollback

1. Hit `productionaggregator.stewardship.is/health` — should return 200
2. Load the dashboard — should render normally
3. Try the action that was broken (an export, a parser run, whatever)
4. Check Railway logs — the new errors should be gone

If errors persist, you may have reverted the wrong commit. Check Railway's "currently deployed" commit hash against `git log`.

## Step 5 · Diagnose, don't blame

After rollback is verified, debug the bad commit in a branch:

```bash
git checkout -b fix/whatever-broke main
git revert <revert-commit-sha>   # un-revert your revert, locally
# now you have the bad code back, in a branch
# fix it
git commit -am "Fix: the actual bug"
git push origin fix/whatever-broke
```

Open a PR or push to main once the fix is verified. Don't rush; the system is back to a working state, you have time.

## Special cases

### Bad database migration

If you applied a migration to Supabase that's now causing problems:

1. Roll back the code first (the steps above)
2. **Then** undo the schema change in Supabase:
   - For additive changes (new column, new index): leave them — they're not hurting anything
   - For destructive changes (dropped column, dropped table): you may need to restore from backup. Supabase Pro has automated daily backups in the dashboard.
   - For RLS policy changes that broke access: write a new policy that restores the old behavior, apply it via SQL editor

**Don't** edit the original migration SQL file in place. Add a new migration file that reverses the bad one:

```sql
-- supabase/migrations/00X_revert_bad_migration.sql
ALTER TABLE wells DROP COLUMN IF EXISTS the_bad_column;
```

### Frontend-only regression

If the bug is purely in the React frontend (visual glitch, broken modal), the rollback is the same — both build artifacts come from the same Git commit. There's no separate frontend rollback.

### Cron-related regression

If the email poller is now misprocessing emails because of the bad commit:

1. Roll back the code
2. After rollback is live, identify the affected emails: `SELECT id FROM email_log WHERE processed_at > '<bad deploy time>' AND status = 'completed';`
3. For each, you may want to wipe and reprocess to ensure they ran through the correct (rolled-back) parser logic:
   ```sql
   DELETE FROM production_monthly WHERE source_email_id IN (...);
   UPDATE email_log SET status = 'pending', retry_count = 0 WHERE id IN (...);
   ```
   Then `POST /api/admin/reprocess-failed`.

## After rollback: post-mortem

Once the dust settles, write a short post-mortem in your notes (or as a commit message on the fix):
- What broke
- Why the test/review didn't catch it
- What change you'll make to your process to catch this class of bug next time

The point isn't blame; it's that we get one free lesson per outage.
