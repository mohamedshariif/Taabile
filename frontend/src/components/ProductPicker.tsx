import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api/client';
import type { ProductPage, ProductSummary } from '../api/types';
import { Button, ErrorText, Field, Input, Muted } from './ui';

// Type a name or code, tap the product. Shows the first matches only; the search narrows them.
export function ProductPicker({ onPick, label = 'Add a product', exclude = [] }: { onPick: (p: ProductSummary) => void; label?: string; exclude?: string[] }) {
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setSearch(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);

  const found = useQuery({
    queryKey: ['product-picker', search],
    queryFn: () => api<ProductPage>(`/products?status=ACTIVE&limit=8${search ? `&search=${encodeURIComponent(search)}` : ''}`),
  });
  const items = (found.data?.items ?? []).filter((p) => !exclude.includes(p.id));

  return (
    <div className="rounded-lg border border-line p-3">
      <Field label={label}>
        <Input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Type a name or code" autoComplete="off" />
      </Field>
      {found.isError && <ErrorText>{errorMessage(found.error)}</ErrorText>}
      {found.isLoading && <Muted small className="mt-2">Loading…</Muted>}
      {found.data && items.length === 0 && <Muted small className="mt-2">{search ? 'No product matches.' : 'No products to add.'}</Muted>}
      <ul className="mt-2 grid gap-2 sm:grid-cols-2">
        {items.map((p) => (
          <li key={p.id}>
            <Button variant="choice" onClick={() => onPick(p)}>
              <span>
                <span className="font-semibold">{p.name}</span>
                <span className="block text-sm font-normal text-muted">{p.sku} · {p.baseUnit}</span>
              </span>
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}