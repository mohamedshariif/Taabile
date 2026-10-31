import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../../api/client';
import type { StockValueReport } from '../../api/types';
import { DataTable, ErrorText, Muted, PageTitle, SectionTitle } from '../../components/ui';
import { money } from '../../lib/stock';
import { CsvButton, LedgerCheck, queryString, RangeBar, Stat, StatGrid, type RangeState } from './parts';

export function StockValuePage() {
  const [r, setR] = useState<RangeState>({ from: '', to: '', locationId: '' });
  const q = useQuery({
    queryKey: ['report-stock-value', r.locationId],
    queryFn: () => api<StockValueReport>(`/reports/stock-value${queryString({ locationId: r.locationId, limit: '500' })}`),
  });
  const s = q.data;
  return (
    <>
      <p className="mb-2"><Link to="/reports">← Reports</Link></p>
      <PageTitle>Value of stock</PageTitle>
      <Muted>What the goods you hold today cost you (quantity times average cost), as of now.</Muted>
      <RangeBar value={r} onChange={setR} permission="stock.view" withDates={false} />
      {q.isLoading && <Muted>Loading…</Muted>}
      {q.isError && <ErrorText>{errorMessage(q.error)}</ErrorText>}
      {s && (
        <>
          <StatGrid>
            <Stat label="Total value of stock (USD)" value={money(s.total)} hint={`${s.products.length} product${s.products.length === 1 ? '' : 's'}${s.truncated ? ' shown (more exist)' : ''}`} />
          </StatGrid>
          <LedgerCheck difference={s.difference} what="The value of stock" />
          <SectionTitle>By place</SectionTitle>
          <DataTable rows={s.byLocation} rowKey={(x) => x.locationId} empty="No stock." columns={[
            { header: 'Place', primary: true, cell: (x) => x.name },
            { header: 'Products', cell: (x) => x.items },
            { header: 'Value (USD)', cell: (x) => <span className="font-semibold">{money(x.value)}</span> },
          ]} />
          <div className="flex items-center justify-between"><SectionTitle>By product</SectionTitle>
            <CsvButton name="stock-value" headers={['SKU', 'Product', 'Unit', 'Quantity', 'Average cost', 'Value']} rows={s.products.map((x) => [x.sku, x.name, x.unit, x.quantity, x.averageCost, x.value])} />
          </div>
          <DataTable rows={s.products} rowKey={(x) => x.productId} empty="No stock." columns={[
            { header: 'Product', primary: true, cell: (x) => <>{x.name}<div className="text-sm font-normal text-muted">{x.sku}</div></> },
            { header: 'Quantity', cell: (x) => `${money(x.quantity)} ${x.unit}` },
            { header: 'Average cost', cell: (x) => money(x.averageCost) },
            { header: 'Value (USD)', cell: (x) => <span className="font-semibold">{money(x.value)}</span> },
          ]} />
        </>
      )}
    </>
  );
}