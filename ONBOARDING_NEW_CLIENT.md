# Onboarding a New Client — Step-by-Step Runbook

This runbook walks you through everything required to add a new client company to Stewardship.IS. Follow the steps in order. Allow **15–30 minutes** per client (longer the first time; faster once you've done it twice).

By the end of this process the new client will:
- Have their own tenant in the database (data walled off from every other client)
- Have their own dedicated email alias for operators to send production reports to
- Have a login they can use to see ONLY their own data (never Frio's, never another client's)

---

## Before You Start — Prerequisites

1. The latest build must be deployed (green on Railway). Check the **LIVE** badge in the app header.
2. You must be logged in as yourself (the super-admin). Only super-admins can see the **Admin** link in the top nav.
3. You need access to your Google Workspace admin console: `https://admin.google.com` — signed in with an account that has **User Management** privileges over the `stewardship.is` domain.
4. Decide on the client's **display name** (what you want to see in the UI, e.g., `Chevron USA`, `Devon Energy`, `Notting Hill Oil`) and a **slug** (a short, lowercase, hyphens-only identifier, e.g., `chevron`, `devon`, `notting-hill`). The slug becomes part of their email alias.

> **Slug rules:** 2–30 characters, lowercase letters, digits, and single hyphens only. Must start and end with a letter or digit. Examples that work: `exxon`, `west-pecos`, `bta-oil`. Examples that don't: `XTO` (uppercase), `-exxon` (leading hyphen), `exxon corp` (space).

---

## Phase 1 — Create the Tenant in the Admin UI

**What this step does:** Inserts a `tenants` row in the database and reserves the email alias. At this point no data can flow in yet — the email alias doesn't exist at Google yet.

### 1.1 Navigate to the Admin page

In the app, click the **Admin** pill in the top navigation (between "Export History" and the LIVE badge).

> 📸 *Screenshot placeholder: app header with "Admin" nav link highlighted*

You should land on a page titled **Client Onboarding** with three cards: *Create tenant*, *Invite user*, and *Existing tenants*.

### 1.2 Fill the "Create tenant" form

- **Display name:** Type the friendly company name, e.g., `Chevron USA`.
- **Slug:** Either let it auto-derive from the name, or type your own. As you type, the **Email alias preview** below the field live-updates to show exactly what address operators will send production reports to (e.g., `s.is_chevron_prod@stewardship.is`).

> 📸 *Screenshot placeholder: Create tenant card filled in, alias preview visible*

### 1.3 Click "Create tenant"

On success you'll see a green confirmation with a **Next steps** list, which is essentially an abbreviated version of Phase 2 and Phase 3 of this runbook. The new tenant also appears immediately in the **Existing tenants** table at the bottom of the page.

> 📸 *Screenshot placeholder: success confirmation with next-steps list*

**Verification:** scroll to the *Existing tenants* card at the bottom of the page. The new client should appear with status **Active** and a **Deactivate** button beside them.

---

## Phase 2 — Set Up the Gmail Workspace Alias

**What this step does:** Makes the email address you just reserved actually receive mail. Until this step is done, anything operators send to `s.is_<slug>_prod@stewardship.is` will bounce.

### 2.1 Open Google Workspace Admin Console

Go to `https://admin.google.com` and sign in as a Workspace admin for `stewardship.is`.

### 2.2 Find the `S.IS_AD_Prod` user

In the left sidebar: **Directory → Users**.

Find the user whose primary address is `s.is_ad_prod@stewardship.is`. Click on their row to open their user details panel.

> 📸 *Screenshot placeholder: Users list in Workspace Admin with S.IS_AD_Prod highlighted*

### 2.3 Add the new alias

Inside the user detail panel, click **User information → Email aliases** (sometimes labeled just "Aliases"). Click **Add alias**.

In the popup:
- **Alias:** Type the local part only — `s.is_<slug>_prod` (example: `s.is_chevron_prod`). Leave the domain as `stewardship.is`.
- Click **Save**.

> 📸 *Screenshot placeholder: Add alias dialog with field filled in*

### 2.4 Wait for propagation

Aliases usually become active within 1–5 minutes. Google sometimes warns that it can take up to 24 hours — in practice this has never been the case for us, but plan accordingly.

### 2.5 (Optional but recommended) Add a Gmail filter + label

This isn't required for the system to route mail correctly — the poller uses the `Delivered-To:` email header to identify the tenant, not a label. But a label makes the shared inbox much easier to skim visually when troubleshooting.

From any computer where you're logged into the `S.IS_AD_Prod` Gmail inbox:
1. Click the ⚙️ settings gear → **See all settings**.
2. Go to the **Filters and Blocked Addresses** tab.
3. Click **Create a new filter**.
4. In the **To** field, type the new alias (e.g., `s.is_chevron_prod@stewardship.is`).
5. Click **Create filter** (bottom right).
6. Check **Apply the label:** → **New label…** → name it `sis-prod-<slug>` (example: `sis-prod-chevron`). Click **Create**.
7. Click **Create filter** one more time to save.

> 📸 *Screenshot placeholder: Gmail filter creation dialog with To field + label assignment*

### 2.6 Verify the alias works

From any email client (your phone works fine), send a test email to the new alias. Within a few seconds the `S.IS_AD_Prod` inbox should receive it. If it bounces, the alias isn't active yet — wait a few minutes and retry.

---

## Phase 3 — Invite the Client's User

**What this step does:** Creates a Supabase auth account for the client contact and links them to their tenant in `user_tenants` with `is_super_admin=false`. They'll get an email from Supabase with a sign-in link.

### 3.1 Go back to the Admin page in the app

Click **Admin** in the top nav if you've navigated away.

### 3.2 Fill the "Invite user" card

- **Email address:** Your client contact's business email (e.g., `dana@chevron.com`).
- **Tenant:** Select the client you just created from the dropdown.

> 📸 *Screenshot placeholder: Invite user card filled in with tenant dropdown open*

### 3.3 Click "Send invite"

On success you'll see a confirmation. Behind the scenes:
- Supabase sends the user an invitation email with a one-click sign-in link.
- The system links their user ID to the tenant with `is_super_admin=false`.
- If the email already exists in Supabase (e.g., they're already a Stewardship.IS user), the system links the existing account instead of creating a duplicate. The only time this fails is if they're *already linked to a different tenant* — you'll see a `409` error, meaning a single user can't belong to two clients. If this happens, talk to me before proceeding.

### 3.4 Client sets their password

The client receives an email from Supabase. When they click the link:
1. They're taken to a page to set their password.
2. After setting it, they're logged into the Stewardship.IS app.
3. They will see ONLY their own tenant's data. They will NOT see an **Admin** nav link (only you see that).

If the invitation email doesn't arrive within 10 minutes, ask them to check spam. If still nothing, open the Admin page and click **Resend invite** (will be added in a later release; for now, ping me and I can trigger a resend via Supabase dashboard).

---

## Phase 4 — Verify Isolation

**What this step does:** Proves that data is actually walled off before you tell the client "we're live."

### 4.1 Send a test production report

Ask the client's operator (or simulate by using a sample file from `/sample_data/`) to send an email with a production-report attachment to the new alias. Wait 5–15 minutes for the next poll cycle (or manually trigger `/api/poll` if you're the super-admin).

### 4.2 Verify routing as super-admin

Log into the app as yourself. Go to **Dashboard**. The test email should appear in the recent processing activity with the correct client name in the tenant column (if we surface that).

### 4.3 Verify isolation as the client

Ask the client (or log in with a throwaway second account you've linked to a *different* tenant) to confirm they can see their new production data. Then verify they **cannot** see Frio's or any other client's data — every page (Dashboard, Monthly Export, Daily Export, Export History) should be scoped to just their rows.

If anything cross-leaks, STOP and open a ticket — this would be a regression in the tenant-isolation RLS policies, which were tested at launch and should not degrade.

---

## Quick Reference — Turnover Checklist

Use this as a one-page summary once you've done a few onboardings:

- [ ] Tenant created in Admin UI (`/admin/onboarding`)
- [ ] Slug verified, alias preview matches expected `s.is_<slug>_prod@stewardship.is`
- [ ] Email alias added in Google Workspace under the `S.IS_AD_Prod` user
- [ ] (Optional) Gmail filter + label `sis-prod-<slug>` created
- [ ] Test email to alias confirmed received
- [ ] Client user invited via Admin UI
- [ ] Client received + accepted invite, set password
- [ ] Client sent test production report, data appeared in their tenant only
- [ ] Client confirmed they cannot see any other tenant's data

---

## Troubleshooting

**"I don't see the Admin link in the header."**
You're not a super-admin on this account. Only the super-admin (currently `c@stewardship.is`) sees it. Verify you're logged in with the correct account.

**"The alias preview shows a slug I didn't type."**
The form auto-derives a slug from the display name. You can override it by typing directly into the slug field. Save will fail with a clear error if your slug doesn't match the rules.

**"I got a 409 when inviting a user."**
That email already exists in Supabase and is linked to a different tenant. A user can only belong to one tenant. Ask me to help — usually the fix is either (a) use a different email for this tenant, or (b) remove the old user_tenants link before creating the new one.

**"I sent a test email to the alias and it bounced."**
The Gmail Workspace alias hasn't propagated yet, OR you typed it wrong when creating it. Go back to Workspace admin → the user → Email aliases and confirm the exact spelling.

**"Operator sent production but nothing showed up on the client's dashboard."**
Three possible causes, in order of likelihood:
1. The poller hasn't run yet. Poll cycle is every 15 minutes; be patient or trigger `/api/poll` manually.
2. The operator sent to the *wrong* alias (e.g., the old `s.is_ad_prod@stewardship.is` instead of the new client-specific one). Check the `S.IS_AD_Prod` inbox — the email should carry a `Delivered-To` header matching the new alias.
3. The parser didn't recognize the attachment format. Check **Dashboard → Flagged imports** for the email; if it's there, the data is in the database under `flagged_records` and needs a format mapping.

**"The client logged in but their dashboard is empty."**
Expected if no production data has landed for them yet. Dashboard populates as operators start sending to the new alias. If they had historical data that needs to be imported, that's a separate bulk-import task — flag it for me and we'll handle the backfill.

---

## Behind the Scenes — What's Actually Happening

For your own mental model (not required reading, but helps when something goes sideways):

1. **Create tenant** → `INSERT INTO tenants (name, slug, email_alias, is_active)`. The email alias is now a *reserved claim* in our database, but Google doesn't know about it yet.
2. **Gmail alias** → Google Workspace routes any mail sent to `s.is_<slug>_prod@stewardship.is` into the shared `S.IS_AD_Prod` inbox, adding a `Delivered-To:` header.
3. **Email poller** (runs every 15 min on Railway) → reads new emails from the inbox, pulls the `Delivered-To` header, looks up which tenant that alias belongs to, stamps `tenant_id` on every row it writes.
4. **Invite user** → Supabase `inviteUserByEmail` creates an auth account + sends the email. We then `INSERT INTO user_tenants (user_id, tenant_id, is_super_admin=false)` to link them.
5. **Client logs in** → Their session has their `user_id`. Every read/write to tenant-scoped tables goes through Postgres RLS, which runs `tenant_id = current_tenant_id()` against their `user_tenants` row. Any data not matching is silently filtered out — they *literally cannot see it* even if the frontend requested it.

The combination of Phase 1 (DB row) + Phase 2 (Google alias) + Phase 3 (user link) is what makes the whole chain work. Skip any one of them and things break in predictable ways: no DB row → poller can't route the mail; no Google alias → mail bounces; no user link → client sees an empty dashboard.
