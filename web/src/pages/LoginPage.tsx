/**
 * LoginPage — Supabase email/password sign-in.
 *
 * UI direction (2026-04-21): refreshed to match the new "Enterprise Confident"
 * chrome. The page background is still the deep midnight-navy (the login
 * screen is the only place we lean into the brand color at full strength),
 * but the card is now 14px rounded, has a thin border, and uses the shared
 * .sis-btn-primary class for the Sign-in button so hover/disabled states
 * match every other button in the app.
 *
 * Flow (unchanged):
 *   1. User types email + password
 *   2. Click "Sign in" → AuthProvider.signIn() → Supabase Auth
 *   3. On success, AuthProvider updates session and <ProtectedRoute> lets the user through
 *   4. On failure, we show the Supabase error inline
 */

import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import LogoMark from '../components/LogoMark';
import { colors, radii } from '../theme';

type NavState = { from?: string };

export default function LoginPage() {
  const { session, signIn } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (session) {
    const from = (location.state as NavState | null)?.from ?? '/';
    return <Navigate to={from} replace />;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const { error: err } = await signIn(email.trim(), password);
    setSubmitting(false);
    if (err) setError(err);
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        // Layered gradient on the midnight navy — very subtle radial accents
        // in the brand teal and primary blue so the page doesn't read as flat.
        background: `
          radial-gradient(circle at 15% 10%, rgba(93, 206, 175, 0.10) 0%, transparent 40%),
          radial-gradient(circle at 85% 80%, rgba(78, 103, 200, 0.12) 0%, transparent 40%),
          ${colors.midnightNavy}
        `,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
      }}
    >
      <div
        style={{
          backgroundColor: colors.surface,
          borderRadius: radii.xl,
          padding: '44px 40px',
          width: '100%',
          maxWidth: '420px',
          boxShadow: '0 20px 60px rgba(0, 0, 0, 0.3), 0 4px 16px rgba(33, 39, 69, 0.15)',
          border: `1px solid ${colors.borderCard}`,
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: '28px' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '14px' }}>
            <LogoMark size={56} />
          </div>
          <h1
            style={{
              margin: 0,
              color: colors.midnightNavy,
              fontSize: '22px',
              fontWeight: 700,
              letterSpacing: '-0.3px',
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              Stewardship.IS
              <span
                aria-hidden="true"
                style={{
                  width: '5px',
                  height: '5px',
                  borderRadius: '50%',
                  background: colors.electricTeal,
                  display: 'inline-block',
                  marginBottom: '4px',
                }}
              />
            </span>
            <br />
            <span style={{ fontSize: '15px', fontWeight: 500, color: colors.textMuted }}>
              Production Aggregator
            </span>
          </h1>
          <p style={{ margin: '12px 0 0 0', color: colors.textMuted, fontSize: '13px' }}>
            Sign in to access production data.
          </p>
        </div>

        <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <span style={{ fontSize: '13px', color: colors.midnightNavy, fontWeight: 600 }}>Email</span>
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@stewardship.is"
              className="sis-input"
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <span style={{ fontSize: '13px', color: colors.midnightNavy, fontWeight: 600 }}>Password</span>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="sis-input"
            />
          </label>

          {error && (
            <div
              style={{
                backgroundColor: colors.dangerBg,
                color: colors.danger,
                border: `1px solid ${colors.danger}33`,
                borderRadius: radii.lg,
                padding: '10px 12px',
                fontSize: '13px',
              }}
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="sis-btn sis-btn-primary"
            style={{
              width: '100%',
              padding: '12px 16px',
              fontSize: '14px',
              marginTop: '4px',
            }}
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <div
          style={{
            marginTop: '24px',
            paddingTop: '18px',
            borderTop: `1px solid ${colors.borderCard}`,
            fontSize: '12px',
            color: colors.textMuted,
            textAlign: 'center',
          }}
        >
          Need an account? Ask Caleb to add you in Supabase.
        </div>
      </div>
    </div>
  );
}

