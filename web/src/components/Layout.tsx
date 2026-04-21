/**
 * Layout — the persistent chrome around authenticated pages.
 *
 * Shows:
 *   - Header with Stewardship.IS logo mark + wordmark + nav links + sign-out button
 *   - Main content area (via <Outlet />)
 *   - Small footer
 *
 * Stewardship.IS palette everywhere. Header is midnight navy with the
 * active nav link highlighted in electric teal, and a small inline SVG logo
 * mark to the left of the product wordmark. Non-active nav links sit in
 * a muted steel-blue gray so they read as "secondary" but stay readable on navy.
 */

import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import LogoMark from './LogoMark';
import { colors, shadows } from '../theme';

const navLinks = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/export/monthly', label: 'Monthly Export', end: false },
  { to: '/export/daily', label: 'Daily Export', end: false },
  { to: '/exports/history', label: 'Export History', end: false },
];

export default function Layout() {
  const { session, signOut } = useAuth();

  const userEmail = session?.user?.email ?? '';

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: colors.lightGray,
      }}
    >
      <header
        style={{
          backgroundColor: colors.midnightNavy,
          color: colors.white,
          padding: '14px 24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          boxShadow: shadows.card,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '32px' }}>
          <h1
            style={{
              margin: 0,
              fontSize: '18px',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
            }}
          >
            {/*
              Logo mark stays tasteful at 28px — the stripe color is bumped
              to a brighter gray (#B6BFCB) so it reads cleanly against the
              midnight-navy header, while the teal accent stays on-brand.
            */}
            <LogoMark size={28} stripe={colors.steelBlue} accent={colors.electricTeal} />
            <span style={{ color: colors.electricTeal }}>Stewardship.IS</span>{' '}
            <span style={{ color: colors.white }}>Production Aggregator</span>
          </h1>
          <nav style={{ display: 'flex', gap: '20px' }}>
            {navLinks.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                end={l.end}
                style={({ isActive }) => ({
                  textDecoration: 'none',
                  color: isActive ? colors.electricTeal : colors.steelBlue,
                  fontWeight: isActive ? 600 : 500,
                  fontSize: '14px',
                  borderBottom: isActive ? `2px solid ${colors.electricTeal}` : '2px solid transparent',
                  paddingBottom: '3px',
                })}
              >
                {l.label}
              </NavLink>
            ))}
          </nav>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '14px', fontSize: '13px' }}>
          <span style={{ color: colors.steelBlue }}>{userEmail}</span>
          <button
            onClick={signOut}
            style={{
              backgroundColor: 'transparent',
              color: colors.white,
              border: `1px solid ${colors.steelBlue}`,
              padding: '6px 12px',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '13px',
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      <main
        style={{
          flex: 1,
          padding: '24px',
          maxWidth: '1200px',
          margin: '0 auto',
          width: '100%',
          boxSizing: 'border-box',
        }}
      >
        <Outlet />
      </main>

      <footer
        style={{
          backgroundColor: colors.midnightNavy,
          color: colors.steelBlue,
          padding: '10px 24px',
          textAlign: 'center',
          fontSize: '12px',
        }}
      >
        Stewardship.IS, Inc. &copy; {new Date().getFullYear()}
      </footer>
    </div>
  );
}
