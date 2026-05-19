# 04 · Onboarding a New Client (Tenant)

This doc is a pointer. The full runbook is in [`/ONBOARDING_NEW_CLIENT.md`](../../ONBOARDING_NEW_CLIENT.md) at the repo root.

Quick summary of what onboarding does:

1. **Create the tenant in the Admin UI** — gives them a `tenants` row with a unique slug + email alias
2. **Set up a Gmail Workspace alias** on `S.IS_AD_Prod@stewardship.is` so operators have a destination to send to
3. **Invite the client's user(s)** via the Admin page → triggers a Supabase Auth invite + creates `user_tenants` row
4. **Verify isolation** — log in as the new client, confirm they see only their own data; log in as a different tenant, confirm they don't see the new one's data

Estimated time per onboarding: 15–30 min the first time, 10 min once you've done it twice.

## Quick reference: what gets created

| Artifact | Where | How |
|---|---|---|
| `tenants` row | Supabase | Admin UI → "Create tenant" |
| Gmail alias | Google Workspace | Admin Console → S.IS_AD_Prod user → Add alias |
| Supabase Auth user | Supabase Auth | Admin UI → "Invite user" |
| `user_tenants` row | Supabase | Created automatically by the invite endpoint |

## Common pitfalls

- **Forgetting the Gmail alias.** Tenant exists in DB but operators have nowhere to send emails. Symptom: tenant user logs in, sees zero data forever.
- **Alias propagation lag.** Gmail aliases take 5–60 minutes to start receiving mail. If you test immediately and don't see the message, wait.
- **User invited to wrong tenant.** Caught by the verification step (log in as the new user, confirm tenant matches).

See the full runbook for screenshots, exact admin-console paths, and troubleshooting.
