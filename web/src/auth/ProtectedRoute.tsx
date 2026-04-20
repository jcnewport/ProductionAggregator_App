/**
 * ProtectedRoute — wraps any page that requires an authenticated session.
 * Routes the user to /login if there's no session yet.
 *
 * Usage (in App.tsx):
 *   <Route element={<ProtectedRoute />}>
 *     <Route path="/" element={<DashboardPage />} />
 *     <Route path="/export/monthly" element={<MonthlyExportPage />} />
 *   </Route>
 */

import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './AuthProvider';
import { colors } from '../theme';

export default function ProtectedRoute() {
  const { session, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    // First render before the session is hydrated — a tiny loading shell.
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: colors.steelBlue,
          backgroundColor: colors.lightGray,
        }}
      >
        <div>Loading…</div>
      </div>
    );
  }

  if (!session) {
    // Preserve where the user was trying to go so we can redirect after login.
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <Outlet />;
}
