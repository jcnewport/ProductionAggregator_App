/**
 * Onboarding Route Handlers  (Phase 5 — multi-tenancy)
 * -----------------------------------------------------
 *
 * The admin-only endpoints Caleb uses to bring a new client online.
 * A full onboarding is a three-step dance:
 *
 *   1. POST /api/admin/onboarding/tenants
 *        Create the tenant row. The email_alias is auto-derived from the
 *        slug, e.g. slug="acme" -> s.is_acme_prod@stewardship.is. Caleb
 *        still has to set up the Gmail forwarding rule in Google Workspace
 *        separately — the endpoint's response flags that as a manual todo.
 *
 *   2. POST /api/admin/onboarding/invite
 *        Invite the client's primary user via Supabase Auth (sends a magic
 *        link), then link them to the tenant via user_tenants. The
 *        is_super_admin flag is ALWAYS false here — only Caleb is the
 *        super-admin. A future "promote" endpoint can flip that if we
 *        ever hand the keys to someone else.
 *
 *   3. GET /api/admin/onboarding/tenants
 *        List existing tenants so the admin UI can populate the dropdown
 *        when inviting additional users to an existing tenant.
 *
 * AUTH: this whole router is mounted behind
 *   requireAuthMaybe + requireTenantMaybe + requireSuperAdmin
 * in index.ts. Regular tenant users cannot touch any of these.
 */

import { Router, type Request, type Response } from 'express';
import { supabase } from '../services/supabase.js';

const router = Router();

/**
 * Slug validator — lowercase letters, digits, and single hyphens.
 * Bounds: 2..30 chars. The slug shows up in:
 *   • the email alias: s.is_<slug>_prod@stewardship.is
 *   • future UI URLs
 * So we're strict about what goes in here to avoid address headaches.
 */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Email sanity check. Intentionally forgiving — real validation happens
 * when Supabase Auth actually sends the invite.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Build the Gmail alias for a given slug. One place so the rule stays
 * consistent — the email poller's route-loader reads from the tenants
 * table so we just need to seed the right value here.
 */
function buildEmailAlias(slug: string): string {
  return `s.is_${slug}_prod@stewardship.is`;
}

/* ────────────────────────────────────────────────────────────────
 * POST /api/admin/onboarding/tenants
 * Create a new tenant. Body: { name, slug, notes? }
 * ──────────────────────────────────────────────────────────────── */
router.post('/tenants', async (req: Request, res: Response) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const rawSlug = typeof req.body?.slug === 'string' ? req.body.slug.trim().toLowerCase() : '';
    const notes = typeof req.body?.notes === 'string' ? req.body.notes.trim() : null;

    if (!name) {
      res.status(400).json({ ok: false, error: 'name is required.' });
      return;
    }
    if (!SLUG_RE.test(rawSlug) || rawSlug.length < 2 || rawSlug.length > 30) {
      res.status(400).json({
        ok: false,
        error:
          'slug must be 2–30 chars, lowercase letters/digits/hyphens only (e.g. "acme-energy").',
      });
      return;
    }

    const emailAlias = buildEmailAlias(rawSlug);

    // Insert. Unique constraints on (slug) and (email_alias) will bounce duplicates.
    const { data, error } = await supabase
      .from('tenants')
      .insert({
        name,
        slug: rawSlug,
        email_alias: emailAlias,
        notes,
        is_active: true,
      })
      .select('id, name, slug, email_alias, is_active, created_at')
      .single();

    if (error) {
      // Surface duplicate-key in a readable way.
      const msg = /duplicate key/i.test(error.message)
        ? `A tenant with slug "${rawSlug}" already exists.`
        : error.message;
      res.status(400).json({ ok: false, error: msg });
      return;
    }

    res.status(201).json({
      ok: true,
      tenant: data,
      nextSteps: [
        `Create a Gmail alias in Google Workspace: ${emailAlias}`,
        'Add a filter forwarding that alias to the main S.IS_AD_Prod inbox',
        `POST /api/admin/onboarding/invite with { tenantId: "${data.id}", email: "<client email>" } to invite the client's primary user`,
      ],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: msg });
  }
});

/* ────────────────────────────────────────────────────────────────
 * GET /api/admin/onboarding/tenants
 * List all tenants (for the admin UI's dropdown).
 * ──────────────────────────────────────────────────────────────── */
router.get('/tenants', async (_req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('tenants')
      .select('id, name, slug, email_alias, is_active, created_at, notes')
      .order('created_at', { ascending: false });

    if (error) {
      res.status(500).json({ ok: false, error: error.message });
      return;
    }
    res.json({ ok: true, tenants: data ?? [] });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: msg });
  }
});

/* ────────────────────────────────────────────────────────────────
 * POST /api/admin/onboarding/tenants/:id/deactivate
 * Soft-disable a tenant. The email poller skips inactive tenants,
 * so this immediately stops new ingestion without deleting any data.
 * ──────────────────────────────────────────────────────────────── */
router.post('/tenants/:id/deactivate', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const { data, error } = await supabase
      .from('tenants')
      .update({ is_active: false })
      .eq('id', id)
      .select('id, is_active')
      .maybeSingle();
    if (error) {
      res.status(500).json({ ok: false, error: error.message });
      return;
    }
    if (!data) {
      res.status(404).json({ ok: false, error: 'Tenant not found.' });
      return;
    }
    res.json({ ok: true, tenant: data });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: msg });
  }
});

/* ────────────────────────────────────────────────────────────────
 * POST /api/admin/onboarding/tenants/:id/reactivate
 * Flip a previously-deactivated tenant back on. Mirrors /deactivate.
 * ──────────────────────────────────────────────────────────────── */
