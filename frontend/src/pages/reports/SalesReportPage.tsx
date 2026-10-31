import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../../api/client';
import type { SalesReport } from '../../api/types';
import { Card, DataTable, ErrorText, Muted, PageTitle, SectionTitle, type Column } from '../../components/ui';
import { addDays, barPercent, localToday, rangeProblem, shortDay } from '../../lib/reports';
import { money } from '../../lib/stock';
import { CsvButton, queryString, RangeBar, Stat, StatGrid, type RangeState } from './parts';

export function SalesReportPage() {
  const [r, setR] = useState<RangeState>(() => ({ from: addDays(localToday(), -29), to: localToday(), locationId: '' }));
  const problem = rangeProblem(r.from, r.to);
  const q = useQuery({
    queryKey: ['report-sales', r],
    queryFn: () => api<SalesReport>(`/reports/sales${queryString({ from: r.from, to: r.to, locationId: r.locationId })}`),
    enabled: !problem,
  });
  const d = q.data;
  const max = d ? d.days.reduce((m, x) => (Number(x.total) > Number(m) ? x.total : m), '0') : '0';
  const dayRows = d ? d.days.filter((x) => x.count > 0).reverse() : [];
  const byDay: Column<SalesReport['days'][number]>[] = [
    { header: 'Day', primary: true, cell: (x) => shortDay(x.date) },
    { header: 'Sales', cell: (x) => x.count },
    { header: 'Total (USD)', cell: (x) => <span className="font-semibold">{money(x.total)}</span> },
    { header: 'Paid', cell: (x) => money(x.paid) },
    { header: 'Not paid yet', cell: (x) => money(x.unpaid) },
  ];
  return (
    <>
      <p className="mb-2"><Link to="/reports">← Reports</Link></p>
      <PageTitle>Sales</PageTitle>
      <Muted>Valid sales only. A cancelled sale is not counted. Days follow your company's time zone.</Muted>
      <RangeBar value={r} onChange={setR} permission="reports.view" />
      {q.isLoading && !problem && <Muted>Loading…</Muted>}
      {q.isError && <ErrorText>{errorMessage(q.error)}</ErrorText>}
      {d && (
        <>
          <StatGrid>
            <Stat label="Total sold (USD)" value={money(d.totals.total)} hint={`${d.totals.count} sale${d.totals.count === 1 ? '' : 's'}, ${money(d.totals.average)} on average`} />
            <Stat label="Paid so far" value={money(d.totals.paid)} />
            <Stat label="Still to be paid" value={money(d.totals.unpaid)} hint={Number(d.totals.discount) > 0 ? `Discounts given: ${money(d.totals.discount)}` : undefined} />
          </StatGrid>
          <Card>
            <div className="mb-2 font-semibold">Sales per day</div>
            <div role="img" aria-label={`Sales per day from ${shortDay(d.range.from)} to ${shortDay(d.range.to)}`} className="flex h-40 items-end gap-px">
              {d.days.map((x) => (
                <div key={x.date} title={`${shortDay(x.date)}: ${money(x.total)}`} className="flex h-full min-w-0 flex-1 items-end">
                  <div className="w-full rounded-t bg-brand" style={{ height: `${barPercent(x.total, max)}%` }} />
                </div>
              ))}
            </div>
            <div className="mt-1 flex justify-between text-xs text-muted"><span>{shortDay(d.range.from)}</span><span>{shortDay(d.range.to)}</span></div>
          </Card>
          <div className="flex items-center justify-between"><SectionTitle first>By day</SectionTitle>
            <CsvButton name={`sales-${d.range.from}-to-${d.range.to}`} headers={['Day', 'Sales', 'Total', 'Paid', 'Not paid yet', 'Discounts']} rows={d.days.map((x) => [x.date, x.count, x.total, x.paid, x.unpaid, x.discount])} />
          </div>
          <DataTable rows={dayRows} columns={byDay} rowKey={(x) => x.date} empty="No sales in these dates." />
          {d.byLocation.length > 0 && (
            <>
              <SectionTitle>By place</SectionTitle>
              <DataTable rows={d.byLocation} rowKey={(x) => x.locationId} columns={[
                { header: 'Place', primary: true, cell: (x) => x.name },
                { header: 'Sales', cell: (x) => x.count },
                { header: 'Total (USD)', cell: (x) => <span className="font-semibold">{money(x.total)}</span> },
              ]} />
            </>
          )}
          {d.topProducts.length > 0 && (
            <>
              <SectionTitle>Best sellers</SectionTitle>
              <DataTable rows={d.topProducts} rowKey={(x) => x.productId} columns={[
                { header: 'Product', primary: true, cell: (x) => <>{x.name}<div className="text-sm font-normal text-muted">{x.sku}</div></> },
                { header: 'Quantity', cell: (x) => `${money(x.quantity)} ${x.unit}` },
                { header: 'Sold for (USD)', cell: (x) => <span className="font-semibold">{money(x.value)}</span> },
              ]} />
            </>
          )}
        </>
      )}
    </>
  );
}