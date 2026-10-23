import { useMutation } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { api, errorMessage, newIdempotencyKey } from '../../api/client';
import type { ProductDetail, ProductUnit } from '../../api/types';
import { Badge, Button, Card, Check, DataTable, ErrorText, Field, FieldRow, Input, Muted, SectionTitle, type Column } from '../../components/ui';
import { describeUnit, trimNumber, unitProblems } from '../../lib/products';
import { useProductCache } from './useProductCache';

// Units: the base unit plus package sizes. A package's conversion (how many base units it holds) is what turns
// "3 sacks" into 150 kg for stock and costs, so it is protected: once a package has been used on a purchase or
// a sale its conversion is locked. If it was wrong, switch it off and add a correct one: old documents keep
// their meaning, and the wrong package can no longer be picked.
export function UnitsSection({ product, canManage }: { product: ProductDetail; canManage: boolean }) {
  const apply = useProductCache(product.id);
  const used = new Set(product.locks.usedUnitIds);
  const [editingId, setEditingId] = useState<string | null>(null);

  const setStatus = useMutation({
    mutationFn: (v: { id: string; status: 'ACTIVE' | 'INACTIVE' }) =>
      api<{ product: ProductDetail }>(`/products/${product.id}/units/${v.id}`, { method: 'PATCH', body: { status: v.status } }),
    onSuccess: apply,
  });

  const columns: Column<ProductUnit>[] = [
    {
      header: 'Unit',
      primary: true,
      cell: (u) => (
        <span className="flex flex-wrap items-center gap-2">
          {u.name}
          {u.isBase && <Badge tone="ok">base</Badge>}
          {used.has(u.id) && <Badge tone="wait">used</Badge>}
        </span>
      ),
    },
    { header: 'Holds', cell: (u) => (u.isBase ? 'the base unit' : `${trimNumber(u.factor)} ${product.baseUnit}`) },
    { header: 'Barcode', cell: (u) => (u.barcode ? <code>{u.barcode}</code> : '—') },
    { header: 'Used for', cell: (u) => [u.isPurchaseUnit && 'Buying', u.isSaleUnit && 'Selling'].filter(Boolean).join(' and ') || '—' },
    { header: 'Status', cell: (u) => <Badge tone={u.status === 'ACTIVE' ? 'ok' : 'off'}>{u.status === 'ACTIVE' ? 'Active' : 'Switched off'}</Badge> },
  ];
  if (canManage) {
    columns.push({
      header: '',
      actions: true,
      cell: (u) => (
        <>
          <Button small variant="ghost" onClick={() => setEditingId(u.id)}>Edit</Button>
          {!u.isBase && (
            <Button small variant="ghost" disabled={setStatus.isPending} onClick={() => setStatus.mutate({ id: u.id, status: u.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' })}>
              {u.status === 'ACTIVE' ? 'Switch off' : 'Switch on'}
            </Button>
          )}
        </>
      ),
    });
  }

  const editing = product.units.find((u) => u.id === editingId);
  return (
    <>
      <SectionTitle>Units and packages</SectionTitle>
      <Muted small>
        Stock is always counted in {product.baseUnit}. A package only says how many {product.baseUnit} it holds.
      </Muted>
      <DataTable rows={product.units} columns={columns} rowKey={(u) => u.id} dim={(u) => u.status !== 'ACTIVE'} />
      {setStatus.isError && <ErrorText>{errorMessage(setStatus.error)}</ErrorText>}

      {editing && canManage && (
        <EditUnitCard key={editing.id} product={product} unit={editing} locked={used.has(editing.id)} onClose={() => setEditingId(null)} />
      )}
      {canManage && <AddUnitCard product={product} />}
    </>
  );
}

function EditUnitCard({ product, unit, locked, onClose }: { product: ProductDetail; unit: ProductUnit; locked: boolean; onClose: () => void }) {
  const apply = useProductCache(product.id);
  const [name, setName] = useState(unit.name);
  const [factor, setFactor] = useState(trimNumber(unit.factor));
  const [barcode, setBarcode] = useState(unit.barcode ?? '');
  const [buy, setBuy] = useState(unit.isPurchaseUnit);
  const [sell, setSell] = useState(unit.isSaleUnit);

  const factorLocked = unit.isBase || locked;
  const others = product.units.filter((u) => u.id !== unit.id).map((u) => ({ name: u.name, barcode: u.barcode }));
  // The base unit's name and conversion are not editable here, so we check only what can change.
  const p = unitProblems({ name: unit.isBase ? unit.name : name, factor: factorLocked ? unit.factor : factor, barcode }, others, product.allowFractions);
  const hasProblem = Boolean(p.name || p.factor || p.barcode);

  const body = {
    ...(!unit.isBase && name.trim() !== unit.name ? { name: name.trim() } : {}),
    ...(!factorLocked && factor.trim() !== trimNumber(unit.factor) ? { factor: factor.trim() } : {}),
    ...(barcode.trim() !== (unit.barcode ?? '') ? { barcode: barcode.trim() || null } : {}),
    ...(!unit.isBase && buy !== unit.isPurchaseUnit ? { isPurchaseUnit: buy } : {}),
    ...(!unit.isBase && sell !== unit.isSaleUnit ? { isSaleUnit: sell } : {}),
  };
  const changed = Object.keys(body).length > 0;

  const save = useMutation({
    mutationFn: () => api<{ product: ProductDetail }>(`/products/${product.id}/units/${unit.id}`, { method: 'PATCH', body }),
    onSuccess: (r) => {
      apply(r);
      onClose();
    },
  });

  return (
    <Card as="form" className="border-brand" onSubmit={(e: FormEvent) => { e.preventDefault(); if (!hasProblem && changed) save.mutate(); }}>
      <SectionTitle first>Edit "{unit.name}"</SectionTitle>
      <FieldRow>
        <Field label="Name" error={p.name}><Input value={name} onChange={(e) => setName(e.target.value)} disabled={unit.isBase} maxLength={40} /></Field>
        <Field label={`Holds how many ${product.baseUnit}?`} error={p.factor}>
          <Input value={factor} onChange={(e) => setFactor(e.target.value)} disabled={factorLocked} inputMode="decimal" />
        </Field>
        <Field label="Barcode" error={p.barcode}><Input value={barcode} onChange={(e) => setBarcode(e.target.value)} inputMode="numeric" /></Field>
      </FieldRow>
      {unit.isBase && <Muted small>The base unit is the yardstick: its name changes in the Details card (before stock exists) and it always holds exactly 1.</Muted>}
      {locked && !unit.isBase && (
        <p className="my-2 rounded-lg border border-warn p-3 text-sm">
          This package has already been used on purchases or sales, so its conversion is locked: changing it would change what old documents mean.
          If it is wrong, close this, switch it off, and add a new package with the right number. Name, barcode and where it is used can still change.
        </p>
      )}
      {!unit.isBase && (
        <div className="flex flex-wrap gap-x-6">
          <Check label="Bought in this size" checked={buy} onChange={(e) => setBuy(e.target.checked)} />
          <Check label="Sold in this size" checked={sell} onChange={(e) => setSell(e.target.checked)} />
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-3">
        <Button type="submit" disabled={save.isPending || !changed || hasProblem}>{save.isPending ? 'Saving…' : 'Save'}</Button>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
      </div>
      {save.isError && <ErrorText>{errorMessage(save.error)}</ErrorText>}
    </Card>
  );
}

function AddUnitCard({ product }: { product: ProductDetail }) {
  const apply = useProductCache(product.id);
  const [name, setName] = useState('');
  const [factor, setFactor] = useState('');
  const [barcode, setBarcode] = useState('');
  const [buy, setBuy] = useState(true);
  const [sell, setSell] = useState(true);
  const [attempted, setAttempted] = useState(false);

  // New key whenever the form changes (it is then a different request); the same key on a retry of the same press.
  const key = useRef(newIdempotencyKey());
  const touch = <T,>(setter: (v: T) => void) => (v: T) => {
    key.current = newIdempotencyKey();
    setter(v);
  };

  const p = unitProblems({ name, factor, barcode }, product.units.map((u) => ({ name: u.name, barcode: u.barcode })), product.allowFractions);
  const hasProblem = Boolean(p.name || p.factor || p.barcode);

  const add = useMutation({
    mutationFn: () =>
      api<{ product: ProductDetail }>(`/products/${product.id}/units`, {
        method: 'POST',
        idempotencyKey: key.current,
        body: { name: name.trim(), factor: factor.trim(), isPurchaseUnit: buy, isSaleUnit: sell, ...(barcode.trim() ? { barcode: barcode.trim() } : {}) },
      }),
    onSuccess: (r) => {
      apply(r);
      setName('');
      setFactor('');
      setBarcode('');
      setAttempted(false);
      key.current = newIdempotencyKey();
    },
  });

  return (
    <Card as="form" onSubmit={(e: FormEvent) => { e.preventDefault(); setAttempted(true); if (!hasProblem) add.mutate(); }}>
      <SectionTitle first>Add a package size</SectionTitle>
      <FieldRow>
        <Field label="Name" error={attempted ? p.name : undefined}><Input value={name} onChange={(e) => touch(setName)(e.target.value)} placeholder="Sack 30 kg" maxLength={40} /></Field>
        <Field label={`Holds how many ${product.baseUnit}?`} error={attempted ? p.factor : undefined}>
          <Input value={factor} onChange={(e) => touch(setFactor)(e.target.value)} placeholder="30" inputMode="decimal" />
        </Field>
        <Field label="Barcode (optional)" error={attempted ? p.barcode : undefined}><Input value={barcode} onChange={(e) => touch(setBarcode)(e.target.value)} inputMode="numeric" /></Field>
      </FieldRow>
      {name.trim() && factor.trim() && !p.factor && (
        <p className="text-sm text-muted">{describeUnit({ name: name.trim(), factor: factor.trim(), isBase: false }, product.baseUnit)}</p>
      )}
      <div className="flex flex-wrap gap-x-6">
        <Check label="Bought in this size" checked={buy} onChange={(e) => touch(setBuy)(e.target.checked)} />
        <Check label="Sold in this size" checked={sell} onChange={(e) => touch(setSell)(e.target.checked)} />
      </div>
      <Button type="submit" className="mt-3" disabled={add.isPending}>{add.isPending ? 'Adding…' : 'Add package size'}</Button>
      {add.isError && <ErrorText>{errorMessage(add.error)}</ErrorText>}
    </Card>
  );
}