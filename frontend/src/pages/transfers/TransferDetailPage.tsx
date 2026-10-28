import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, errorMessage } from '../../api/client';
import type { Transfer } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { useMe } from '../../auth/AuthContext';
import { Badge, Button, Card, DataTable, ErrorText, Field, Input, Muted, PageTitle, SectionTitle, type Column } from '../../components/ui';
import { trimNumber } from '../../lib/products';
import { receiveBody, receiveProblems, TRANSFER_LABEL } from '../../lib/stock';
import { day } from '../purchases/PurchasesPage';
import { useIdempotencyKey } from '../../features/stock/hooks';

type Line = Transfer['lines'][number];

// One transfer and what can be done with it next, depending on its status and on which place the person works at.
export function TransferDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const me = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['transfer', id], queryFn: () => api<{ transfer: Transfer }>(`/transfers/${id}`) });
  const keyFor = useIdempotencyKey();
  const [mode, setMode] = useState<'' | 'reject' | 'close' | 'receive' | 'send'>('');
  const [text, setText] = useState('');
  const [typed, setTyped] = useState<Record<string, { qty: string; note: string }>>({});
  const [sendQty, setSendQty] = useState<Record<string, string>>({});

  const act = useMutation({
    mutationFn: ({ what, body }: { what: string; body: object }) => api(`/transfers/${id}/${what}`, { method: 'POST', body, idempotencyKey: keyFor({ id, what, body }) }),
    onSuccess: () => {
      setMode('');
      setText('');
      for (const k of ['transfer', 'transfers', 'stock', 'stock-movements']) void qc.invalidateQueries({ queryKey: [k] });
    },
  });

  if (q.isLoading) return <Muted>Loading…</Muted>;
  if (q.isError || !q.data) return <ErrorText>{errorMessage(q.error)}</ErrorText>;
  const t = q.data.transfer;
  const atFrom = me.locationIds.includes(t.from.id) || me.permissions['stock.transfer'] === 'company';
  const atTo = me.locationIds.includes(t.to.id) || me.permissions['stock.receive'] === 'company';
  const mayTransfer = can('stock.transfer') && atFrom;
  const mayReceive = can('stock.receive') && atTo;
  const mayClose = can('stock.adjust_approve') && (atFrom || atTo);
  const sent = t.lines.filter((l) => Number(l.qtyDispatched) > 0).map((l) => ({ ...l, productId: l.product.id }));
  const recvProblems = receiveProblems(sent, typed);
  const sendBad = Object.entries(sendQty).some(([pid, v]) => v.trim() !== '' && (!/^\d{1,14}(\.\d{1,4})?$/.test(v.trim()) || Number(v) > Number(t.lines.find((l) => l.product.id === pid)?.qtyRequested ?? 0)));
  const run = (what: string, body: object = {}) => act.mutate({ what, body });

  const columns: Column<Line>[] = [
    { header: 'Product', primary: true, cell: (l) => <><span className="font-semibold">{l.product.name}</span><div className="text-sm font-normal text-muted">{l.product.sku}</div></> },
    { header: 'Asked for', cell: (l) => `${trimNumber(l.qtyRequested)} ${l.product.baseUnit}` },
    { header: 'Sent', cell: (l) => (t.status === 'REQUESTED' || t.status === 'APPROVED' ? '—' : `${trimNumber(l.qtyDispatched)} ${l.product.baseUnit}`) },
    { header: 'Received', cell: (l) => (['RECEIVED', 'DISCREPANCY', 'CLOSED'].includes(t.status) ? `${trimNumber(l.qtyReceived)} ${l.product.baseUnit}` : '—') },
    { header: 'What happened', cell: (l) => l.discrepancyNote ?? '' },
  ];

  const form = (title: string, hint: string, label: string, go: () => void, ok: boolean, danger = false) => (
    <Card as="form" onSubmit={(e) => { e.preventDefault(); if (ok) go(); }} className="border-warn">
      <div className="font-semibold">{title}</div>
      <Muted small>{hint}</Muted>
      <Field label={label === 'Send' ? '' : 'Reason'} className="mt-3 block">
        <Input value={text} maxLength={200} onChange={(e) => setText(e.target.value)} />
      </Field>
      <div className="mt-3 flex gap-2">
        <Button type="submit" variant={danger ? 'danger' : 'primary'} disabled={!ok || act.isPending}>{act.isPending ? 'Saving…' : label}</Button>
        <Button variant="ghost" onClick={() => setMode('')}>Back</Button>
      </div>
    </Card>
  );

  return (
    <>
      <p className="mb-2"><Link to="/transfers">← Transfers</Link></p>
      <PageTitle>{t.number} <Badge tone={t.status === 'DISCREPANCY' ? 'wait' : ['REJECTED', 'CANCELLED', 'CLOSED'].includes(t.status) ? 'off' : 'ok'}>{TRANSFER_LABEL[t.status]}</Badge></PageTitle>
      <Muted>{t.from.name} → {t.to.name} · asked {day(t.requestedAt)}{t.dispatchedAt ? ` · sent ${day(t.dispatchedAt)}` : ''}{t.receivedAt ? ` · received ${day(t.receivedAt)}` : ''}</Muted>
      {t.note && <p className="mt-2 whitespace-pre-line">{t.note}</p>}
      <SectionTitle>Goods</SectionTitle>
      <DataTable rows={t.lines} columns={columns} rowKey={(l) => l.id} empty="No lines." />

      <div className="mt-5 space-y-3">
        {act.isError && <ErrorText>{errorMessage(act.error)}</ErrorText>}

        {['REQUESTED', 'APPROVED'].includes(t.status) && mode === '' && (
          <div className="flex flex-wrap gap-2">
            {mayTransfer && t.status === 'REQUESTED' && <Button variant="ghost" onClick={() => run('approve')} disabled={act.isPending}>Approve</Button>}
            {mayTransfer && <Button onClick={() => setMode('send')}>Send the goods</Button>}
            {mayTransfer && t.status === 'REQUESTED' && <Button variant="ghost" onClick={() => setMode('reject')}>Reject</Button>}
            {can('stock.transfer') && (atFrom || atTo) && <Button variant="ghost" onClick={() => run('cancel')} disabled={act.isPending}>Cancel</Button>}
          </div>
        )}

        {mode === 'reject' && form('Reject this transfer?', 'The requesting place is told no. Nothing moves.', 'Reject', () => run('reject', { reason: text.trim() }), text.trim().length >= 3, true)}

        {mode === 'send' && (
          <Card as="form" onSubmit={(e) => { e.preventDefault(); if (!sendBad) run('dispatch', Object.keys(sendQty).some((k) => sendQty[k]!.trim() !== '') ? { lines: t.lines.map((l) => ({ productId: l.product.id, quantity: (sendQty[l.product.id] ?? '').trim() || l.qtyRequested })) } : {}); }} className="border-warn">
            <div className="font-semibold">Send the goods</div>
            <Muted small>The stock leaves {t.from.name} now, at its cost. If you cannot send everything, type what really goes (0 = none of that product).</Muted>
            <ul className="mt-3 space-y-2">
              {t.lines.map((l) => (
                <li key={l.id} className="grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_10rem]">
                  <div>{l.product.name} <span className="text-muted">(asked for {trimNumber(l.qtyRequested)} {l.product.baseUnit})</span></div>
                  <Field label={`Send (${l.product.baseUnit})`}>
                    <Input value={sendQty[l.product.id] ?? ''} placeholder={trimNumber(l.qtyRequested)} inputMode="decimal" onChange={(e) => setSendQty({ ...sendQty, [l.product.id]: e.target.value })} />
                  </Field>
                </li>
              ))}
            </ul>
            {sendBad && <ErrorText>Enter numbers, and not more than was asked for.</ErrorText>}
            <div className="mt-3 flex gap-2">
              <Button type="submit" disabled={sendBad || act.isPending}>{act.isPending ? 'Sending…' : 'Send now'}</Button>
              <Button variant="ghost" onClick={() => setMode('')}>Back</Button>
            </div>
          </Card>
        )}

        {t.status === 'IN_TRANSIT' && mayReceive && mode !== 'receive' && <Button onClick={() => setMode('receive')}>Receive the goods</Button>}
        {t.status === 'IN_TRANSIT' && mode === 'receive' && (
          <Card as="form" onSubmit={(e) => { e.preventDefault(); if (!recvProblems.length) run('receive', receiveBody(sent, typed)); }} className="border-warn">
            <div className="font-semibold">Receive the goods</div>
            <Muted small>Count what arrived. If everything is there, just press Receive. If something is missing, type how much arrived and say what happened.</Muted>
            <ul className="mt-3 space-y-3">
              {sent.map((l) => {
                const v = typed[l.product.id] ?? { qty: '', note: '' };
                const short = v.qty.trim() !== '' && Number(v.qty) < Number(l.qtyDispatched);
                return (
                  <li key={l.id} className="rounded-lg border border-line p-3">
                    <div className="font-semibold">{l.product.name} <span className="font-normal text-muted">(sent {trimNumber(l.qtyDispatched)} {l.product.baseUnit})</span></div>
                    <div className="mt-2 grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)]">
                      <Field label={`Arrived (${l.product.baseUnit})`}>
                        <Input value={v.qty} placeholder={trimNumber(l.qtyDispatched)} inputMode="decimal" onChange={(e) => setTyped({ ...typed, [l.product.id]: { ...v, qty: e.target.value } })} />
                      </Field>
                      {short && (
                        <Field label="What happened to the rest?">
                          <Input value={v.note} maxLength={200} onChange={(e) => setTyped({ ...typed, [l.product.id]: { ...v, note: e.target.value } })} />
                        </Field>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            {recvProblems.length > 0 && <ErrorText>{recvProblems.join('. ')}.</ErrorText>}
            <div className="mt-3 flex gap-2">
              <Button type="submit" disabled={recvProblems.length > 0 || act.isPending}>{act.isPending ? 'Saving…' : 'Receive'}</Button>
              <Button variant="ghost" onClick={() => setMode('')}>Back</Button>
            </div>
          </Card>
        )}

        {t.status === 'DISCREPANCY' && mayClose && mode !== 'close' && <Button onClick={() => setMode('close')}>Close and write off what is missing</Button>}
        {mode === 'close' && form('Close this transfer?', 'The value of the goods that never arrived is written off as an inventory loss. This cannot be undone.', 'Close transfer', () => run('close', { note: text.trim() }), text.trim().length >= 3, true)}
      </div>
    </>
  );
}