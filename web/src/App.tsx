/**
 * App — Router + auth.
 *
 * Route tree:
 *   /login                        → public, handles sign-in
 *   /                             → protected, wrapped in Layout
 *     /                           → DashboardPage
 *     /export/monthly             → MonthlyExportPage
 *     /export/daily               → DailyExportPage
 *
 * Anything under ProtectedRoute redirects unauthenticated users to /login.
 */

import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthProvider';
import ProtectedRoute from './auth/ProtectedRoute';
import Layout from './components/Layout';
import DashboardPage from './pages/DashboardPage';
import DailyExportPage from './pages/DailyExportPage';
import ExportHistoryPage from './pages/ExportHistoryPage';
import LoginPage from './pages/LoginPage';
import MonthlyExportPage from './pages/MonthlyExportPage';
import OnboardingPage from './pages/OnboardingPage';
import SuperAdminRoute from './auth/SuperAdminRoute';

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />

          <Route element={<ProtectedRoute />}>
            <Route element={<Layout />}>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/export/monthly" element={<MonthlyExportPage />} />
              <Route path="/export/daily" element={<DailyExportPage />} />
              <Route path="/exports/history" element={<ExportHistoryPage />} />
              {/* Super-admin surfaces — gated in the UI so tenant users
                  never see the nav link, and gated on the server by
                  requireSuperAdmin middleware. */}
              <Route element={<SuperAdminRoute />}>
                <Route path="/admin/onboarding" element={<OnboardingPage />} />
              </Route>
            </Route>
          </Route>

          {/* Anything else → home (will bounce to /login if unauthenticated) */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
