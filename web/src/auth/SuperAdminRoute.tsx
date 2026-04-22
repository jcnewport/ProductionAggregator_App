/**
 * SuperAdminRoute — nested under ProtectedRoute, blocks access to pages
 * that only super-admins (Caleb) should see. A tenant user who somehow
 * navigates to /admin/* gets bounced to the dashboard with a soft message.
 *
 * Defense-in-depth: even if a tenant user guesses the URL, they hit this
 * gate AND the backend's requireSuperAdmin middleware. Both have to pass
 * for anything meaningful to happen.
 */

import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from './AuthProvider';
import { colors } from '../theme';

export default function SuperAdminRoute() {
  const { session, loading, isSuperAdmin } = useAuth();

  if (loading) {
    return (
      <div
        style={{
          minHeight: '200px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: colors.textMuted,
        }}
      >
        Checking permissions…
      </div>
    );
  }

  // Never be logged-in but not-super-admin without this redirect; the outer
  // ProtectedRoute already covers "not logged in at all".
  if (!session || !isSuperAdmin) {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}
