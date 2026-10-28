import { Button, Field, Input, Select } from '../../components/ui';
import { ProductPicker } from '../../components/ProductPicker';
import { trimNumber } from '../../lib/products';
import { lineBaseQty, lineProblems, newLine, type DraftLine } from '../../lib/stock';

// The product lines of an opening-stock, purchase, transfer or count form: pick a product, choose the unit, type quantity (and price).
export function LinesEditor({
  lines,
  onChange,
  priceLabel,
  priceHint,
  priceCheck,
  withDamaged,
  withPrice = true,
  qtyLabel = 'Quantity',
  allowZero = false,
  withReason = false,
}: {
  lines: DraftLine[];
  onChange: (next: DraftLine[]) => void;
  priceLabel: string;
  priceHint?: string;
  priceCheck: (t: string) => string | undefined;
  withDamaged?: boolean;
  withPrice?: boolean;
  qtyLabel?: string;
  allowZero?: boolean;
  withReason?: boolean;
}) {
  const update = (key: string, patch: Partial<DraftLine>) => onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  return (
    <div>
      <ul className="space-y-3">
        {lines.map((l) => {
          const p = lineProblems(l, priceCheck, allowZero);
          const base = lineBaseQty(l);
          const unit = l.product.units.find((u) => u.id === l.unitId);
          return (
            <li key={l.key} className="rounded-lg border border-line p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-semibold">{l.product.name}</div>
                  <div className="text-sm text-muted">{l.product.sku}</div>
                </div>
                <Button variant="link" className="min-h-9" onClick={() => onChange(lines.filter((x) => x.key !== l.key))}>Remove</Button>
              </div>
              <div className="mt-2 grid gap-3 sm:grid-cols-[repeat(auto-fit,minmax(9rem,1fr))]">
                <Field label="Unit">
                  <Select value={l.unitId} onChange={(e) => update(l.key, { unitId: e.target.value })}>
                    {l.product.units.filter((u) => u.status === 'ACTIVE').map((u) => (
                      <option key={u.id} value={u.id}>{u.name}{u.isBase ? '' : ` (${trimNumber(u.factor)} ${l.product.baseUnit})`}</option>
                    ))}
                  </Select>
                </Field>
                <Field label={qtyLabel} error={l.qty ? p.qty : undefined} hint={base > 0 && unit && !unit.isBase ? `= ${trimNumber(String(base))} ${l.product.baseUnit}` : undefined}>
                  <Input value={l.qty} onChange={(e) => update(l.key, { qty: e.target.value })} inputMode="decimal" />
                </Field>
                {withPrice && (
                  <Field label={priceLabel} error={l.price ? p.price : undefined} hint={priceHint}>
                    <Input value={l.price} onChange={(e) => update(l.key, { price: e.target.value })} inputMode="decimal" />
                  </Field>
                )}
                {withDamaged && (
                  <Field label="Damaged (optional)" error={p.damaged} hint="Not added to stock, not paid for.">
                    <Input value={l.damaged} onChange={(e) => update(l.key, { damaged: e.target.value })} inputMode="decimal" />
                  </Field>
                )}
              </div>
              {withReason && (
                <Field label="Why does it differ? (optional)" className="mt-3 block">
                  <Input value={l.reason} maxLength={200} onChange={(e) => update(l.key, { reason: e.target.value })} />
                </Field>
              )}
            </li>
          );
        })}
      </ul>
      <div className="mt-3">
        <ProductPicker exclude={lines.map((l) => l.product.id)} onPick={(p) => onChange([...lines, newLine(p)])} />
      </div>
    </div>
  );
}