import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, errorMessage } from '../../api/client';
import type { Expense } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { Badge, Button, Card, ErrorText, Field, Input, Muted, PageTitle } from '../../components/ui';
import { checkReason, money } from '../../lib/stock';
import { day } from '../purchases/PurchasesPage';
import { useIdempotencyKey } from '../../features/stock/hooks';

export function ExpenseDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['expense', id], queryFn: () => api<{ expense: Expense }>(`/expenses/${id}`) });
  const keyFor = useIdempotencyKey();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const cancel = useMutation({
    mutationFn: () => {
      const body = { reason: reason.trim() };
      return api(`/expenses/${id}/void`, { method: 'POST', body, idempotencyKey: keyFor({ id, body }) });
    },
    onSuccess: () => {
      setOpen(false);
      for (const k of ['expense', 'expenses', 'money-accounts']) void qc.invalidateQueries({ queryKey: [k] });
    },
  });
  if (q.isLoading) return <Muted>Loading…</Muted>;
  if (q.isError || !q.data) return <ErrorText>{errorMessage(q.error)}</ErrorText>;
  const e = q.data.expense;
  return (
    <>
      <p className="mb-2"><Link to="/expenses">← Expenses</Link></p>
      <PageTitle>{e.number} {e.status === 'VOIDED' ? <Badge tone="off">Cancelled</Badge> : <Badge tone="ok">Posted</Badge>}</PageTitle>
      <Card>
        <div className="text-sm text-muted">{e.category.name} · {day(e.incurredOn)}</div>
        <div className="mt-1 text-2xl font-bold">{money(e.amount)} USD</div>
        <p className="mt-2">{e.description}</p>
        <p className="mt-2 text-muted">Paid from {e.account?.name ?? '—'} · {e.location?.name ?? 'Company-wide'}</p>
      </Card>
      {can('expenses.approve') && e.status === 'POSTED' && (
        <div className="mt-5">
          {!open ? <Button variant="ghost" onClick={() => setOpen(true)}>Cancel this expense</Button> : (
            <Card as="form" onSubmit={(ev) => { ev.preventDefault(); if (!checkReason(reason)) cancel.mutate(); }} className="border-warn">
              <div className="font-semibold">Cancel this expense?</div>
              <Muted small>The money goes back into the account in the books. The expense stays on record as cancelled.</Muted>
              <Field label="Reason" error={reason ? checkReason(reason) : undefined} className="mt-3 block"><Input value={reason} maxLength={200} onChange={(ev) => setReason(ev.target.value)} /></Field>
              <div className="mt-3 flex gap-2">
                <Button type="submit" variant="danger" disabled={!!checkReason(reason) || cancel.isPending}>Cancel expense</Button>
                <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Back</Button>
              </div>
              {cancel.isError && <ErrorText>{errorMessage(cancel.error)}</ErrorText>}
            </Card>
          )}
        </div>
      )}
    </>
  );
}