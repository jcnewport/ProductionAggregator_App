# 05 · Stabilization Playbook (pointer)

The full stabilization playbook is at [`/STABILIZATION_PLAYBOOK.md`](../../STABILIZATION_PLAYBOOK.md) in the repo root.

## What stabilization means

After Phase 3 wrapped on 2026-04-22, the system entered a 2–4 week watch period. The goal: **let it run against real email traffic, catch edge cases that only production reveals, and resist the urge to build new things.**

## Daily check (2 min)

See [03-monitoring.md](03-monitoring.md#daily-2-minute-check).

## Weekly check (10 min)

See [03-monitoring.md](03-monitoring.md#weekly-10-minute-check).

## When a file fails

The full doc has the exact Claude prompt to use when an attachment fails parsing. The short version:

1. Note which `email_log_id` failed
2. Grab the original file from Supabase Storage (`production-files` bucket)
3. Run a peek script against it: `cd api && npx tsx scripts/peek-pdf.ts <path>` or `peek-xlsx.ts`
4. If the format changed: write a parser patch, push, retry the email via `/api/admin/reprocess-email`
5. If a fundamentally new format arrived: add a stub adapter first (so the dispatcher won't misroute future arrivals to a wrong parser), then implement the real adapter

## What NOT to do during stabilization

- Don't change the database schema unless something's broken
- Don't add new features to the frontend
- Don't change the cron cadence unless you have a specific reason
- Don't refactor parsers for "cleanliness" — they're code that handles ugly inputs, ugliness is appropriate

## When stabilization ends

Signals that the system is stable:
- 2+ consecutive weeks of zero `failed` emails (excluding genuinely unknown new formats)
- 0 `flagged_records` accumulation beyond what gets cleared the next day
- Tenant user reports zero unexpected behavior

After that, the team can resume feature work. See `STABILIZATION_PLAYBOOK.md` for the planned next phase.
