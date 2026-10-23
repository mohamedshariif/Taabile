import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorMessage, newIdempotencyKey } from '../api/client';
import type { Category, ProductDetail } from '../api/types';
import { Button, Card, Check, ErrorText, Field, FieldRow, Input, Muted, PageTitle, SectionTitle, Select } from '../components/ui';
import { emptyDraft, emptyUnit, hasProblems, toCreateBody, trimNumber, validateDraft, type DraftUnit, type ProductDraft } from '../lib/products';

// Creating a product: what it is, its base unit (the yardstick for stock), and any package sizes.
// Stock, costs and reports always use the base unit. A package only says "one of these = N base units".
export function ProductFormPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<ProductDraft>(emptyDraft);
  const [attempted, setAttempted] = useState(false);

  // One key per version of the form. Pressing Save twice (or retrying after a bad connection) can never create two
  // products. Changing anything makes a new key, because it is then a different request.
  const key = useRef(newIdempotencyKey());
  const edit = (fn: (d: ProductDraft) => ProductDraft) => {
    key.current = newIdempotencyKey();
    setDraft(fn);
  };
  const set = <K extends keyof ProductDraft>(k: K, v: ProductDraft[K]) => edit((d) => ({ ...d, [k]: v }));
  const setUnit = (i: number, patch: Partial<DraftUnit>) =>
    edit((d) => ({ ...d, units: d.units.map((u, j) => (j === i ? { ...u, ...patch } : u)) }));

  const categories = useQuery({ queryKey: ['categories'], queryFn: () => api<{ categories: Category[] }>('/categories') });
  const problems = validateDraft(draft);
  const show = attempted ? problems : { units: {} as typeof problems.units };

  const create = useMutation({
    mutationFn: () => api<{ product: ProductDetail }>('/products', { method: 'POST', body: toCreateBody(draft), idempotencyKey: key.current }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['products'] });
      void qc.invalidateQueries({ queryKey: ['categories'] });
      navigate(`/products/${r.product.id}`, { replace: true });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setAttempted(true);
    if (!hasProblems(problems)) create.mutate();
  };

  const base = draft.baseName.trim() || 'base unit';
  return (
    <>
      <p className="mb-2"><Link to="/products">← All products</Link></p>
      <PageTitle>New product</PageTitle>
      <form onSubmit={submit} noValidate>
        <Card>
          <SectionTitle first>The product</SectionTitle>
          <FieldRow>
            <Field label="Name" error={show.name}>
              <Input value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder="White sugar" maxLength={120} />
            </Field>
            <Field label="Product code (optional)" hint="Leave empty and Taabile makes one, like P-000001." error={show.sku}>
              <Input value={draft.sku} onChange={(e) => set('sku', e.target.value)} placeholder="SUGAR-W" maxLength={30} />
            </Field>
          </FieldRow>
          <Field label="Category (optional)">
            <Select value={draft.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
              <option value="">No category</option>
              {(categories.data?.categories ?? []).filter((c) => c.status === 'ACTIVE').map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
          </Field>
          <Check
            className="mt-3"
            label="Can be sold in parts (kg, litres, metres)"
            checked={draft.allowFractions}
            onChange={(e) => set('allowFractions', e.target.checked)}
          />
          <Muted small>Untick for things counted in whole pieces, such as bottles or tins. A carton of 12 bottles can still be sold by the half carton (6 bottles), but never half a bottle.</Muted>
        </Card>

        <Card>
          <SectionTitle first>Base unit</SectionTitle>
          <Muted small>The smallest unit you count. All stock, costs and reports use it, so choose carefully: it cannot change once the product has stock.</Muted>
          <FieldRow>
            <Field label="Base unit name" error={show.baseName}>
              <Input list="base-unit-names" value={draft.baseName} onChange={(e) => set('baseName', e.target.value)} placeholder="kg" maxLength={40} />
              <datalist id="base-unit-names">
                <option value="kg" />
                <option value="litre" />
                <option value="piece" />
                <option value="bottle" />
                <option value="tin" />
              </datalist>
            </Field>
            <Field label="Barcode on one base unit (optional)" error={show.baseBarcode}>
              <Input value={draft.baseBarcode} onChange={(e) => set('baseBarcode', e.target.value)} placeholder="e.g. a single bottle" inputMode="numeric" />
            </Field>
          </FieldRow>
        </Card>

        <Card>
          <SectionTitle first>Package sizes (optional)</SectionTitle>
          <Muted small>
            Sacks, cartons, bags… Enter how many {base} one package holds. You can add more sizes later, any time.
          </Muted>
          {draft.units.map((u, i) => {
            const p = show.units[i] ?? {};
            return (
              <fieldset key={i} className="my-3 rounded-lg border border-line p-3">
                <legend className="px-1 font-semibold">Package {i + 1}</legend>
                <FieldRow>
                  <Field label="Name" error={p.name}>
                    <Input value={u.name} onChange={(e) => setUnit(i, { name: e.target.value })} placeholder="Sack 50 kg" maxLength={40} />
                  </Field>
                  <Field label={`Holds how many ${base}?`} error={p.factor}>
                    <Input value={u.factor} onChange={(e) => setUnit(i, { factor: e.target.value })} placeholder="50" inputMode="decimal" />
                  </Field>
                  <Field label="Barcode (optional)" error={p.barcode}>
                    <Input value={u.barcode} onChange={(e) => setUnit(i, { barcode: e.target.value })} inputMode="numeric" />
                  </Field>
                </FieldRow>
                {u.name.trim() && u.factor.trim() && !p.factor && (
                  <p className="text-sm text-muted">1 {u.name.trim()} = {trimNumber(u.factor.trim())} {base}</p>
                )}
                <div className="flex flex-wrap items-center gap-x-6">
                  <Check label="Bought in this size" checked={u.isPurchaseUnit} onChange={(e) => setUnit(i, { isPurchaseUnit: e.target.checked })} />
                  <Check label="Sold in this size" checked={u.isSaleUnit} onChange={(e) => setUnit(i, { isSaleUnit: e.target.checked })} />
                  <Button small variant="ghost" className="ml-auto" onClick={() => edit((d) => ({ ...d, units: d.units.filter((_, j) => j !== i) }))}>
                    Remove
                  </Button>
                </div>
              </fieldset>
            );
          })}
          <Button variant="ghost" disabled={draft.units.length >= 20} onClick={() => edit((d) => ({ ...d, units: [...d.units, emptyUnit()] }))}>
            + Add a package size
          </Button>
        </Card>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={create.isPending}>{create.isPending ? 'Saving…' : 'Create product'}</Button>
          <Button variant="ghost" onClick={() => navigate('/products')}>Cancel</Button>
        </div>
        {attempted && hasProblems(problems) && <ErrorText>Some fields need your attention (marked in red above).</ErrorText>}
        {create.isError && <ErrorText>{errorMessage(create.error)}</ErrorText>}
        <Muted small className="mt-3">Prices are set on the next screen, after the product exists.</Muted>
      </form>
    </>
  );
}