/**
 * OnboardingPage — Phase 5
 *
 * Super-admin surface for bringing a new client tenant online. Two simple
 * stacked cards:
 *
 *   1. "Create a new tenant"
 *      Inputs: name, slug, notes. Shows the derived email alias live so
 *      Caleb can see exactly what needs to be set up in Google Workspace.
 *
 *   2. "Invite a user"
 *      Inputs: tenant (dropdown populated from /api/admin/onboarding/tenants),
 *      user's email. Sends a magic-link invite via Supabase Auth and creates
 *      the user_tenants link.
 *
 *   3. "Existing tenants" table — shows all tenants with a quick
 *      deactivate/reactivate button so Caleb can flip a client off if the
 *      contract ends, without deleting any data.
 *
 * Auth: protected by ProtectedRoute + the caller's session token. The backend
 * enforces the super-admin gate; if a regular tenant user somehow navigates
 * here the POSTs will 403, and we also hide the "Admin" nav link in Layout
 * when isSuperAdmin is false.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../utils/supabase';
import { colors, radii, shadows, transitions } from '../theme';

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  email_alias: string;
  is_active: boolean;
  created_at: string;
  notes: string | null;
}

/** ── small helper to build the authenticated fetch ── */
async function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token ?? '';
  const headers = new Headers(init.headers ?? {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(path, { ...init, headers });
}

/** Very-short success toast inline next to a form after an action completes. */
function InlineStatus({
  kind,
  children,
}: {
  kind: 'success' | 'error';
  children: React.ReactNode;
}) {
  const bg = kind === 'success' ? colors.successBg : colors.dangerBg;
  const fg = kind === 'success' ? colors.success : colors.danger;
  return (
    <div
      style={{
        padding: '10px 14px',
        backgroundColor: bg,
        color: fg,
        borderRadius: radii.md,
        fontSize: '13px',
        marginTop: '12px',
        lineHeight: 1.4,
      }}
    >
      {children}
    </div>
  );
}

/** Single input w/ label column — keeps the form neat. */
function FieldRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: 'block', marginBottom: '14px' }}>
      <div
        style={{
          fontSize: '12px',
          fontWeight: 600,
          color: colors.textMuted,
          marginBottom: '6px',
          textTransform: 'uppercase',
          letterSpacing: '0.4px',
        }}
      >
        {label}
      </div>
      {children}
      {hint && (
        <div
          style={{
            fontSize: '12px',
            color: colors.textMuted,
            marginTop: '4px',
            lineHeight: 1.4,
          }}
        >
          {hint}
        </div>
      )}
    </label>
  );
}

const INPUT_STYLE: React.CSSProperties = {
  width: '100%',
  padding: '9px 12px',
  borderRadius: radii.lg,
  border: `1px solid ${colors.borderCard}`,
  fontSize: '14px',
  backgroundColor: colors.surface,
  color: colors.midnightNavy,
  outline: 'none',
  boxSizing: 'border-box',
  transition: transitions.snappy,
};

const CARD_STYLE: React.CSSProperties = {
  backgroundColor: colors.surface,
  border: `1px solid ${colors.borderCard}`,
  borderRadius: radii.xl,
  padding: '22px 24px',
  marginBottom: '20px',
  boxShadow: shadows.card,
};

const CARD_TITLE_STYLE: React.CSSProperties = {
  margin: 0,
  fontSize: '15px',
  fontWeight: 700,
  color: colors.midnightNavy,
  marginBottom: '4px',
};

const CARD_SUBTITLE_STYLE: React.CSSProperties = {
  margin: 0,
  fontSize: '13px',
  color: colors.textMuted,
  marginBottom: '20px',
  lineHeight: 1.5,
};

