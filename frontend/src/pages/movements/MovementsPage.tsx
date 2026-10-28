import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../../api/client';
import type { MovementType, StockMovement } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { Badge, Button, Card, DataTable, ErrorText, Field, Input, Muted, PageTitle, Select, type Column } from '../../components/ui';
import { trimNumber } from '../../lib/products';
import { canReverse, checkReason, money, MOVEMENT_LABEL } from '../../lib/stock';
import { useIdempotencyKey, useLocations } from '../../features/stock/hooks';

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

// Every stock change, newest first. Mistakes are never erased: a manual entry is cancelled by a reversal that stays visible too.
export function MovementsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const productId = params.get('productId') ?? '';
  const [locationId, setLocationId] = useState(params.get('locationId') ?? '');
  const [type, setType] = useState<'' | MovementType>('');
  const { all: locations } = useLocations();

  const list = useInfiniteQuery({
    queryKey: ['stock-movements', { productId, locationId, type }],
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: '50' });
      if (productId) qs.set('productId', productId);
      if (locationId) qs.set('locationId', locationId);
      if (type) qs.set('type', type);
      if (pageParam) qs.set('cursor', pageParam);
      return api<{ items: StockMovement[]; nextCursor: string | null }>(`/stock/movements?${qs.toString()}`);
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const seeCost = rows.some((r) => r.totalCost !== null);

  const [undoing, setUndoing] = useState<StockMovement | null>(null);
  const [reason, setReason] = useState('');
  const keyFor = useIdempotencyKey();
  const undo = useMutation({
    mutationFn: () => {
      const body = { reason: reason.trim() };
      return api(`/stock/movements/${undoing!.id}/reverse`, { method: 'POST', body, idempotencyKey: keyFor({ id: undoing!.id, ...body }) });
    },
    onSuccess: () => {
      setUndoing(null);
      setReason('');
      void qc.invalidateQueries({ queryKey: ['stock-movements'] });
      void qc.invalidateQueries({ queryKey: ['stock'] });
    },
  });
  useEffect(() => undo.reset(), [undoing]); // eslint-disable-line react-hooks/exhaustive-deps

  const mayUndo = (m: StockMovement) => canReverse(m) && can(m.type === 'OPENING' ? 'import.run' : 'stock.adjust_approve');

  const columns: Column<StockMovement>[] = [
    {
      header: 'Product',
      primary: true,
      cell: (m) => (
        <>
          <span className="font-semibold">{m.product.name}</span>
          <div className="text-sm font-normal text-muted">{when(m.occurredAt)} · {m.location.name}</div>
        </>
      ),
    },
    {
      header: 'What happened',
      cell: (m) => (
        <>
          {MOVEMENT_LABEL[m.type]} {m.reversed && <Badge tone="off">Reversed</Badge>}
          {m.reason && <div className="text-sm text-muted">{m.reason}</div>}
        </>
      ),
    },
    {
      header: 'Quantity',
      cell: (m) => <span className={Number(m.quantity) < 0 ? 'font-semibold text-danger' : 'font-semibold'}>{Number(m.quantity) > 0 ? '+' : ''}{trimNumber(m.quantity)} {m.product.baseUnit}</span>,
    },
    ...(seeCost ? [{ header: 'Value', cell: (m: StockMovement) => money(m.totalCost) }] : []),
    { header: '', actions: true, cell: (m) => (mayUndo(m) ? <Button variant="ghost" small onClick={() => setUndoing(m)}>Undo</Button> : null) },
  ];

  return (
    <>
      <p className="mb-2"><Link to="/stock">← Stock</Link></p>
      <PageTitle>Stock history</PageTitle>
      <Muted>Every change to stock, newest first. Nothing is ever erased: a mistake is cancelled by a reversal that you can see here too.</Muted>

      <div className="my-4 grid gap-3 sm:grid-cols-2">
        <Field label="Where">
          <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">All places</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
        </Field>
        <Field label="Kind">
          <Select value={type} onChange={(e) => setType(e.target.value as '' | MovementType)}>
            <option value="">Everything</option>
            {(Object.keys(MOVEMENT_LABEL) as MovementType[]).map((t) => <option key={t} value={t}>{MOVEMENT_LABEL[t]}</option>)}
          </Select>
        </Field>
      </div>
      {productId && (
        <p className="mb-2 text-sm">
          Showing one product only. <button type="button" className="cursor-pointer text-brand underline" onClick={() => setParams({})}>Show all products</button>
        </p>
      )}

      {undoing && (
        <Card as="form" onSubmit={(e) => { e.preventDefault(); if (!checkReason(reason)) undo.mutate(); }} className="border-warn">
          <div className="font-semibold">Undo this entry?</div>
          <Muted small>
            {MOVEMENT_LABEL[undoing.type]}: {undoing.product.name}, {trimNumber(undoing.quantity)} {undoing.product.baseUnit} at {undoing.location.name}. The opposite entry is added; stock and cost go back exactly. Only possible while nothing newer is still in effect for this product here.
          </Muted>
          <Field label="Reason" error={reason ? checkReason(reason) : undefined} className="mt-3 block">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
          </Field>
          <div className="mt-3 flex gap-2">
            <Button type="submit" variant="danger" disabled={undo.isPending || !!checkReason(reason)}>{undo.isPending ? 'Undoing…' : 'Undo entry'}</Button>
            <Button variant="ghost" onClick={() => setUndoing(null)}>Keep it</Button>
          </div>
          {undo.isError && <ErrorText>{errorMessage(undo.error)}</ErrorText>}
        </Card>
      )}

      {list.isLoading && <Muted>Loading…</Muted>}
      {list.isError && <ErrorText>{errorMessage(list.error)}</ErrorText>}
      {list.data && <DataTable rows={rows} columns={columns} rowKey={(m) => m.id} dim={(m) => m.reversed} empty="No stock changes yet." />}
      {list.hasNextPage && (
        <div className="my-3 text-center">
          <Button variant="ghost" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>{list.isFetchingNextPage ? 'Loading…' : 'Show more'}</Button>
        </div>
      )}
    </>
  );
}