import { NavLink, Outlet } from 'react-router-dom';
import { useAuth, useMe } from '../auth/AuthContext';

// Adding a module later = adding one line here.
const MENU: { to: string; label: string; permission?: string }[] = [
  { to: '/', label: 'Home' },
  { to: '/locations', label: 'Locations' },
  { to: '/users', label: 'Users', permission: 'users.manage' },
];

export function AppShell() {
  const me = useMe();
  const { can, logout } = useAuth();
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">Taabile</div>
        <div className="muted small">{me.company.name}</div>
        <nav>
          {MENU.filter((m) => !m.permission || can(m.permission)).map((m) => (
            <NavLink key={m.to} to={m.to} end={m.to === '/'}>
              {m.label}
            </NavLink>
          ))}
        </nav>
        <div className="grow" />
        <div className="small">
          {me.user.name}
          <div className="muted">{me.role}</div>
        </div>
        <button className="link" onClick={() => void logout()}>
          Sign out
        </button>
      </aside>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}