export default function OnboardingPage() {
  /* ── Create-tenant form state ── */
  const [newName, setNewName] = useState('');
  const [newSlug, setNewSlug] = useState('');
  const [newNotes, setNewNotes] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createStatus, setCreateStatus] = useState<
    | { kind: 'success' | 'error'; message: React.ReactNode }
    | null
  >(null);

  /* ── Invite form state ── */
  const [inviteTenantId, setInviteTenantId] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteStatus, setInviteStatus] = useState<
    | { kind: 'success' | 'error'; message: React.ReactNode }
    | null
  >(null);

  /* ── Tenants list ── */
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [tenantsLoading, setTenantsLoading] = useState(false);
  const [tenantsError, setTenantsError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const derivedAlias = useMemo(() => {
    const slug = newSlug.trim().toLowerCase();
    if (!slug) return '';
    return `s.is_${slug}_prod@stewardship.is`;
  }, [newSlug]);

  const loadTenants = useCallback(async () => {
    setTenantsLoading(true);
    setTenantsError(null);
    try {
      const res = await authFetch('/api/admin/onboarding/tenants');
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setTenants(json.tenants ?? []);
    } catch (err) {
      setTenantsError(err instanceof Error ? err.message : String(err));
    } finally {
      setTenantsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTenants();
  }, [loadTenants, reloadTick]);

  /* ── Submit handlers ── */
  async function submitCreateTenant(e: React.FormEvent) {
    e.preventDefault();
    setCreateBusy(true);
    setCreateStatus(null);
    try {
      const res = await authFetch('/api/admin/onboarding/tenants', {
        method: 'POST',
        body: JSON.stringify({
          name: newName.trim(),
          slug: newSlug.trim().toLowerCase(),
          notes: newNotes.trim() || null,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setCreateStatus({
        kind: 'success',
        message: (
          <>
            Created tenant <strong>{json.tenant.name}</strong> with alias{' '}
            <code>{json.tenant.email_alias}</code>. Next: set up the Gmail alias
            in Google Workspace and forward it to the main S.IS_AD_Prod inbox.
          </>
        ),
      });
      setNewName('');
      setNewSlug('');
      setNewNotes('');
      setReloadTick((t) => t + 1);
    } catch (err) {
      setCreateStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setCreateBusy(false);
    }
  }

  async function submitInvite(e: React.FormEvent) {
    e.preventDefault();
    setInviteBusy(true);
    setInviteStatus(null);
    try {
      const res = await authFetch('/api/admin/onboarding/invite', {
        method: 'POST',
        body: JSON.stringify({
          tenantId: inviteTenantId,
          email: inviteEmail.trim().toLowerCase(),
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setInviteStatus({
        kind: 'success',
        message: json.inviteSent ? (
          <>
            Invite sent to <strong>{json.user.email}</strong>. They'll receive a
            magic-link email to set their password.
          </>
        ) : (
          <>
            <strong>{json.user.email}</strong> already had an account — no new
            invite was sent. They can sign in with their existing password.
          </>
        ),
      });
      setInviteEmail('');
    } catch (err) {
      setInviteStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setInviteBusy(false);
    }
  }

  async function toggleTenantActive(t: TenantRow) {
    const action = t.is_active ? 'deactivate' : 'reactivate';
    try {
      const res = await authFetch(
        `/api/admin/onboarding/tenants/${t.id}/${action}`,
        { method: 'POST' }
      );
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setReloadTick((t2) => t2 + 1);
    } catch (err) {
      alert(
        `Failed to ${action} ${t.name}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  /* ── Render ── */
  return (
    <div style={{ maxWidth: '880px' }}>
      <header style={{ marginBottom: '24px' }}>
        <h1
          style={{
            margin: 0,
            fontSize: '22px',
            fontWeight: 700,
            color: colors.midnightNavy,
          }}
        >
          Admin · Onboarding
        </h1>
        <p
          style={{
            margin: '6px 0 0',
            fontSize: '14px',
            color: colors.textMuted,
            maxWidth: '620px',
            lineHeight: 1.5,
          }}
        >
          Create a new client tenant, invite their primary user, and review the
          status of every tenant currently on the platform. Super-admin only.
        </p>
      </header>

      {/* ── Create tenant card ── */}
      <section style={CARD_STYLE}>
        <h2 style={CARD_TITLE_STYLE}>Create a new tenant</h2>
        <p style={CARD_SUBTITLE_STYLE}>
          Sets up the database record and derives the Gmail alias. You'll still
          need to create the matching alias in Google Workspace afterwards.
        </p>
        <form onSubmit={submitCreateTenant}>
          <FieldRow label="Client Name" hint="Shown in the dashboard and reports. Example: Acme Energy LLC.">
            <input
              style={INPUT_STYLE}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Acme Energy LLC"
              required
              disabled={createBusy}
            />
          </FieldRow>
          <FieldRow
            label="Slug"
            hint={
              derivedAlias
                ? `Email alias will be: ${derivedAlias}`
                : 'Lowercase letters, digits, and hyphens only. 2–30 chars.'
            }
          >
            <input
              style={INPUT_STYLE}
              value={newSlug}
              onChange={(e) => setNewSlug(e.target.value.toLowerCase())}
              placeholder="acme-energy"
              pattern="^[a-z0-9]+(?:-[a-z0-9]+)*$"
              required
              disabled={createBusy}
            />
          </FieldRow>
          <FieldRow label="Notes (optional)" hint="Free-form — who the primary contact is, contract start, etc.">
            <textarea
              style={{ ...INPUT_STYLE, minHeight: '72px', fontFamily: 'inherit' }}
              value={newNotes}
              onChange={(e) => setNewNotes(e.target.value)}
              disabled={createBusy}
            />
          </FieldRow>
          <button
            type="submit"
            className="sis-btn"
            disabled={createBusy}
            style={{
              padding: '9px 18px',
              fontSize: '13px',
              fontWeight: 600,
              color: colors.white,
              backgroundColor: colors.midnightNavy,
              border: 'none',
              borderRadius: radii.lg,
              cursor: createBusy ? 'wait' : 'pointer',
              transition: transitions.snappy,
            }}
          >
            {createBusy ? 'Creating…' : 'Create tenant'}
          </button>
        </form>
        {createStatus && (
          <InlineStatus kind={createStatus.kind}>{createStatus.message}</InlineStatus>
        )}
      </section>

      {/* ── Invite user card ── */}
      <section style={CARD_STYLE}>
        <h2 style={CARD_TITLE_STYLE}>Invite a user</h2>
        <p style={CARD_SUBTITLE_STYLE}>
          Sends a magic-link email and links the user to the chosen tenant.
          Users can only belong to one tenant. Super-admin rights stay with
          Caleb.
        </p>
        <form onSubmit={submitInvite}>
          <FieldRow label="Tenant" hint="Pick which client this user belongs to.">
            <select
              style={INPUT_STYLE}
              value={inviteTenantId}
              onChange={(e) => setInviteTenantId(e.target.value)}
              required
              disabled={inviteBusy || tenantsLoading}
            >
              <option value="">— Select a tenant —</option>
              {tenants
                .filter((t) => t.is_active)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.slug})
                  </option>
                ))}
            </select>
          </FieldRow>
          <FieldRow label="User Email" hint="They'll receive a magic link to set their password.">
            <input
              style={INPUT_STYLE}
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="user@client.com"
              required
              disabled={inviteBusy}
            />
          </FieldRow>
          <button
            type="submit"
            className="sis-btn"
            disabled={inviteBusy || !inviteTenantId}
            style={{
              padding: '9px 18px',
              fontSize: '13px',
              fontWeight: 600,
              color: colors.white,
              backgroundColor: colors.midnightNavy,
              border: 'none',
              borderRadius: radii.lg,
              cursor: inviteBusy ? 'wait' : 'pointer',
              transition: transitions.snappy,
              opacity: !inviteTenantId ? 0.55 : 1,
            }}
          >
            {inviteBusy ? 'Sending…' : 'Send invite'}
          </button>
        </form>
        {inviteStatus && (
          <InlineStatus kind={inviteStatus.kind}>{inviteStatus.message}</InlineStatus>
        )}
      </section>

      {/* ── Tenants list ── */}
      <section style={CARD_STYLE}>
        <h2 style={CARD_TITLE_STYLE}>Existing tenants</h2>
        <p style={CARD_SUBTITLE_STYLE}>
          Every tenant currently registered in the platform, with its Gmail
          alias. Deactivating a tenant stops new email ingestion immediately.
        </p>
        {tenantsError && (
          <InlineStatus kind="error">{tenantsError}</InlineStatus>
        )}
        <div style={{ overflowX: 'auto' }}>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: '13px',
            }}
          >
            <thead>
              <tr style={{ textAlign: 'left', color: colors.textMuted }}>
                <th style={{ padding: '8px 10px' }}>Name</th>
                <th style={{ padding: '8px 10px' }}>Slug</th>
                <th style={{ padding: '8px 10px' }}>Email Alias</th>
                <th style={{ padding: '8px 10px' }}>Status</th>
                <th style={{ padding: '8px 10px' }}></th>
              </tr>
            </thead>
            <tbody>
              {tenantsLoading && tenants.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ padding: '16px 10px', color: colors.textMuted }}>
                    Loading…
                  </td>
                </tr>
              )}
              {!tenantsLoading && tenants.length === 0 && !tenantsError && (
                <tr>
                  <td colSpan={5} style={{ padding: '16px 10px', color: colors.textMuted }}>
                    No tenants yet. Create one above.
                  </td>
                </tr>
              )}
              {tenants.map((t) => (
                <tr
                  key={t.id}
                  style={{ borderTop: `1px solid ${colors.borderSoft}` }}
                >
                  <td style={{ padding: '10px', color: colors.midnightNavy, fontWeight: 500 }}>
                    {t.name}
                  </td>
                  <td style={{ padding: '10px', color: colors.textMuted, fontFamily: 'monospace' }}>
                    {t.slug}
                  </td>
                  <td style={{ padding: '10px', color: colors.textMuted, fontFamily: 'monospace' }}>
                    {t.email_alias}
                  </td>
                  <td style={{ padding: '10px' }}>
                    <span
                      style={{
                        display: 'inline-block',
                        padding: '3px 10px',
                        borderRadius: radii.pill,
                        fontSize: '11px',
                        fontWeight: 600,
                        color: t.is_active ? colors.success : colors.textMuted,
                        backgroundColor: t.is_active ? colors.successBg : colors.surfaceMuted,
                        letterSpacing: '0.4px',
                        textTransform: 'uppercase',
                      }}
                    >
                      {t.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td style={{ padding: '10px', textAlign: 'right' }}>
                    <button
                      onClick={() => toggleTenantActive(t)}
                      className="sis-btn sis-btn-secondary"
                      style={{
                        padding: '5px 10px',
                        fontSize: '12px',
                        transition: transitions.snappy,
                      }}
                    >
                      {t.is_active ? 'Deactivate' : 'Reactivate'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
