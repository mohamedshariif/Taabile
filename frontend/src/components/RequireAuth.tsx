import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

// Wraps every private screen. This is for convenience only: the SERVER decides what a person may
// really do, so hiding a button here never replaces a permission check on the backend.
export function RequireAuth() {
  const { state } = useAuth();
  const where = useLocation();
  if (state.status === 'loading') return <p className="center muted">Loading…</p>;
  if (state.status === 'anonymous') return <Navigate to="/login" replace state={{ from: where.pathname }} />;
  return <Outlet />;
}

/** For a screen that needs one permission (for example "users.manage"). */
export function RequirePermission({ permission }: { permission: string }) {
  const { can } = useAuth();
  if (!can(permission)) return <p className="card">You do not have access to this page.</p>;
  return <Outlet />;
}