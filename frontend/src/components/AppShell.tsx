import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth, useMe } from '../auth/AuthContext';
import { ThemeSwitch } from './ThemeSwitch';
import { Button, cx } from './ui';
import {
  ArrowLeftRight,
  Building2,
  CalendarCheck,
  ChartColumn,
  ClipboardList,
  CreditCard,
  HandHelping,
  House,
  KeyRound,
  Layers,
  Lock,
  MapPin,
  Menu,
  Package,
  Receipt,
  ShoppingCart,
  Truck,
  Upload,
  User,
  Users,
  Wallet,
  X,
  type LucideIcon
} from 'lucide-react';

// The menu is built from what the SERVER says this person may do (GET /api/auth/me).
// Adding a module later = adding one line here. Pick the icon at lucide.dev, import it above, and use it as  icon: Name.
const MENU: { to: string; label: string; icon: LucideIcon; permission?: string; anyOf?: string[] }[] = [
  { to: '/', label: 'Home', icon: House },
  { to: '/products', label: 'Products', icon: Package, permission: 'products.view' },
  { to: '/sales', label: 'Sales', icon: ShoppingCart, permission: 'sales.view' },
  { to: '/releases', label: 'Goods to hand over', icon: HandHelping, permission: 'stock.release' },
  { to: '/stock', label: 'Stock', icon: Layers, permission: 'stock.view' },
  { to: '/transfers', label: 'Transfers', icon: ArrowLeftRight, permission: 'stock.view' },
  { to: '/counts', label: 'Stock counts', icon: ClipboardList, permission: 'stock.view' },
  { to: '/purchases', label: 'Purchases', icon: Truck, permission: 'purchases.view' },
  { to: '/cash', label: 'Cash and bank', icon: Wallet, permission: 'cash.manage' },
  { to: '/cash/moves', label: 'Cash movements', icon: ArrowLeftRight, anyOf: ['cash.manage', 'cash.confirm'] },
  { to: '/day-close', label: 'Close the day', icon: Lock, permission: 'cash.manage' },
  { to: '/day-closes', label: 'Closed days', icon: CalendarCheck, anyOf: ['cash.manage', 'reports.view'] },
  { to: '/payments', label: 'Payments', icon: CreditCard, permission: 'payments.view' },
  { to: '/expenses', label: 'Expenses', icon: Receipt, permission: 'expenses.create' },
  { to: '/employees', label: 'Employees', icon: Users, permission: 'payroll.view' },
  { to: '/reports', label: 'Reports', icon: ChartColumn, permission: 'reports.view' },
  { to: '/customers', label: 'Customers', icon: User, permission: 'customers.view' },
  { to: '/suppliers', label: 'Suppliers', icon: Building2, permission: 'suppliers.view' },
  { to: '/import', label: 'Load starting data', icon: Upload, permission: 'import.run' },
  { to: '/locations', label: 'Locations', icon: MapPin },
  { to: '/users', label: 'Users', icon: KeyRound, permission: 'users.manage' },
];

// Phone: a top bar with a menu icon on the left, then "Taabile" and the company name. The icon slides the menu in
// from the left (almost full width) over a dark overlay; tapping the overlay, the X, or a menu item closes it.
// Wide screen (md and up): a fixed side bar, as before.
export function AppShell() {
  const me = useMe();
  const { can, logout } = useAuth();
  const [open, setOpen] = useState(false);

  // While the menu covers the page: Escape closes it, and the page behind does not scroll.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    const before = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = before; };
  }, [open]);

  const brand = (
    <div className="min-w-0 leading-tight">
      <div className="font-bold text-brand md:text-xl">Taabile</div>
      <div className="truncate text-sm text-muted">{me.company.name}</div>
    </div>
  );

  return (
    <div className="min-h-screen md:grid md:grid-cols-[15rem_minmax(0,1fr)]">
      <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-line bg-card px-2 py-2 md:hidden">
        <button type="button" aria-label="Open menu" aria-expanded={open} aria-controls="main-menu" onClick={() => setOpen(true)} className="grid size-11 shrink-0 place-items-center rounded-lg text-ink hover:bg-page">
          <Menu className="size-6" aria-hidden="true" />
        </button>
        {brand}
      </header>

      {/* Dark overlay (phone only): tapping it closes the menu */}
      <div aria-hidden="true" onClick={() => setOpen(false)} className={cx('fixed inset-0 z-30 bg-black/50 transition-opacity duration-200 md:hidden', open ? 'opacity-100' : 'pointer-events-none opacity-0')} />

      <aside
        id="main-menu"
        aria-label="Menu"
        className={cx(
          'fixed inset-y-0 left-0 z-40 flex w-[85%] max-w-xs flex-col gap-1 border-r border-line bg-card p-4 shadow-xl transition-[transform,visibility] duration-200',
          'md:sticky md:top-0 md:z-auto md:h-screen md:w-auto md:max-w-none md:translate-x-0 md:shadow-none md:visible',
          open ? 'translate-x-0' : '-translate-x-full invisible',
        )}
      >
        <div className="mb-2 flex items-start justify-between gap-2 md:mb-4">
          {brand}
          <button type="button" aria-label="Close menu" onClick={() => setOpen(false)} className="-mt-1 -mr-2 grid size-11 shrink-0 place-items-center rounded-lg text-ink hover:bg-page md:hidden">
            <X className="size-6" aria-hidden="true" />
          </button>
        </div>
        <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto" aria-label="Main">
          {MENU.filter((m) => (!m.permission || can(m.permission)) && (!m.anyOf || m.anyOf.some((p) => can(p)))).map((m) => (
            <NavLink
              key={m.to}
              to={m.to}
              end={m.to === '/'}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                cx(
                  'flex min-h-11 items-center gap-3 rounded-lg px-3 py-2.5 font-medium no-underline hover:no-underline',
                  isActive ? 'bg-brand/10 text-brand' : 'text-ink hover:bg-page',
                )
              }
            >
              <m.icon className="size-5 shrink-0" aria-hidden="true" />
              {m.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-4 shrink-0 border-t border-line pt-3 md:mt-2">
          <div className="mb-3"><ThemeSwitch /></div>
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