router.post('/tenants/:id/reactivate', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const { data, error } = await supabase
      .from('tenants')
      .update({ is_active: true })
      .eq('id', id)
      .select('id, is_active')
      .maybeSingle();
    if (error) {
      res.status(500).json({ ok: false, error: error.message });
      return;
    }
    if (!data) {
      res.status(404).json({ ok: false, error: 'Tenant not found.' });
      return;
    }
    res.json({ ok: true, tenant: data });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: msg });
  }
});

/* ────────────────────────────────────────────────────────────────
 * POST /api/admin/onboarding/invite
 * Invite a user (via Supabase Auth magic link) and link them to a tenant.
 * Body: { tenantId: string, email: string }
 *
 * Behavior:
 *   1. Sanity-check that the tenant exists and is_active=true.
 *   2. Call supabase.auth.admin.inviteUserByEmail(email). Supabase handles
 *      dedup — if the user already exists, we get their user id back.
 *   3. Insert user_tenants(user_id, tenant_id, is_super_admin=false).
 *      Conflict-tolerant: if the link already exists, we treat it as
 *      "already linked" and return 200.
 * ──────────────────────────────────────────────────────────────── */
router.post('/invite', async (req: Request, res: Response) => {
  try {
    const tenantId = typeof req.body?.tenantId === 'string' ? req.body.tenantId.trim() : '';
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';

    if (!tenantId) {
      res.status(400).json({ ok: false, error: 'tenantId is required.' });
      return;
    }
    if (!EMAIL_RE.test(email)) {
      res.status(400).json({ ok: false, error: 'A valid email is required.' });
      return;
    }

    // ── 1. Verify the tenant exists and is active ──
    const { data: tenant, error: tenantErr } = await supabase
      .from('tenants')
      .select('id, name, slug, email_alias, is_active')
      .eq('id', tenantId)
      .maybeSingle();
    if (tenantErr) {
      res.status(500).json({ ok: false, error: tenantErr.message });
      return;
    }
    if (!tenant) {
      res.status(404).json({ ok: false, error: 'Tenant not found.' });
      return;
    }
    if (!tenant.is_active) {
      res.status(400).json({
        ok: false,
        error: `Tenant "${tenant.name}" is deactivated — reactivate it before inviting users.`,
      });
      return;
    }

    // ── 2. Invite the user via Supabase Auth admin API ──
    // inviteUserByEmail sends a magic link. If the user already exists,
    // Supabase returns the existing user id (no duplicate invite is sent).
    const { data: invited, error: inviteErr } =
      await supabase.auth.admin.inviteUserByEmail(email);

    // Supabase returns "A user with this email address has already been registered"
    // when the user exists. In that case we need to look them up manually by email
    // because inviteUserByEmail doesn't return the existing user on conflict.
    let userId: string | null = invited?.user?.id ?? null;
    let inviteSent = !inviteErr;

    if (!userId) {
      // Fall back to listing users and finding by email. listUsers returns up
      // to 50 per page by default; the email filter narrows to one result.
      const { data: list, error: listErr } = await supabase.auth.admin.listUsers({
        page: 1,
        perPage: 200,
      });
      if (listErr) {
        res.status(500).json({
          ok: false,
          error: `Invite failed and lookup fallback failed: ${listErr.message}`,
        });
        return;
      }
      const match = (list?.users ?? []).find(
        (u) => (u.email ?? '').toLowerCase() === email
      );
      if (match) {
        userId = match.id;
        inviteSent = false; // existing user — no magic link was newly sent
      }
    }

    if (!userId) {
      res.status(500).json({
        ok: false,
        error: `Could not create or locate user for email "${email}": ${
          inviteErr?.message ?? 'unknown error'
        }`,
      });
      return;
    }

    // ── 3. Link the user to the tenant ──
    // PK on user_tenants is (user_id), so a second invite for the same
    // user would UPDATE their tenant. We treat that as a re-assignment
    // and log a warning so it's visible in the response.
    const { data: existingLink, error: existingLinkErr } = await supabase
      .from('user_tenants')
      .select('tenant_id, is_super_admin')
      .eq('user_id', userId)
      .maybeSingle();
    if (existingLinkErr) {
      res.status(500).json({ ok: false, error: existingLinkErr.message });
      return;
    }

    let reassigned = false;
    if (existingLink) {
      if (existingLink.tenant_id === tenantId) {
        // Already linked to this tenant — idempotent.
      } else {
        // Already linked to a DIFFERENT tenant. Don't silently steal them —
        // require a deliberate reassignment via a separate future endpoint
        // so we never accidentally move a super-admin out of their tenant.
        res.status(409).json({
          ok: false,
          error:
            `User ${email} is already linked to a different tenant. ` +
            'Use a reassignment operation (not yet built) instead of /invite.',
        });
        return;
      }
    } else {
      const { error: linkErr } = await supabase
        .from('user_tenants')
        .insert({
          user_id: userId,
          tenant_id: tenantId,
          is_super_admin: false,
        });
      if (linkErr) {
        res.status(500).json({ ok: false, error: linkErr.message });
        return;
      }
      reassigned = false;
    }

    res.status(201).json({
      ok: true,
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
      user: { id: userId, email },
      inviteSent,
      reassigned,
      nextSteps: inviteSent
        ? [
            `An invite email was sent to ${email}. They should click the magic link to set a password.`,
            `Production emails sent to ${tenant.email_alias} will now be ingested for this tenant.`,
          ]
        : [
            `User ${email} already had an account — no new invite was sent.`,
            `They can log in with their existing password and will see ${tenant.name}'s data.`,
          ],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: msg });
  }
});

export default router;
