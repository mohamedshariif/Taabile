import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../../api/client';
import type { ProfitLine, ProfitLossReport } from '../../api/types';
import { Card, ErrorText, Muted, PageTitle } from '../../components/ui';
import { localToday, rangeProblem, shortDay } from '../../lib/reports';
import { money } from '../../lib/stock';
import { CsvButton, queryString, RangeBar, type RangeState } from './parts';

function Row({ label, value, strong, negative }: { label: string; value: string; strong?: boolean; negative?: boolean }) {
  return (
    <div className={`flex justify-between gap-3 py-1.5 ${strong ? 'border-t border-line font-bold' : ''}`}>
      <span className="min-w-0 wrap-break-word">{label}</span>
      <span className={negative && Number(value) < 0 ? 'text-warn' : ''}>{money(value)}</span>
    </div>
  );
}
const Lines = ({ lines }: { lines: ProfitLine[] }) => <>{lines.map((l) => <Row key={l.code} label={l.name} value={l.amount} />)}</>;

export function ProfitLossPage() {
  const today = localToday();
  const [r, setR] = useState<RangeState>({ from: `${today.slice(0, 7)}-01`, to: today, locationId: '' });
  const problem = rangeProblem(r.from, r.to);
  const q = useQuery({
    queryKey: ['report-pl', r],
    queryFn: () => api<ProfitLossReport>(`/reports/profit-loss${queryString({ from: r.from, to: r.to, locationId: r.locationId })}`),
    enabled: !problem,
  });
  const p = q.data;
  const csvRows = p ? [
    ...p.revenue.map((l) => ['Revenue', l.name, l.amount]), ['Revenue', 'Total revenue', p.revenueTotal],
    ...p.costOfGoods.map((l) => ['Cost of goods', l.name, l.amount]), ['Gross profit', 'Gross profit', p.grossProfit],
    ...p.expenses.map((l) => ['Costs', l.name, l.amount]), ['Costs', 'Total costs', p.expensesTotal], ['Result', 'Net profit', p.netProfit],
  ] : [];
  return (
    <>
      <p className="mb-2"><Link to="/reports">← Reports</Link></p>
      <PageTitle>Profit and loss</PageTitle>
      <Muted>Read from the accounting books. Revenue minus the cost of the goods sold is the gross profit; minus your running costs it is the net profit.</Muted>
      <RangeBar value={r} onChange={setR} permission="accounting.view" />
      {q.isLoading && !problem && <Muted>Loading…</Muted>}
      {q.isError && <ErrorText>{errorMessage(q.error)}</ErrorText>}
      {p && (
        <Card>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="font-semibold">{shortDay(p.range.from)} to {shortDay(p.range.to)} · USD</div>
            <CsvButton name={`profit-loss-${p.range.from}-to-${p.range.to}`} headers={['Section', 'Line', 'Amount']} rows={csvRows} />
          </div>
          {p.note && <Muted small>{p.note}</Muted>}
          <div className="mt-2 font-semibold text-muted">Revenue</div>
          <Lines lines={p.revenue} />
          <Row label="Total revenue" value={p.revenueTotal} strong />
          <div className="mt-3 font-semibold text-muted">Cost of the goods sold</div>
          <Lines lines={p.costOfGoods} />
          <Row label="Total cost of goods" value={p.costOfGoodsTotal} strong />
          <Row label={`Gross profit${p.grossMarginPercent ? ` (${p.grossMarginPercent}% of revenue)` : ''}`} value={p.grossProfit} strong negative />
          <div className="mt-3 font-semibold text-muted">Running costs</div>
          {p.expenses.length === 0 && <Muted small>No costs in these dates.</Muted>}
          <Lines lines={p.expenses} />
          <Row label="Total running costs" value={p.expensesTotal} strong />
          <Row label="Net profit" value={p.netProfit} strong negative />
        </Card>
      )}
    </>
  );
}