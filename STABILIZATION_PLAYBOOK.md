# Stabilization Playbook

**Status:** Phase 3 complete. System is in a 2–4 week watch period starting 2026-04-22.
**Goal:** Let the app run against real email traffic. Catch edge cases that only production shows. Build nothing new unless something breaks.

---

## What "stabilization" means for you

No new features. No refactors. You're running the car on the highway to see what rattles before you add a roof rack. During this period:

- **Keep forwarding real operator emails** to `S.IS_AD_Prod@stewardship.is` as you normally would.
- **Do a short daily check** (2 minutes) and a slightly longer weekly review (10 minutes).
- **When something fails, bring it to Claude** — don't try to fix it yourself. That's the whole point of the direct-to-Claude workflow you chose instead of the Mapping UI.
- **Resist the urge to add features.** The moment you change something, you restart the stability clock.

---

## Daily check — 2 minutes

Do this once a day, ideally with your morning coffee.

**Step 1.** Open the app at https://productionaggregator.stewardship.is and sign in.

**Step 2.** Look at the Dashboard. You care about three things:

| What to look at | What normal looks like | What bad looks like |
|---|---|---|
| Recent Activity card | Green "completed" rows | Red "failed" or orange "partial" rows |
| LIVE dot in header | Pulsing green | Missing or stale timestamp |
| Flagged imports count | 0 or a small steady number | A count that's growing day over day |

**Step 3.** If everything's green, close the tab — you're done. Total time: 90 seconds.

**Step 4.** If you see a red or orange row, copy the **gmail_message_id** from that row (or just the email subject + filename) and paste it into a Claude chat along with the exact phrasing in the "When a file fails" section below.

---

## Weekly check — 10 minutes

Do this every Monday morning or whenever feels natural.

### A. Export a recent batch and spot-check it

1. Go to **Monthly Export** in the nav.
2. Select last month's date range.
3. Click **Generate & Download**.
4. Open the Excel file. Verify:
   - Column count is 16 (matches ComboCurve template).
   - Well names look right (no strange abbreviations or duplicates).
   - Oil/Gas/Water volumes look reasonable (not wildly high or low for that well).
   - API10 column shows leading zeros correctly (e.g. `4230136843` — not `4.23E+09`).

If any column looks wrong, take a screenshot and bring it to Claude.

### B. Review the email log

1. On the Dashboard, scroll the Recent Activity card.
2. Expand the date filter to "last 7 days."
3. Count: how many **completed**, how many **failed**, how many **partial**, how many **flagged**?
4. Write the numbers down in your notes. You're looking for trends over weeks:
   - Failed rate trending up → a format is drifting or a new operator showed up.
   - Flagged rate trending up → the validators are catching bad data (could be parser bug, could be operator sending garbage).
   - Everything green → healthy.

### C. Spot-check one random well

1. Pick a well you know well (pun intended) — maybe RUTHLESS 1H or HIDEOUT 24-13 STATE COM #1H.
2. Download the daily export for that well for the last full month.
3. Compare the numbers to what the operator told you directly (if you have it). Or at least sanity-check against last month's shape.
4. If the numbers look off by more than a rounding error, bring it to Claude.

---

## When a file fails — the exact Claude prompt to use

Open a new Claude chat (desktop app or web) in the **ProductionAggregator_App** project and paste this template, filling in the parts in curly braces:

```
A file failed parsing in production. Here's what I see in the dashboard:

- Email subject: {copy from dashboard}
- Sender: {copy from dashboard}
- Filename: {copy from dashboard}
- gmail_message_id: {copy from dashboard}
- Status: {failed or partial}
- Error message: {copy from dashboard}

I'm attaching the original file. Can you (1) inspect it, (2) tell me whether
it's a new operator format or a drift on an existing parser, (3) write or fix
the parser, and (4) give me the GitHub Desktop commit message so I can push it?
```

Then **drag-drop the original attachment into the Claude chat** (or upload it from the workspace). Claude will do the rest. Expected turnaround: 30–60 minutes per new format, faster for a drift-on-existing-parser fix.

**Where to find the original file:** In your Gmail, search `to:S.IS_AD_Prod has:attachment` and find the email. Or look in your Supabase Storage bucket (production-files) under the date the email arrived.

---

## What you should NOT do during stabilization

- **Do not** forward files Claude has already parsed successfully hoping to "reprocess" them. The dedupe logic (`gmail_message_id` check) will just skip them, and you'll get confused.
- **Do not** manually edit rows in the Supabase database. If something's wrong, fix the parser and let it re-run.
- **Do not** add new operators to the `operators` table manually — the pipeline creates them as needed.
- **Do not** change environment variables on Railway. Everything is set correctly.
- **Do not** accept scope-creep requests from yourself. "While we're at it, let's add X" is exactly what stabilization periods are designed to prevent.

---

## Signals that stabilization should END

Wrap up the watch period early if any of these are true:

1. **Two full weeks with zero red rows.** The system has proven itself against real traffic — safe to start the next build.
2. **A client or prospect asks for a new feature you need to pitch on.** Stabilization is for you, not your customers. If there's revenue attached, pivot.
3. **You've onboarded 2+ new operators without any failures.** The data-driven fallback logic has been tested by reality.

Signals that stabilization should be **extended**:

1. **A new format category arrives that breaks the pipeline.** Add the adapter, reset the clock.
2. **A parser drift bug shows up.** Fix it, reset the clock.
3. **A security-related Railway or Supabase alert.** Address it, reset the clock.

---

## Quick reference — where things live

| What | Where |
|---|---|
| The app (you sign in here) | https://productionaggregator.stewardship.is |
| Dashboard | Same URL, landing page after login |
| Monthly export | Same URL → Monthly Export in nav |
| Daily export | Same URL → Daily Export in nav |
| Export history (re-downloads) | Same URL → Export History in nav |
| Code repo (GitHub) | https://github.com/jcnewport/ProductionAggregator_App |
| Railway logs | railway.app → ProductionAggregator project → Deployments → View Logs |
| Supabase data | supabase.com → ProductionAggregator_App → Table Editor |
| Monitored Gmail inbox | `S.IS_AD_Prod@stewardship.is` (delivered to c@stewardship.is, label "Production Reports") |
| Operator file format catalog | Source of truth is the project brief in Claude; code in `api/src/parsers/` |

---

## When stabilization ends — what's next?

When you're ready to build the next thing, open a Claude chat in this project and say: **"Stabilization went well. Let's pick the next build direction."**

Claude will ask you what your biggest business priority is. Options you might consider, in no particular order:

- **Client-facing portal** — let your clients (Kyle Parker / EPK Capital etc.) log in and see their own data. Big feature. ~2–4 weeks.
- **Billing / invoicing** — automate the "X operators, Y files this month" invoice to yourself or your clients. ~1 week.
- **New export formats** — PDF reports, per-operator summaries, charts, ComboCurve API push instead of Excel download. ~1 week each.
- **Marketing site** — a public one-pager at stewardship.is explaining the service. ~2–3 days.
- **Analytics layer** — trends, decline curves, anomaly detection. Big feature. ~3–6 weeks.
- **Something you haven't thought of yet** — your call.

**Don't revive the Mapping Management UI** unless your operational reality changes (e.g. you hire someone who needs to set up mappings without touching code). You already chose not to build it; the reasoning still holds.

---

*Last updated 2026-04-22. This document is your reference for the next 2–4 weeks. Keep it open in a tab during your weekly check.*
