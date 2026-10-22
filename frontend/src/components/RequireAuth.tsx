import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { Card, Center, Muted } from './ui';

// Wraps every private screen. This is for convenience only: the SERVER decides what a person may
// really do, so hiding a button here never replaces a permission check on the backend.
export function RequireAuth() {
  const { state } = useAuth();
  const where = useLocation();
  if (state.status === 'loading') return <Center><Muted>Loading…</Muted></Center>;
  if (state.status === 'anonymous') return <Navigate to="/login" replace state={{ from: where.pathname }} />;
  return <Outlet />;
}

/** For a screen that needs one permission (for example "users.manage"). */
export function RequirePermission({ permission }: { permission: string }) {
  const { can } = useAuth();
  if (!can(permission)) return <Card>You do not have access to this page.</Card>;
  return <Outlet />;
}