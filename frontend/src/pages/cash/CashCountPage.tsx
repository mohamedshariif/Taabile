import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../../api/client';
import type { CashChoice, CashCount } from '../../api/types';
import { Button, Card, ErrorText, Field, FieldRow, Input, Muted, PageTitle, Select } from '../../components/ui';
import { checkCounted, checkNote } from '../../lib/cash';
import { money } from '../../lib/stock';
import { useIdempotencyKey } from '../../features/stock/hooks';

// Count what is really in a drawer. The books' figure is deliberately hidden until you have counted.
export function CashCountPage() {
  const qc = useQueryClient();
  const choices = useQuery({ queryKey: ['cash-choices'], queryFn: () => api<{ from: CashChoice[]; to: CashChoice[] }>('/cash/accounts') });
  const [accountId, setAccountId] = useState('');
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const keyFor = useIdempotencyKey();
  const save = useMutation({
    mutationFn: () => {
      const body = { financialAccountId: accountId, counted: counted.trim(), ...(note.trim() ? { note: note.trim() } : {}) };
      return api<{ count: CashCount }>('/cash/counts', { method: 'POST', body, idempotencyKey: keyFor(body) });
    },
    onSuccess: () => { for (const k of ['money-accounts', 'cash-choices']) void qc.invalidateQueries({ queryKey: [k] }); },
  });
  const problems = [!accountId && 'Choose the drawer', checkCounted(counted)].filter(Boolean) as string[];
  const r = save.data?.count;
  const needsNote = save.isError && /differs from the books/.test(errorMessage(save.error));
  return (
    <>
      <p className="mb-2"><Link to="/cash/moves">← Cash movements</Link></p>
      <PageTitle>Count a drawer</PageTitle>
      <Muted>Count the money in the drawer and type the total. The books' figure is shown after you save. A difference is recorded as a cash shortage or overage and needs a note.</Muted>
      <Card as="form" onSubmit={(e) => { e.preventDefault(); if (!problems.length && !(needsNote && checkNote(note))) save.mutate(); }}>
        <FieldRow>
          <Field label="Which drawer">
            <Select value={accountId} onChange={(e) => { setAccountId(e.target.value); save.reset(); }}>
              <option value="">Choose…</option>
              {(choices.data?.from ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}{a.place ? ` (${a.place})` : ''}</option>)}
            </Select>
          </Field>
          <Field label="Total counted (USD)"><Input value={counted} inputMode="decimal" onChange={(e) => { setCounted(e.target.value); save.reset(); }} /></Field>
        </FieldRow>
        {needsNote && (
          <>
            <ErrorText>{errorMessage(save.error)}</ErrorText>
            <Field label="Why does it differ?" error={note ? checkNote(note) : undefined} className="mt-2 block"><Input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} /></Field>
          </>
        )}
        {counted.trim() !== '' && problems.length > 0 && <Muted small className="mt-3">{problems.join('. ')}.</Muted>}
        <div className="mt-4"><Button type="submit" disabled={problems.length > 0 || save.isPending || (needsNote && !!checkNote(note))}>{save.isPending ? 'Saving…' : needsNote ? 'Save count with note' : 'Save count'}</Button></div>
        {save.isError && !needsNote && <ErrorText>{errorMessage(save.error)}</ErrorText>}
      </Card>
      {r && (
        <Card>
          <div className="font-semibold">{r.result === 'MATCH' ? 'The count matches the books.' : r.result === 'SHORTAGE' ? `Short by ${money(r.difference)} USD.` : `Over by ${money(String(Math.abs(Number(r.difference))))} USD.`}</div>
          <div className="mt-1 text-muted">Books said {money(r.expected)}, you counted {money(r.counted)}.{r.journalEntry ? ` Recorded as ${r.journalEntry}.` : ''}</div>
        </Card>
      )}
    </>
  );
}