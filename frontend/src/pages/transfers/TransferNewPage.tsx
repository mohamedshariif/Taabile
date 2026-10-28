import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../../api/client';
import type { Transfer } from '../../api/types';
import { Button, Card, ErrorText, Field, FieldRow, Input, Muted, PageTitle, Select } from '../../components/ui';
import { transferBody, transferProblems, type DraftLine } from '../../lib/stock';
import { LinesEditor } from '../../features/stock/LinesEditor';
import { useIdempotencyKey, useLocations } from '../../features/stock/hooks';

// Ask for goods to be moved from one place to another. The sending place approves and sends them.
export function TransferNewPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { all, usable } = useLocations('stock.transfer');
  const places = all.filter((l) => l.status === 'ACTIVE');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [note, setNote] = useState('');
  const keyFor = useIdempotencyKey();
  const save = useMutation({
    mutationFn: () => {
      const body = transferBody(from, to, lines, note);
      return api<{ transfer: Transfer }>('/transfers', { method: 'POST', body, idempotencyKey: keyFor(body) });
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['transfers'] });
      navigate(`/transfers/${r.transfer.id}`);
    },
  });
  const problems = transferProblems(from, to, lines);
  const mine = (id: string) => usable.some((l) => l.id === id);
  const notMine = from && to && !mine(from) && !mine(to);

  return (
    <>
      <p className="mb-2"><Link to="/transfers">← Transfers</Link></p>
      <PageTitle>New transfer</PageTitle>
      <Muted>Say where the goods should come from and where they go. Nothing moves yet: the sending place checks, approves and sends it.</Muted>
      <Card as="form" onSubmit={(e) => { e.preventDefault(); if (!problems.length && !notMine) save.mutate(); }}>
        <FieldRow>
          <Field label="From (sending place)">
            <Select value={from} onChange={(e) => setFrom(e.target.value)}>
              <option value="">Choose a place</option>
              {places.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
          </Field>
          <Field label="To (receiving place)">
            <Select value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">Choose a place</option>
              {places.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
          </Field>
        </FieldRow>
        {notMine && <ErrorText>One of the two places must be a place you work at.</ErrorText>}
        <div className="mt-4">
          <LinesEditor lines={lines} onChange={setLines} priceLabel="" priceCheck={() => undefined} withPrice={false} qtyLabel="How much" />
        </div>
        <Field label="Note (optional)" className="mt-4 block">
          <Input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {problems.length > 0 && lines.length > 0 && <Muted small className="mt-3">{problems.join('. ')}.</Muted>}
        <div className="mt-4">
          <Button type="submit" disabled={problems.length > 0 || !!notMine || save.isPending}>{save.isPending ? 'Saving…' : 'Request transfer'}</Button>
        </div>
        {save.isError && <ErrorText>{errorMessage(save.error)}</ErrorText>}
      </Card>
    </>
  );
}