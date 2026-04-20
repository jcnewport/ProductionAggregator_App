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
 * Tenancy note (see memory/project_tenancy_model.md):
 *   Today this deployment is single-tenant — anyone authenticated sees everything.
 *   All data reads go through the user's session, so when RLS policies tighten
 *   later for multi-tenant mode, no frontend changes are needed.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../utils/supabase';

interface AuthContextValue {
  session: Session | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Pull the current session on first mount
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    // Subscribe to future auth changes (sign-in, sign-out, token refresh)
    const { data: authListener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
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

  const value: AuthContextValue = { session, loading, signIn, signOut };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be called inside an <AuthProvider>.');
  }
  return ctx;
}
