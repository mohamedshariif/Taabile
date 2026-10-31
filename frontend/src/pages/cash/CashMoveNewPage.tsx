import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../../api/client';
import type { CashChoice, CashTransfer } from '../../api/types';
import { Button, Card, ErrorText, Field, FieldRow, Input, Muted, PageTitle, Select } from '../../components/ui';
import { moveBody, moveProblems, needsConfirmation, TRANSFER_LABEL, transferKind, type MoveDraft } from '../../lib/cash';
import { useIdempotencyKey } from '../../features/stock/hooks';

export function CashMoveNewPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [d, setD] = useState<MoveDraft>({ fromId: '', toId: '', amount: '', note: '' });
  const set = (patch: Partial<MoveDraft>) => setD((x) => ({ ...x, ...patch }));
  const choices = useQuery({ queryKey: ['cash-choices'], queryFn: () => api<{ from: CashChoice[]; to: CashChoice[] }>('/cash/accounts') });
  const from = choices.data?.from.find((a) => a.id === d.fromId);
  const to = choices.data?.to.find((a) => a.id === d.toId);
  const kind = transferKind(from, to);
  const problems = moveProblems(d);
  const label = (a: CashChoice) => `${a.name}${a.place ? ` (${a.place})` : ''}`;
  const keyFor = useIdempotencyKey();
  const save = useMutation({
    mutationFn: () => {
      const body = moveBody(d);
      return api<{ transfer: CashTransfer }>('/cash/transfers', { method: 'POST', body, idempotencyKey: keyFor(body) });
    },
    onSuccess: (r) => {
      for (const k of ['cash-transfers', 'money-accounts']) void qc.invalidateQueries({ queryKey: [k] });
      navigate(`/cash/moves/${r.transfer.id}`);
    },
  });
  return (
    <>
      <p className="mb-2"><Link to="/cash/moves">← Cash movements</Link></p>
      <PageTitle>Move money</PageTitle>
      <Muted>Take money out of one account and put it into another. You cannot move more than the account holds.</Muted>
      <Card as="form" onSubmit={(e) => { e.preventDefault(); if (!problems.length) save.mutate(); }}>
        <FieldRow>
          <Field label="From">
            <Select value={d.fromId} onChange={(e) => set({ fromId: e.target.value })}>
              <option value="">Choose…</option>
              {(choices.data?.from ?? []).map((a) => <option key={a.id} value={a.id}>{label(a)}</option>)}
            </Select>
          </Field>
          <Field label="To">
            <Select value={d.toId} onChange={(e) => set({ toId: e.target.value })}>
              <option value="">Choose…</option>
              {(choices.data?.to ?? []).filter((a) => a.id !== d.fromId).map((a) => <option key={a.id} value={a.id}>{label(a)}</option>)}
            </Select>
          </Field>
          <Field label="Amount (USD)"><Input value={d.amount} inputMode="decimal" onChange={(e) => set({ amount: e.target.value })} /></Field>
        </FieldRow>
        <Field label="Note (optional)" className="block"><Input value={d.note} maxLength={200} onChange={(e) => set({ note: e.target.value })} /></Field>
        {kind && (
          <Muted small className="mt-3">
            {TRANSFER_LABEL[kind]}. {needsConfirmation(kind) ? 'The money is "on its way" until the receiving side confirms what really arrived.' : 'The money moves at once.'}
          </Muted>
        )}
        {d.amount.trim() !== '' && problems.length > 0 && <Muted small className="mt-3">{problems.join('. ')}.</Muted>}
        <div className="mt-4"><Button type="submit" disabled={problems.length > 0 || save.isPending}>{save.isPending ? 'Saving…' : 'Move money'}</Button></div>
        {save.isError && <ErrorText>{errorMessage(save.error)}</ErrorText>}
      </Card>
    </>
  );
}