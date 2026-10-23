import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../../api/client';
import type { Category, ProductDetail } from '../../api/types';
import { Button, Card, Check, ErrorText, Field, FieldRow, Input, Muted, SectionTitle, Select } from '../../components/ui';
import { useProductCache } from './useProductCache';

const SKU = /^[A-Z0-9][A-Z0-9._-]{0,29}$/;

// The product's own fields. Name, code, category and the "sold in parts" switch (turning it ON) can always change.
// The base unit and turning "parts" OFF are locked once the product has stock history, because that would change
// what old numbers mean. The server enforces this too; the screen just explains it.
export function DetailsSection({ product, canManage }: { product: ProductDetail; canManage: boolean }) {
  const apply = useProductCache(product.id);
  const categories = useQuery({ queryKey: ['categories'], queryFn: () => api<{ categories: Category[] }>('/categories') });

  const [name, setName] = useState(product.name);
  const [sku, setSku] = useState(product.sku);
  const [categoryId, setCategoryId] = useState(product.category?.id ?? '');
  const [baseName, setBaseName] = useState(product.baseUnit);
  const [parts, setParts] = useState(product.allowFractions);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setName(product.name);
    setSku(product.sku);
    setCategoryId(product.category?.id ?? '');
    setBaseName(product.baseUnit);
    setParts(product.allowFractions);
  }, [product]);

  const frozen = product.locks.baseUnitLocked;
  const body = {
    ...(name.trim() !== product.name ? { name: name.trim() } : {}),
    ...(sku.trim().toUpperCase() !== product.sku ? { sku: sku.trim().toUpperCase() } : {}),
    ...(categoryId !== (product.category?.id ?? '') ? { categoryId: categoryId || null } : {}),
    ...(!frozen && baseName.trim() !== product.baseUnit ? { baseUnitName: baseName.trim() } : {}),
    ...(parts !== product.allowFractions ? { allowFractions: parts } : {}),
  };
  const changed = Object.keys(body).length > 0;
  const problem =
    name.trim().length < 2 ? 'Enter a product name' :
    !SKU.test(sku.trim().toUpperCase()) ? 'The code can have up to 30 letters, numbers, . _ or -' :
    baseName.trim().length < 1 ? 'Enter the base unit' : null;

  const save = useMutation({
    mutationFn: () => api<{ product: ProductDetail }>(`/products/${product.id}`, { method: 'PATCH', body }),
    onSuccess: (r) => {
      apply(r);
      setSaved(true);
    },
  });

  // The category list can contain a switched-off category the product already has: keep showing it.
  const choices = (categories.data?.categories ?? []).filter((c) => c.status === 'ACTIVE' || c.id === product.category?.id);

  if (!canManage) {
    return (
      <Card>
        <SectionTitle first>Details</SectionTitle>
        <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[auto_1fr]">
          <dt className="text-muted">Code</dt><dd>{product.sku}</dd>
          <dt className="text-muted">Category</dt><dd>{product.category?.name ?? '—'}</dd>
          <dt className="text-muted">Base unit</dt><dd>{product.baseUnit}</dd>
          <dt className="text-muted">Sold in parts</dt><dd>{product.allowFractions ? 'Yes' : 'No, whole pieces only'}</dd>
        </dl>
      </Card>
    );
  }

  return (
    <Card as="form" onSubmit={(e) => { e.preventDefault(); setSaved(false); if (!problem && changed) save.mutate(); }}>
      <SectionTitle first>Details</SectionTitle>
      <FieldRow>
        <Field label="Name"><Input value={name} onChange={(e) => { setSaved(false); setName(e.target.value); }} maxLength={120} /></Field>
        <Field label="Product code"><Input value={sku} onChange={(e) => { setSaved(false); setSku(e.target.value); }} maxLength={30} /></Field>
        <Field label="Category">
          <Select value={categoryId} onChange={(e) => { setSaved(false); setCategoryId(e.target.value); }}>
            <option value="">No category</option>
            {choices.map((c) => <option key={c.id} value={c.id}>{c.name}{c.status === 'ACTIVE' ? '' : ' (switched off)'}</option>)}
          </Select>
        </Field>
      </FieldRow>

      <Field label="Base unit" hint={frozen ? 'Locked: this product already has stock history, so its base unit can no longer change.' : 'Can be renamed until the product has stock. Stock, costs and reports all use it.'} className="max-w-xs">
        <Input value={baseName} onChange={(e) => { setSaved(false); setBaseName(e.target.value); }} disabled={frozen} maxLength={40} />
      </Field>

      <Check
        className="mt-3"
        label="Can be sold in parts (kg, litres, metres)"
        checked={parts}
        disabled={frozen && product.allowFractions}
        onChange={(e) => { setSaved(false); setParts(e.target.checked); }}
      />
      <Muted small>
        {frozen && product.allowFractions
          ? 'Locked on: with stock history, switching to whole pieces could change old quantities. Allowing parts is always safe.'
          : 'Untick only for things counted in whole pieces, such as bottles or tins.'}
      </Muted>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={save.isPending || !changed || problem !== null}>{save.isPending ? 'Saving…' : 'Save details'}</Button>
        {saved && !changed && <span className="font-medium text-brand">Saved.</span>}
        {problem && changed && <span className="text-danger">{problem}</span>}
      </div>
      {save.isError && <ErrorText>{errorMessage(save.error)}</ErrorText>}
    </Card>
  );
}