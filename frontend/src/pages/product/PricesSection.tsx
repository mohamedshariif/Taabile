import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../../api/client';
import type { PriceList, ProductDetail } from '../../api/types';
import { useMe } from '../../auth/AuthContext';
import { Button, Card, ErrorText, Field, Input, Muted, SectionTitle } from '../../components/ui';
import { describeUnit, formatPrice, priceProblem } from '../../lib/products';
import { useProductCache } from './useProductCache';

// One price per selling unit and price list (for example Retail and Wholesale). A unit with no price on a list is
// simply not sold there. Prices are in the company currency, per ONE of that unit.
export function PricesSection({ product, canEdit }: { product: ProductDetail; canEdit: boolean }) {
  const me = useMe();
  const apply = useProductCache(product.id);
  const lists = useQuery({ queryKey: ['price-lists'], queryFn: () => api<{ priceLists: PriceList[] }>('/price-lists') });

  const keyOf = (listId: string, unitId: string) => `${listId}:${unitId}`;
  const initial = new Map(product.prices.map((x) => [keyOf(x.priceListId, x.unitId), formatPrice(x.price)]));
  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setValues(Object.fromEntries(initial));
  }, [product]);

  const sellUnits = product.units.filter((u) => u.status === 'ACTIVE' && u.isSaleUnit);
  const priceLists = lists.data?.priceLists ?? [];
  const valueOf = (listId: string, unitId: string) => values[keyOf(listId, unitId)] ?? '';

  // Only what changed is sent. An emptied box removes the price (the unit is then not sold on that list).
  const changes = sellUnits.flatMap((u) =>
    priceLists.flatMap((l) => {
      const now = valueOf(l.id, u.id).trim();
      const before = initial.get(keyOf(l.id, u.id)) ?? '';
      if (l.status !== 'ACTIVE' || now === before) return [];
      return [{ priceListId: l.id, unitId: u.id, price: now === '' ? null : now }];
    }),
  );
  const firstProblem = changes.map((c) => (c.price === null ? null : priceProblem(c.price))).find(Boolean) ?? null;

  const save = useMutation({
    mutationFn: () => api<{ product: ProductDetail }>(`/products/${product.id}/prices`, { method: 'PUT', body: { prices: changes } }),
    onSuccess: (r) => {
      apply(r);
      setSaved(true);
    },
  });

  return (
    <>
      <SectionTitle>Selling prices</SectionTitle>
      <Muted small>
        Price of ONE of each unit, in {me.company.currency}. Leave a box empty to not sell that unit on that list.
        {!canEdit && ' Only people with permission to change prices can edit them.'}
      </Muted>
      {sellUnits.length === 0 && <Card>This product has no active selling unit yet.</Card>}
      {lists.isError && <ErrorText>{errorMessage(lists.error)}</ErrorText>}

      <div className="my-3 space-y-3">
        {sellUnits.map((u) => (
          <Card key={u.id} className="my-0">
            <div className="font-semibold">{u.name}</div>
            <div className="mb-2 text-sm text-muted">{describeUnit(u, product.baseUnit)}</div>
            <div className="grid gap-3 sm:grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]">
              {priceLists.map((l) => {
                const v = valueOf(l.id, u.id);
                const bad = priceProblem(v);
                const n = Number(v);
                const f = Number(u.factor);
                const perBase = !u.isBase && !bad && v.trim() !== '' && f > 0 ? `≈ ${formatPrice((n / f).toFixed(4))} per ${product.baseUnit}` : null;
                return (
                  <Field key={l.id} label={`${l.name}${l.status === 'ACTIVE' ? '' : ' (switched off)'}`} error={bad ?? undefined} hint={perBase ?? (canEdit ? undefined : '')}>
                    {canEdit ? (
                      <Input
                        inputMode="decimal"
                        value={v}
                        disabled={l.status !== 'ACTIVE'}
                        placeholder="Not sold"
                        onChange={(e) => {
                          setSaved(false);
                          setValues((x) => ({ ...x, [keyOf(l.id, u.id)]: e.target.value }));
                        }}
                      />
                    ) : (
                      <p className="mt-1 min-h-11 py-2">{v ? `${v} ${me.company.currency}` : <span className="text-muted">Not sold</span>}</p>
                    )}
                  </Field>
                );
              })}
            </div>
          </Card>
        ))}
      </div>

      {canEdit && sellUnits.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={save.isPending || changes.length === 0 || firstProblem !== null} onClick={() => { setSaved(false); save.mutate(); }}>
            {save.isPending ? 'Saving…' : `Save prices${changes.length ? ` (${changes.length})` : ''}`}
          </Button>
          {saved && changes.length === 0 && <span className="font-medium text-brand">Prices saved.</span>}
        </div>
      )}
      {save.isError && <ErrorText>{errorMessage(save.error)}</ErrorText>}
    </>
  );
}