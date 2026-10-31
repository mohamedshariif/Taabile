import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../../api/client';
import type { ReportOverview } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { Card, ErrorText, Muted, PageTitle, SectionTitle } from '../../components/ui';
import { shortDay } from '../../lib/reports';
import { money } from '../../lib/stock';
import { Stat, StatGrid } from './parts';

// The first numbers an owner looks at, and the way to every report. A figure you may not see is simply not shown.
export function ReportsHomePage() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['report-overview'], queryFn: () => api<ReportOverview>('/reports/overview') });
  const o = q.data;
  const links = [
    { to: '/reports/sales', title: 'Sales', text: 'Sales by day, by place and by product.', show: can('reports.view') },
    { to: '/reports/profit-loss', title: 'Profit and loss', text: 'What you earned, what it cost, and what is left.', show: can('accounting.view') },
    { to: '/reports/stock-value', title: 'Value of stock', text: 'What the goods in your stores and warehouses cost you.', show: can('cost.view') && can('stock.view') },
    { to: '/reports/receivables', title: 'Who owes us', text: 'Customers who have not paid yet, and for how long.', show: can('payments.view') },
    { to: '/reports/payables', title: 'Whom we owe', text: 'Suppliers you have not paid yet, and for how long.', show: can('payments.view') },
  ].filter((l) => l.show);
  return (
    <>
      <PageTitle>Reports</PageTitle>
      {q.isLoading && <Muted>Loading…</Muted>}
      {q.isError && <ErrorText>{errorMessage(q.error)}</ErrorText>}
      {o && (
        <>
          <Muted>As of {shortDay(o.asOf)} · USD</Muted>
          <StatGrid>
            <Stat label="Sales today" value={money(o.salesToday.total)} hint={`${o.salesToday.count} sale${o.salesToday.count === 1 ? '' : 's'}`} />
            <Stat label="Sales this month" value={money(o.salesThisMonth.total)} hint={`${o.salesThisMonth.count} sale${o.salesThisMonth.count === 1 ? '' : 's'}`} />
            {o.cashAndBank !== null && <Stat label="Cash and bank" value={money(o.cashAndBank)} hint={<Link to="/cash">See accounts</Link>} />}
            {o.owedToUs !== null && <Stat label="Customers owe us" value={money(o.owedToUs)} hint={<Link to="/reports/receivables">Who owes</Link>} />}
            {o.weOwe !== null && <Stat label="We owe suppliers" value={money(o.weOwe)} hint={<Link to="/reports/payables">Whom we owe</Link>} />}
            {o.stockValue !== null && <Stat label="Value of stock" value={money(o.stockValue)} hint={<Link to="/reports/stock-value">See details</Link>} />}
          </StatGrid>
        </>
      )}
      <SectionTitle>All reports</SectionTitle>
      <div className="grid gap-3 sm:grid-cols-2">
        {links.map((l) => (
          <Card key={l.to} className="my-0">
            <Link to={l.to} className="text-lg font-semibold">{l.title}</Link>
            <Muted small>{l.text}</Muted>
          </Card>
        ))}
      </div>
    </>
  );
}