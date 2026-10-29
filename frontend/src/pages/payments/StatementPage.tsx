import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, errorMessage } from '../../api/client';
import type { Statement } from '../../api/types';
import { Button, Card, DataTable, ErrorText, Field, FieldRow, Input, Muted, PageTitle, type Column } from '../../components/ui';
import { money } from '../../lib/stock';

type Line = Statement['lines'][number];

// A statement read straight from the accounting books: what was charged, what was paid, and the running balance.
export function StatementPage({ kind }: { kind: 'customer' | 'supplier' }) {
  const { id = '' } = useParams();
  const isCustomer = kind === 'customer';
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const q = useQuery({
    queryKey: ['statement', kind, id, from, to],
    queryFn: () => {
      const qs = new URLSearchParams({ [isCustomer ? 'customerId' : 'supplierId']: id });
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      return api<Statement>(`/payments/statement?${qs.toString()}`);
    },
  });
  const docPath = (l: Line) => (!l.document ? null : l.document.kind === 'SALE' ? `/sales/${l.document.id}` : l.document.kind === 'PAYMENT' ? `/payments/${l.document.id}` : `/purchases/${l.document.id}`);
  const columns: Column<Line>[] = [
    { header: 'Date', primary: true, cell: (l) => l.date },
    { header: 'What', cell: (l) => { const p = docPath(l); return <>{p && l.document ? <Link to={p}>{l.document.number}</Link> : l.entry}<div className="text-sm text-muted">{l.description}</div></>; } },
    { header: isCustomer ? 'Charged' : 'Billed', cell: (l) => (Number(l.charge) ? money(l.charge) : '') },
    { header: 'Paid', cell: (l) => (Number(l.paid) ? money(l.paid) : '') },
    { header: 'Balance', cell: (l) => <span className="font-semibold">{money(l.balance)}</span> },
  ];
  const s = q.data;
  return (
    <>
      <p className="mb-2"><Link to={`/${isCustomer ? 'customers' : 'suppliers'}/${id}`}>← Back</Link></p>
      <PageTitle>Statement{s ? `: ${s.party.name}` : ''}</PageTitle>
      <Muted>{isCustomer ? 'A positive balance is money the customer still owes you.' : 'A positive balance is money you still owe the supplier.'}</Muted>
      <FieldRow>
        <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </FieldRow>
      {q.isLoading && <Muted>Loading…</Muted>}
      {q.isError && <ErrorText>{errorMessage(q.error)}</ErrorText>}
      {s && (
        <>
          {s.from && <Card><div className="flex justify-between"><span>Balance before {s.from}</span><span className="font-semibold">{money(s.openingBalance)}</span></div></Card>}
          <DataTable rows={s.lines} columns={columns} rowKey={(l) => `${l.entry}-${l.balance}-${l.charge}-${l.paid}`} empty="Nothing in this period." />
          <Card><div className="flex justify-between text-lg font-bold"><span>Balance (USD)</span><span>{money(s.closingBalance)}</span></div></Card>
          <Button variant="ghost" className="print:hidden" onClick={() => window.print()}>Print</Button>
        </>
      )}
    </>
  );
}