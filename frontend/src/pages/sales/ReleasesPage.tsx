import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../../api/client';
import type { PendingRelease } from '../../api/types';
import { Button, DataTable, ErrorText, Input, Muted, PageTitle, type Column } from '../../components/ui';
import { trimNumber } from '../../lib/products';
import { day } from '../purchases/PurchasesPage';
import { useIdempotencyKey } from '../../features/stock/hooks';

// Goods another store sold that your place must hand over. Releasing takes them off your shelf and ends the reservation.
export function ReleasesPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['pending-release'], queryFn: () => api<{ items: PendingRelease[] }>('/sales/pending-release') });
  const keyFor = useIdempotencyKey();
  const [typed, setTyped] = useState<Record<string, string>>({});
  const release = useMutation({
    mutationFn: (r: PendingRelease) => {
      const t = (typed[r.allocationId] ?? '').trim();
      const body = { allocations: [{ allocationId: r.allocationId, quantity: t === '' ? r.remaining : t }] };
      return api(`/sales/${r.sale.id}/release`, { method: 'POST', body, idempotencyKey: keyFor({ id: r.sale.id, body }) });
    },
    onSuccess: () => {
      setTyped({});
      for (const k of ['pending-release', 'sales', 'sale', 'stock', 'stock-movements']) void qc.invalidateQueries({ queryKey: [k] });
    },
  });
  const rows = q.data?.items ?? [];
  const bad = (r: PendingRelease) => {
    const t = (typed[r.allocationId] ?? '').trim();
    return t !== '' && (!/^\d{1,14}(\.\d{1,4})?$/.test(t) || Number(t) <= 0 || Number(t) > Number(r.remaining));
  };
  const columns: Column<PendingRelease>[] = [
    { header: 'Product', primary: true, cell: (r) => <><span className="font-semibold">{r.product.name}</span><div className="text-sm font-normal text-muted">{r.product.sku}</div></> },
    { header: 'Waiting', cell: (r) => `${trimNumber(r.remaining)} ${r.product.baseUnit}` },
    { header: 'Sale', cell: (r) => <><Link to={`/sales/${r.sale.id}`}>{r.sale.number}</Link><div className="text-sm text-muted">{r.sale.location.name}{r.sale.customer ? ` · ${r.sale.customer.name}` : ''} · {day(r.sale.soldAt)}</div></> },
    { header: 'Hand over now', cell: (r) => <Input aria-label="Quantity to release" className="max-w-32" value={typed[r.allocationId] ?? ''} placeholder={trimNumber(r.remaining)} inputMode="decimal" onChange={(e) => setTyped({ ...typed, [r.allocationId]: e.target.value })} /> },
    { header: '', actions: true, cell: (r) => <Button small disabled={bad(r) || release.isPending} onClick={() => release.mutate(r)}>Release</Button> },
  ];
  return (
    <>
      <PageTitle>Goods to hand over</PageTitle>
      <Muted>Sales made at other stores that take goods from your place. Leave the box empty to release everything that is waiting for that line.</Muted>
      {q.isLoading && <Muted className="mt-3">Loading…</Muted>}
      {q.isError && <ErrorText>{errorMessage(q.error)}</ErrorText>}
      {release.isError && <ErrorText>{errorMessage(release.error)}</ErrorText>}
      {q.data && <DataTable rows={rows} columns={columns} rowKey={(r) => r.allocationId} empty="Nothing is waiting to be handed over." />}
    </>
  );
}