/**
 * Layout — the persistent chrome around authenticated pages.
 *
 * UI direction (chosen 2026-04-21): "Enterprise Confident" base with a LIVE
 * badge borrowed from Option B. The header is no longer dark-mode — it's a
 * white bar with a thin border, nav rendered as pill buttons, a pulsing
 * teal LIVE indicator, and a user avatar in the top-right. Think Stripe /
 * Ramp; not "ops control room."
 *
 * Contents:
 *   - Header: logo mark + wordmark (with teal dot), divider, nav pills,
 *     LIVE badge, user avatar
 *   - Main content via <Outlet />
 *   - Small footer
 *
 * Style tokens come from /src/theme.ts; animations come from /src/index.css
 * (specifically .sis-live-dot and .sis-navlink).
 */

import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import LogoMark from './LogoMark';
import { colors, radii, transitions } from '../theme';

// Nav links shown to every authenticated user.
const navLinks = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/export/monthly', label: 'Monthly Export', end: false },
  { to: '/export/daily', label: 'Daily Export', end: false },
  { to: '/exports/history', label: 'Export History', end: false },
];

// Nav links shown ONLY to super-admins (Caleb). Regular tenant users don't
// see these. Gated in JSX below by session.isSuperAdmin.
const adminNavLinks = [
  { to: '/admin/onboarding', label: 'Admin', end: false },
];

/** Initials for the user-avatar bubble in the top-right. Takes the first
 * letter of the local-part before `@`, and — if the local-part contains
 * a dot or underscore — the first letter after the separator too. Falls back
 * to "?" for empty/malformed emails. */
function initialsFromEmail(email: string): string {
  if (!email) return '?';
  const local = email.split('@')[0] ?? '';
  if (!local) return '?';
  const parts = local.split(/[._-]/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return local.slice(0, 2).toUpperCase();
}

export default function Layout() {
  const { session, signOut, isSuperAdmin } = useAuth();

  const userEmail = session?.user?.email ?? '';
  const initials = initialsFromEmail(userEmail);

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: colors.pageBg,
      }}
    >
      <header
        style={{
          backgroundColor: colors.surface,
          color: colors.midnightNavy,
          padding: '14px 28px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: `1px solid ${colors.borderCard}`,
          // Keep the header above any cards that accidentally scroll under it.
          position: 'sticky',
          top: 0,
          zIndex: 50,
        }}
      >
        {/* Left cluster: wordmark + divider + nav pills + LIVE badge */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
          <h1
            style={{
              margin: 0,
              fontSize: '16px',
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              color: colors.midnightNavy,
              letterSpacing: '-0.1px',
            }}
          >
            <LogoMark size={26} stripe="#98A2B3" accent={colors.electricTeal} />
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              Stewardship.IS
              {/* Small teal dot — the brand accent without leaning on full-word color */}
              <span
                aria-hidden="true"
                style={{
                  width: '5px',
                  height: '5px',
                  borderRadius: '50%',
                  background: colors.electricTeal,
                  display: 'inline-block',
                  marginBottom: '2px',
                }}
              />
            </span>
          </h1>

          {/* Vertical divider between wordmark and nav */}
          <span
            aria-hidden="true"
            style={{
              width: '1px',
              height: '20px',
              backgroundColor: colors.borderCard,
            }}
          />

          <nav style={{ display: 'flex', gap: '2px' }}>
            {navLinks.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                end={l.end}
                className={({ isActive }) => 'sis-navlink' + (isActive ? ' active' : '')}
              >
                {l.label}
              </NavLink>
            ))}
            {/* Super-admin-only surfaces. The server enforces the real gate
                (requireSuperAdmin middleware); this just hides the link so
                tenant users don't see a dead-end "Admin" button. */}
            {isSuperAdmin &&
              adminNavLinks.map((l) => (
                <NavLink
                  key={l.to}
                  to={l.to}
                  end={l.end}
                  className={({ isActive }) => 'sis-navlink' + (isActive ? ' active' : '')}
                >
                  {l.label}
                </NavLink>
              ))}
          </nav>

          {/* LIVE badge — Option B's pulsing indicator. Sits next to the nav
              because it's scoped to "the app is running and polling." */}
          <span
            title="Live — email poller is running"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '10px',
              fontWeight: 700,
              color: colors.success,
              backgroundColor: 'rgba(46, 125, 50, 0.08)',
              padding: '4px 10px',
              borderRadius: radii.pill,
              letterSpacing: '0.8px',
              border: '1px solid rgba(46, 125, 50, 0.2)',
            }}
          >
            <span
              className="sis-live-dot"
              style={{ backgroundColor: colors.success }}
            />
            LIVE
          </span>
        </div>

        {/* Right cluster: email + avatar + sign-out */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span
            style={{
              fontSize: '13px',
              color: colors.textMuted,
              fontWeight: 500,
            }}
          >
            {userEmail}
          </span>
          {/* Gradient avatar — primary-blue → electric-teal. Uses the two
              action/brand colors together, which is exactly where the
              gradient feels earned (this is the only place in the app
              where we mix them). */}
          <div
            aria-hidden="true"
            style={{
              width: '30px',
              height: '30px',
              borderRadius: '50%',
              background: `linear-gradient(135deg, ${colors.primary}, ${colors.electricTeal})`,
              color: colors.white,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '11px',
              fontWeight: 700,
              letterSpacing: '0.4px',
              boxShadow: '0 1px 3px rgba(33, 39, 69, 0.15)',
            }}
          >
            {initials}
          </div>
          <button
            onClick={signOut}
            className="sis-btn sis-btn-secondary"
            style={{
              padding: '7px 14px',
              fontSize: '12px',
              transition: transitions.snappy,
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      <main
        style={{
          flex: 1,
          padding: '32px 28px',
          maxWidth: '1240px',
          margin: '0 auto',
          width: '100%',
          boxSizing: 'border-box',
        }}
      >
        <Outlet />
      </main>

      <footer
        style={{
          backgroundColor: colors.surface,
          color: colors.textMuted,
          padding: '14px 28px',
          textAlign: 'center',
          fontSize: '12px',
          borderTop: `1px solid ${colors.borderCard}`,
        }}
      >
        Stewardship.IS, Inc. &copy; {new Date().getFullYear()}
      </footer>
    </div>
  );
}
