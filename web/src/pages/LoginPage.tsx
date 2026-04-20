/**
 * LoginPage — Supabase email/password sign-in.
 *
 * Flow:
 *   1. User types email + password
 *   2. Click "Sign in" → AuthProvider.signIn() → Supabase Auth
 *   3. On success, AuthProvider updates session and <ProtectedRoute> lets the user through
 *   4. On failure, we show the Supabase error inline
 *
 * Single-tenant note: every user who can log in here has full access. To add
 * a user, create it in Supabase Dashboard → Authentication → Users.
 */

import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import LogoMark from '../components/LogoMark';
import { colors, shadows } from '../theme';

type NavState = { from?: string };

export default function LoginPage() {
  const { session, signIn } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Already signed in? Bounce to wherever they were going.
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
        backgroundColor: colors.midnightNavy,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
      }}
    >
      <div
        style={{
          backgroundColor: colors.white,
          borderRadius: '10px',
          padding: '40px 36px',
          width: '100%',
          maxWidth: '420px',
          boxShadow: shadows.card,
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: '28px' }}>
          {/*
            Centered logo mark above the wordmark. On the white card we use
            the softer neutral-gray stripe color (#98A2B3 default) so the
            teal accent is the eye-catcher without feeling too heavy.
          */}
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '14px' }}>
            <LogoMark size={56} />
          </div>
          <h1 style={{ margin: 0, color: colors.midnightNavy, fontSize: '22px', fontWeight: 700 }}>
            <span style={{ color: colors.electricTeal }}>Stewardship.IS</span> Production Aggregator
          </h1>
          <p style={{ margin: '8px 0 0 0', color: colors.darkGray, fontSize: '13px' }}>
            Sign in to access production data.
          </p>
        </div>

        <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <span style={{ fontSize: '13px', color: colors.midnightNavy, fontWeight: 500 }}>Email</span>
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@stewardship.is"
              style={inputStyle}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <span style={{ fontSize: '13px', color: colors.midnightNavy, fontWeight: 500 }}>Password</span>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={inputStyle}
            />
          </label>

          {error && (
            <div
              style={{
                backgroundColor: '#FEF2F2',
                color: colors.danger,
                border: `1px solid ${colors.danger}33`,
                borderRadius: '6px',
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
            style={{
              // CTA = primary blue. The teal is reserved for the brand
              // wordmark + logo accent, so the eye lands on "Stewardship.IS"
              // first and the Sign-in button second.
              backgroundColor: submitting ? colors.darkGray : colors.primary,
              color: colors.white,
              border: 'none',
              padding: '12px 16px',
              borderRadius: '6px',
              fontWeight: 600,
              fontSize: '14px',
              cursor: submitting ? 'wait' : 'pointer',
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
            borderTop: `1px solid ${colors.mediumGray}`,
            fontSize: '12px',
            color: colors.darkGray,
            textAlign: 'center',
          }}
        >
          Need an account? Ask Caleb to add you in Supabase.
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: '10px 12px',
  borderRadius: '6px',
  border: `1px solid ${colors.mediumGray}`,
  fontSize: '14px',
  fontFamily: 'inherit',
  outline: 'none',
};
