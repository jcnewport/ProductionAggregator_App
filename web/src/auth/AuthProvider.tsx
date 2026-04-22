/**
 * AuthProvider
 * ------------
 * Wraps the whole app and exposes the current Supabase session via React context.
 *
 * Why this exists:
 *   - Any page can read `useAuth()` to get the logged-in user or call signIn/signOut
 *   - Session changes (refresh, sign-out) propagate automatically to every page
 *   - ProtectedRoute reads this context to decide whether to redirect to /login
 *
 * Tenancy note (Phase 4 multi-tenancy):
 *   On every session change we also fetch the caller's user_tenants row so the
 *   UI knows whether to show super-admin surfaces (Admin > Onboarding). RLS on
 *   user_tenants lets a user read their OWN row only; cross-tenant reads are
 *   blocked. If the query fails for any reason, we conservatively treat the
 *   user as "not super-admin" — the server still enforces the real gate, so a
 *   stale/optimistic flag here never grants access it shouldn't.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../utils/supabase';

interface AuthContextValue {
  session: Session | null;
  loading: boolean;
  /**
   * True when the signed-in user's user_tenants row has is_super_admin=true.
   * Used only to gate visibility of admin-only UI. NEVER trust this value for
   * authorization — the backend's requireSuperAdmin middleware is the source
   * of truth.
   */
  isSuperAdmin: boolean;
  /** The tenant_id of the signed-in user, or null if unknown / not yet loaded. */
  tenantId: string | null;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [tenantId, setTenantId] = useState<string | null>(null);

  /**
   * Pull the caller's user_tenants row. RLS lets a user read their own row;
   * unknown/missing row means they're not yet provisioned — keep both flags
   * falsy/null so the UI falls back to the narrow (tenant-only) view.
   */
  async function refreshTenantContext(current: Session | null) {
    if (!current?.user?.id) {
      setIsSuperAdmin(false);
      setTenantId(null);
      return;
    }
    try {
      const { data, error } = await supabase
        .from('user_tenants')
        .select('tenant_id, is_super_admin')
        .eq('user_id', current.user.id)
        .maybeSingle();
      if (error) {
        console.warn('[auth] Failed to load tenant context:', error.message);
        setIsSuperAdmin(false);
        setTenantId(null);
        return;
      }
      setIsSuperAdmin(Boolean(data?.is_super_admin));
      setTenantId(data?.tenant_id ?? null);
    } catch (err) {
      console.warn('[auth] Tenant context threw:', err);
      setIsSuperAdmin(false);
      setTenantId(null);
    }
  }

  useEffect(() => {
    // Pull the current session on first mount
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      refreshTenantContext(data.session).finally(() => setLoading(false));
    });

    // Subscribe to future auth changes (sign-in, sign-out, token refresh)
    const { data: authListener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      // Fire-and-forget — we don't want the UI to block on this.
      refreshTenantContext(newSession);
    });

    return () => {
      authListener.subscription.unsubscribe();
    };
  }, []);

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error ? error.message : null };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  const value: AuthContextValue = {
    session,
    loading,
    isSuperAdmin,
    tenantId,
    signIn,
    signOut,
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be called inside an <AuthProvider>.');
  }
  return ctx;
}
