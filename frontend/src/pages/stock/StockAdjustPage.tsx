import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../../api/client';
import type { ProductSummary } from '../../api/types';
import { Button, Card, ErrorText, Field, FieldRow, Input, Muted, PageTitle, Select } from '../../components/ui';
import { ProductPicker } from '../../components/ProductPicker';
import { trimNumber } from '../../lib/products';
import { adjustBody, checkQuantity, checkReason, newLine } from '../../lib/stock';
import { useIdempotencyKey, useLocations } from '../../features/stock/hooks';

// Found stock, a loss, or damaged / expired goods. A reason is always required and is kept forever.
export function StockAdjustPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { usable, isLoading } = useLocations('stock.adjust_approve');
  const [locationId, setLocationId] = useState('');
  const [product, setProduct] = useState<ProductSummary | null>(null);
  const [unitId, setUnitId] = useState('');
  const [kind, setKind] = useState<'ADJUSTMENT' | 'DAMAGE'>('ADJUSTMENT');
  const [direction, setDirection] = useState<'IN' | 'OUT'>('OUT');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (!locationId && usable.length === 1) setLocationId(usable[0]!.id);
  }, [usable, locationId]);

  const keyFor = useIdempotencyKey();
  const save = useMutation({
    mutationFn: () => {
      const body = adjustBody({ locationId, product: product!, unitId, direction, kind, qty, reason });
      return api<{ onHand: string }>('/stock/adjustments', { method: 'POST', body, idempotencyKey: keyFor(body) });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['stock'] });
      void qc.invalidateQueries({ queryKey: ['stock-movements'] });
      navigate('/stock');
    },
  });

  const qtyProblem = product && qty ? checkQuantity(qty, product, unitId) : undefined;
  const ready = !!locationId && !!product && !checkQuantity(qty, product, unitId) && !checkReason(reason);

  return (
    <>
      <p className="mb-2"><Link to="/stock">← Stock</Link></p>
      <PageTitle>Adjust stock</PageTitle>
      <Muted>Use this when the shelf and the system disagree: something found, lost, spoiled or expired. Stock that is found comes in at the current average cost.</Muted>

      <Card as="form" onSubmit={(e) => { e.preventDefault(); if (ready) save.mutate(); }}>
        <FieldRow>
          <Field label="Where">
            <Select value={locationId} onChange={(e) => setLocationId(e.target.value)} disabled={isLoading}>
              <option value="">Choose a place</option>
              {usable.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
          </Field>
          <Field label="What happened">
            <Select value={kind} onChange={(e) => setKind(e.target.value as 'ADJUSTMENT' | 'DAMAGE')}>
              <option value="ADJUSTMENT">Count correction</option>
              <option value="DAMAGE">Damaged or expired</option>
            </Select>
          </Field>
          {kind === 'ADJUSTMENT' && (
            <Field label="Direction">
              <Select value={direction} onChange={(e) => setDirection(e.target.value as 'IN' | 'OUT')}>
                <option value="OUT">Less than the system says (lost)</option>
                <option value="IN">More than the system says (found)</option>
              </Select>
            </Field>
          )}
        </FieldRow>

        {product ? (
          <div className="my-3 rounded-lg border border-line p-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-semibold">{product.name}</div>
                <div className="text-sm text-muted">{product.sku}</div>
              </div>
              <Button variant="link" className="min-h-9" onClick={() => setProduct(null)}>Change</Button>
            </div>
            <FieldRow>
              <Field label="Unit">
                <Select value={unitId} onChange={(e) => setUnitId(e.target.value)}>
                  {product.units.filter((u) => u.status === 'ACTIVE').map((u) => (
                    <option key={u.id} value={u.id}>{u.name}{u.isBase ? '' : ` (${trimNumber(u.factor)} ${product.baseUnit})`}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Quantity" error={qtyProblem}>
                <Input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" />
              </Field>
            </FieldRow>
          </div>
        ) : (
          <div className="my-3">
            {/* Adjustments start in the smallest unit: a wrong default then costs a little, not a whole sack. */}
            <ProductPicker label="Which product?" onPick={(p) => { setProduct(p); setUnitId(p.units.find((u) => u.isBase)?.id ?? newLine(p).unitId); }} />
          </div>
        )}

        <Field label="Reason" hint="For example: spilled bag, counted again, rats, expired." error={reason ? checkReason(reason) : undefined}>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
        </Field>
        <div className="mt-4">
          <Button type="submit" disabled={!ready || save.isPending}>{save.isPending ? 'Saving…' : 'Save adjustment'}</Button>
        </div>
        {save.isError && <ErrorText>{errorMessage(save.error)}</ErrorText>}
      </Card>
    </>
  );
}