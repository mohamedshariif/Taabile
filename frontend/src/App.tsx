import { Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { RequireAuth, RequirePermission } from './components/RequireAuth';
import { Center, Muted } from './components/ui';
import { AcceptInvitePage } from './pages/AcceptInvitePage';
import { HomePage } from './pages/HomePage';
import { LocationsPage } from './pages/LocationsPage';
import { LoginPage } from './pages/LoginPage';
import { ProductDetailPage } from './pages/ProductDetailPage';
import { ProductFormPage } from './pages/ProductFormPage';
import { ProductsPage } from './pages/ProductsPage';
import { UserDetailPage } from './pages/UserDetailPage';
import { UsersPage } from './pages/UsersPage';
import { PartiesPage } from './pages/PartiesPage';
import { PartyDetailPage } from './pages/PartyDetailPage';
import { PartyNewPage } from './pages/PartyNewPage';

export default function App() {
  return (
    <Routes>
      {/* Public pages */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/accept-invite" element={<AcceptInvitePage />} />

      {/* Private pages: everything inside needs a signed-in person */}
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route index element={<HomePage />} />
          <Route element={<RequirePermission permission="products.view" />}>
            <Route path="products" element={<ProductsPage />} />
            <Route path="products/:productId" element={<ProductDetailPage />} />
          </Route>
          <Route element={<RequirePermission permission="products.manage" />}>
            <Route path="products/new" element={<ProductFormPage />} />
          </Route>
          <Route element={<RequirePermission permission="customers.view" />}>
            <Route path="customers" element={<PartiesPage kind="customer" />} />
            <Route path="customers/:id" element={<PartyDetailPage kind="customer" />} />
          </Route>
          <Route element={<RequirePermission permission="customers.manage" />}>
            <Route path="customers/new" element={<PartyNewPage kind="customer" />} />
          </Route>
          <Route element={<RequirePermission permission="suppliers.view" />}>
            <Route path="suppliers" element={<PartiesPage kind="supplier" />} />
            <Route path="suppliers/:id" element={<PartyDetailPage kind="supplier" />} />
          </Route>
          <Route element={<RequirePermission permission="suppliers.manage" />}>
            <Route path="suppliers/new" element={<PartyNewPage kind="supplier" />} />
          </Route>
          <Route path="locations" element={<LocationsPage />} />
          <Route element={<RequirePermission permission="users.manage" />}>
            <Route path="users" element={<UsersPage />} />
            <Route path="users/:userId" element={<UserDetailPage />} />
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<Center><Muted>Page not found.</Muted></Center>} />
    </Routes>
  );
}