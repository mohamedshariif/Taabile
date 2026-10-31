import { Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { RequireAuth, RequirePermission } from './components/RequireAuth';
import { Center, Muted } from './components/ui';
import { AcceptInvitePage } from './pages/auth/AcceptInvitePage';
import { HomePage } from './pages/home/HomePage';
import { LocationsPage } from './pages/locations/LocationsPage';
import { LoginPage } from './pages/auth/LoginPage';
import { ProductDetailPage } from './pages/products/ProductDetailPage';
import { ProductFormPage } from './pages/products/ProductFormPage';
import { ProductsPage } from './pages/products/ProductsPage';
import { UserDetailPage } from './pages/users/UserDetailPage';
import { UsersPage } from './pages/users/UsersPage';
import { PartiesPage } from './pages/parties/PartiesPage';
import { PartyDetailPage } from './pages/parties/PartyDetailPage';
import { PartyNewPage } from './pages/parties/PartyNewPage';
import { MovementsPage } from './pages/movements/MovementsPage';
import { OpeningStockPage } from './pages/stock/OpeningStockPage';
import { PurchaseDetailPage } from './pages/purchases/PurchaseDetailPage';
import { PurchaseNewPage } from './pages/purchases/PurchaseNewPage';
import { PurchasesPage } from './pages/purchases/PurchasesPage';
import { StockAdjustPage } from './pages/stock/StockAdjustPage';
import { StockPage } from './pages/stock/StockPage';
import { CountDetailPage } from './pages/counts/CountDetailPage';
import { CountNewPage } from './pages/counts/CountNewPage';
import { CountsPage } from './pages/counts/CountsPage';
import { TransferDetailPage } from './pages/transfers/TransferDetailPage';
import { TransferNewPage } from './pages/transfers/TransferNewPage';
import { TransfersPage } from './pages/transfers/TransfersPage';
import { MoneyAccountsPage } from './pages/money-accounts/MoneyAccountsPage';
import { ReleasesPage } from './pages/sales/ReleasesPage';
import { SaleDetailPage } from './pages/sales/SaleDetailPage';
import { SaleNewPage } from './pages/sales/SaleNewPage';
import { SalesPage } from './pages/sales/SalesPage';
import { PaymentDetailPage } from './pages/payments/PaymentDetailPage';
import { PaymentFormPage } from './pages/payments/PaymentFormPage';
import { PaymentsPage } from './pages/payments/PaymentsPage';
import { StatementPage } from './pages/payments/StatementPage';
import { CashCountPage } from './pages/cash/CashCountPage';
import { CashMoveDetailPage } from './pages/cash/CashMoveDetailPage';
import { CashMoveNewPage } from './pages/cash/CashMoveNewPage';
import { CashMovesPage } from './pages/cash/CashMovesPage';
import { ExpenseDetailPage } from './pages/expenses/ExpenseDetailPage';
import { ExpenseNewPage } from './pages/expenses/ExpenseNewPage';
import { ExpensesPage } from './pages/expenses/ExpensesPage';

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
          <Route element={<RequirePermission permission="stock.view" />}>
            <Route path="stock" element={<StockPage />} />
            <Route path="stock/movements" element={<MovementsPage />} />
          </Route>
          <Route element={<RequirePermission permission="stock.view" />}>
            <Route path="transfers" element={<TransfersPage />} />
            <Route path="transfers/:id" element={<TransferDetailPage />} />
            <Route path="counts" element={<CountsPage />} />
            <Route path="counts/:id" element={<CountDetailPage />} />
          </Route>
          <Route element={<RequirePermission permission="sales.view" />}>
            <Route path="sales" element={<SalesPage />} />
            <Route path="sales/:id" element={<SaleDetailPage />} />
          </Route>
          <Route element={<RequirePermission permission="sales.create" />}>
            <Route path="sales/new" element={<SaleNewPage />} />
          </Route>
          <Route element={<RequirePermission permission="stock.release" />}>
            <Route path="releases" element={<ReleasesPage />} />
          </Route>
          <Route element={<RequirePermission permission="payments.view" />}>
            <Route path="payments" element={<PaymentsPage />} />
            <Route path="payments/:id" element={<PaymentDetailPage />} />
            <Route path="customers/:id/statement" element={<StatementPage kind="customer" />} />
            <Route path="suppliers/:id/statement" element={<StatementPage kind="supplier" />} />
          </Route>
          <Route element={<RequirePermission permission="payments.receive" />}>
            <Route path="payments/receive" element={<PaymentFormPage kind="customer" />} />
          </Route>
          <Route element={<RequirePermission permission="payments.pay_supplier" />}>
            <Route path="payments/pay" element={<PaymentFormPage kind="supplier" />} />
          </Route>
          <Route element={<RequirePermission permission="expenses.create" />}>
            <Route path="expenses" element={<ExpensesPage />} />
            <Route path="expenses/new" element={<ExpenseNewPage />} />
            <Route path="expenses/:id" element={<ExpenseDetailPage />} />
          </Route>
          <Route element={<RequirePermission permission="cash.manage" />}>
            <Route path="cash" element={<MoneyAccountsPage />} />
            <Route path="cash/moves" element={<CashMovesPage />} />
            <Route path="cash/moves/new" element={<CashMoveNewPage />} />
            <Route path="cash/moves/:id" element={<CashMoveDetailPage />} />
            <Route path="cash/count" element={<CashCountPage />} />
          </Route>
          <Route element={<RequirePermission permission="stock.transfer" />}>
            <Route path="transfers/new" element={<TransferNewPage />} />
          </Route>
          <Route element={<RequirePermission permission="stock.count" />}>
            <Route path="counts/new" element={<CountNewPage />} />
          </Route>
          <Route element={<RequirePermission permission="stock.adjust_approve" />}>
            <Route path="stock/adjust" element={<StockAdjustPage />} />
          </Route>
          <Route element={<RequirePermission permission="import.run" />}>
            <Route path="stock/opening" element={<OpeningStockPage />} />
          </Route>
          <Route element={<RequirePermission permission="purchases.view" />}>
            <Route path="purchases" element={<PurchasesPage />} />
            <Route path="purchases/:id" element={<PurchaseDetailPage />} />
          </Route>
          <Route element={<RequirePermission permission="purchases.manage" />}>
            <Route path="purchases/new" element={<PurchaseNewPage />} />
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