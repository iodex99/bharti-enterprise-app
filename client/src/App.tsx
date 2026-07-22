import { Navigate, Route, Routes } from 'react-router';
import { useAuth } from './lib/auth';
import AppShell from './components/AppShell';
import LoginPage from './pages/LoginPage';
import ChangePasswordPage from './pages/ChangePasswordPage';
import HomePage from './pages/HomePage';
import SetupPage from './pages/SetupPage';
import MastersPage from './pages/masters/MastersPage';
import PurchasesPage from './pages/purchases/PurchasesPage';
import CuttingPage from './pages/cutting/CuttingPage';
import JobsPage from './pages/jobs/JobsPage';
import ContractorsPage from './pages/contractors/ContractorsPage';
import CheckingPage from './pages/checking/CheckingPage';
import PackingPage from './pages/packing/PackingPage';
import DispatchesPage from './pages/dispatches/DispatchesPage';
import DiscrepanciesPage from './pages/discrepancies/DiscrepanciesPage';
import ReportsPage from './pages/reports/ReportsPage';
import TracePage from './pages/trace/TracePage';
import StockPage from './pages/stock/StockPage';
import OpeningBalancesPage from './pages/admin/OpeningBalancesPage';
import UsersPage from './pages/admin/UsersPage';
import AuditPage from './pages/admin/AuditPage';
import BackupsPage from './pages/admin/BackupsPage';
import SystemPage from './pages/admin/SystemPage';
import { Spinner } from './components/ui';
import type { ReactNode } from 'react';

function FullScreenSpinner() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Spinner className="h-8 w-8" />
    </div>
  );
}

/** Auth gate + forced password change interceptor. */
function Protected({ children, roles }: { children: ReactNode; roles?: Array<'admin' | 'operator' | 'owner'> }) {
  const { user, loading } = useAuth();
  if (loading) return <FullScreenSpinner />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.mustChangePassword) return <ChangePasswordPage forced />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function App() {
  const { user, loading } = useAuth();

  return (
    <Routes>
      <Route
        path="/login"
        element={loading ? <FullScreenSpinner /> : user ? <Navigate to="/" replace /> : <LoginPage />}
      />
      <Route
        path="/setup"
        element={
          <Protected roles={['admin']}>
            <SetupPage />
          </Protected>
        }
      />
      <Route
        element={
          <Protected>
            <AppShell />
          </Protected>
        }
      >
        <Route index element={<HomePage />} />
        <Route path="account/password" element={<ChangePasswordPage />} />
        <Route path="masters/:master" element={<MastersPage />} />
        <Route path="purchases" element={<PurchasesPage />} />
        <Route path="cutting" element={<CuttingPage />} />
        <Route path="jobs" element={<JobsPage />} />
        <Route path="contractors" element={<ContractorsPage />} />
        <Route path="checking" element={<CheckingPage />} />
        <Route path="packing" element={<PackingPage />} />
        <Route path="dispatches" element={<DispatchesPage />} />
        <Route path="discrepancies" element={<DiscrepanciesPage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="trace" element={<TracePage />} />
        <Route path="stock" element={<StockPage />} />
        <Route path="stock/:stage" element={<StockPage />} />
        <Route
          path="admin/opening-balances"
          element={
            <Protected roles={['admin']}>
              <OpeningBalancesPage />
            </Protected>
          }
        />
        <Route
          path="admin/users"
          element={
            <Protected roles={['admin']}>
              <UsersPage />
            </Protected>
          }
        />
        <Route
          path="admin/audit"
          element={
            <Protected roles={['admin']}>
              <AuditPage />
            </Protected>
          }
        />
        <Route
          path="admin/backups"
          element={
            <Protected roles={['admin']}>
              <BackupsPage />
            </Protected>
          }
        />
        <Route
          path="admin/system"
          element={
            <Protected roles={['admin']}>
              <SystemPage />
            </Protected>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
