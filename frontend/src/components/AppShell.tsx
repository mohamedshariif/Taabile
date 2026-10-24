import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth, useMe } from '../auth/AuthContext';
import { Button, cx } from './ui';

// The menu is built from what the SERVER says this person may do (GET /api/auth/me).
// Adding a module later = adding one line here.
const MENU: { to: string; label: string; permission?: string }[] = [
  { to: '/', label: 'Home' },
  { to: '/locations', label: 'Locations' },
  { to: '/users', label: 'Users', permission: 'users.manage' },
  { to: '/products', label: 'Products', permission: 'products.view' },
  { to: '/customers', label: 'Customers', permission: 'customers.view' },
  { to: '/suppliers', label: 'Suppliers', permission: 'suppliers.view' },
];

// Phone: a slim top bar with a Menu button that opens the list. Wide screen (md and up): a fixed side bar.
export function AppShell() {
  const me = useMe();
  const { can, logout } = useAuth();
  const [open, setOpen] = useState(false);

  return (
    <div className="min-h-screen md:grid md:grid-cols-[15rem_minmax(0,1fr)]">
      <header className="sticky top-0 z-20 flex items-center justify-between border-b border-line bg-card px-4 py-2 md:hidden">
        <div>
          <div className="font-bold text-brand">Taabile</div>
          <div className="text-sm text-muted">{me.company.name}</div>
        </div>
        <Button variant="ghost" small aria-expanded={open} aria-controls="main-menu" onClick={() => setOpen((o) => !o)}>
          {open ? 'Close' : 'Menu'}
        </Button>
      </header>

      <aside
        id="main-menu"
        className={cx(
          'flex-col gap-1 border-b border-line bg-card p-4 md:sticky md:top-0 md:flex md:h-screen md:border-r md:border-b-0',
          open ? 'flex' : 'hidden',
        )}
      >
        <div className="hidden md:block">
          <div className="text-xl font-bold text-brand">Taabile</div>
          <div className="mb-4 text-sm text-muted">{me.company.name}</div>
        </div>
        <nav className="flex flex-col gap-1" aria-label="Main">
          {MENU.filter((m) => !m.permission || can(m.permission)).map((m) => (
            <NavLink
              key={m.to}
              to={m.to}
              end={m.to === '/'}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                cx(
                  'block min-h-11 rounded-lg px-3 py-2.5 font-medium no-underline hover:no-underline',
                  isActive ? 'bg-brand/10 text-brand' : 'text-ink hover:bg-page',
                )
              }
            >
              {m.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-4 md:mt-auto">
          <div className="text-sm">
            {me.user.name}
            <div className="text-muted">{me.role}</div>
          </div>
          <Button variant="link" className="mt-1 min-h-11" onClick={() => void logout()}>
            Sign out
          </Button>
        </div>
      </aside>

      <main className="mx-auto w-full max-w-5xl min-w-0 p-4 sm:p-6">
        <Outlet />
      </main>
    </div>
  );
}