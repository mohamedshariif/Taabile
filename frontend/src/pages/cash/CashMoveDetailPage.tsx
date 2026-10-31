import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, errorMessage } from '../../api/client';
import type { CashTransfer } from '../../api/types';
import { Badge, Button, Card, ErrorText, Field, FieldRow, Input, Muted, PageTitle } from '../../components/ui';
import { confirmBody, confirmProblems, TRANSFER_LABEL } from '../../lib/cash';
import { money } from '../../lib/stock';
import { day } from '../purchases/PurchasesPage';
import { useIdempotencyKey } from '../../features/stock/hooks';

export function CashMoveDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['cash-transfer', id], queryFn: () => api<{ transfer: CashTransfer }>(`/cash/transfers/${id}`) });
  const keyFor = useIdempotencyKey();
  const [received, setReceived] = useState('');
  const [note, setNote] = useState('');
  const confirm = useMutation({
    mutationFn: () => {
      const body = confirmBody(received, note);
      return api(`/cash/transfers/${id}/confirm`, { method: 'POST', body, idempotencyKey: keyFor({ id, body }) });
    },
    onSuccess: () => { for (const k of ['cash-transfer', 'cash-transfers', 'money-accounts']) void qc.invalidateQueries({ queryKey: [k] }); },
  });
  if (q.isLoading) return <Muted>Loading…</Muted>;
  if (q.isError || !q.data) return <ErrorText>{errorMessage(q.error)}</ErrorText>;
  const t = q.data.transfer;
  const problems = confirmProblems(t.amount, received, note);
  return (
    <>
      <p className="mb-2"><Link to="/cash/moves">← Cash movements</Link></p>
      <PageTitle>{t.number} {t.status === 'PENDING' ? <Badge tone="wait">On its way</Badge> : <Badge tone="ok">Done</Badge>}</PageTitle>
      <Card>
        <div className="text-sm text-muted">{TRANSFER_LABEL[t.type]} · {day(t.occurredAt)}</div>
        <div className="mt-1 text-lg font-semibold">{t.from.name} → {t.to.name}</div>
        <div className="mt-1 text-2xl font-bold">{money(t.amount)} USD</div>
        {t.status === 'CONFIRMED' && t.received !== null && Number(t.difference) !== 0 && (
          <p className="mt-2 text-warn">Received {money(t.received)}, {Number(t.difference) > 0 ? 'short by' : 'over by'} {money(String(Math.abs(Number(t.difference))))}{t.differenceNote ? `: ${t.differenceNote}` : ''}</p>
        )}
      </Card>
      {t.status === 'PENDING' && (
        <Card as="form" onSubmit={(e) => { e.preventDefault(); if (!problems.length) confirm.mutate(); }}>
          <div className="font-semibold">Confirm what arrived</div>
          <Muted small>Count the money. Leave the amount empty if all {money(t.amount)} arrived. Someone other than the sender confirms it.</Muted>
          <FieldRow>
            <Field label="Amount received (USD)"><Input value={received} inputMode="decimal" placeholder={money(t.amount)} onChange={(e) => setReceived(e.target.value)} /></Field>
            <Field label="Note (needed if it differs)"><Input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} /></Field>
          </FieldRow>
          {problems.length > 0 && <Muted small>{problems.join('. ')}.</Muted>}
          <div className="mt-3"><Button type="submit" disabled={problems.length > 0 || confirm.isPending}>{confirm.isPending ? 'Saving…' : 'Confirm'}</Button></div>
          {confirm.isError && <ErrorText>{errorMessage(confirm.error)}</ErrorText>}
        </Card>
      )}
    </>
  );
}