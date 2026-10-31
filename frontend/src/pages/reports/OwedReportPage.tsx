import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../../api/client';
import type { OwedParty, OwedReport } from '../../api/types';
import { DataTable, ErrorText, Muted, PageTitle, SectionTitle, type Column } from '../../components/ui';
import { OWED_BUCKETS } from '../../lib/reports';
import { money } from '../../lib/stock';
import { CsvButton, LedgerCheck, queryString, RangeBar, Stat, StatGrid, type RangeState } from './parts';

// "Who owes us" (customers) and "Whom we owe" (suppliers): the same report, with ageing by days past the due date.
export function OwedReportPage({ kind }: { kind: 'customer' | 'supplier' }) {
  const isC = kind === 'customer';
  const [r, setR] = useState<RangeState>({ from: '', to: '', locationId: '' });
  const q = useQuery({
    queryKey: ['report-owed', kind, r.locationId],
    queryFn: () => api<OwedReport>(`/reports/${isC ? 'receivables' : 'payables'}${queryString({ locationId: r.locationId })}`),
  });
  const o = q.data;
  const columns: Column<OwedParty>[] = [
    { header: isC ? 'Customer' : 'Supplier', primary: true, cell: (p) => <><Link to={`/${isC ? 'customers' : 'suppliers'}/${p.id}/statement`}>{p.name}</Link><div className="text-sm font-normal text-muted">{p.phone ?? p.code}</div></> },
    { header: 'Owed (USD)', cell: (p) => <span className="font-semibold">{money(p.owed)}</span> },
    { header: 'Not due yet', cell: (p) => money(p.notDue) },
    { header: '1–30 late', cell: (p) => money(p.days1to30) },
    { header: '31–60 late', cell: (p) => money(p.days31to60) },
    { header: '61–90 late', cell: (p) => money(p.days61to90) },
    { header: 'Over 90', cell: (p) => money(p.over90) },
  ];
  return (
    <>
      <p className="mb-2"><Link to="/reports">← Reports</Link></p>
      <PageTitle>{isC ? 'Who owes us' : 'Whom we owe'}</PageTitle>
      <Muted>{isC ? 'Valid sales that are not fully paid.' : 'Valid purchases that are not fully paid.'} "Late" counts the days past the due date; with no due date, the days since {isC ? 'the sale' : 'the delivery'}.</Muted>
      <RangeBar value={r} onChange={setR} permission="payments.view" withDates={false} />
      {q.isLoading && <Muted>Loading…</Muted>}
      {q.isError && <ErrorText>{errorMessage(q.error)}</ErrorText>}
      {o && (
        <>
          <StatGrid>
            <Stat label={isC ? 'Total owed to us (USD)' : 'Total we owe (USD)'} value={money(o.total)} hint={`${o.parties.length} ${isC ? 'customer' : 'supplier'}${o.parties.length === 1 ? '' : 's'}`} />
            {OWED_BUCKETS.filter(([k]) => k !== 'notDue' && Number(o.buckets[k]) > 0).map(([k, label]) => <Stat key={k} label={label} value={money(o.buckets[k])} />)}
          </StatGrid>
          <LedgerCheck difference={o.difference} what={isC ? 'The total owed by customers' : 'The total owed to suppliers'} />
          <div className="flex items-center justify-between"><SectionTitle>{isC ? 'Customers' : 'Suppliers'}</SectionTitle>
            <CsvButton name={isC ? 'who-owes-us' : 'whom-we-owe'} headers={['Name', 'Phone', 'Open documents', 'Owed', 'Not due yet', '1-30 late', '31-60 late', '61-90 late', 'Over 90']}
              rows={o.parties.map((p) => [p.name, p.phone, p.openDocuments, p.owed, p.notDue, p.days1to30, p.days31to60, p.days61to90, p.over90])} />
          </div>
          <DataTable rows={o.parties} columns={columns} rowKey={(p) => p.id} empty={isC ? 'Nobody owes you anything.' : 'You owe nothing.'} />
        </>
      )}
    </>
  );
}