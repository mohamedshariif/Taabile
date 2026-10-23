import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, errorMessage } from '../api/client';
import type { ProductDetail } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Badge, Button, Card, ErrorText, Muted, PageTitle, SectionTitle } from '../components/ui';
import { DetailsSection } from './product/DetailsSection';
import { PricesSection } from './product/PricesSection';
import { UnitsSection } from './product/UnitsSection';
import { useProductCache } from './product/useProductCache';

export function ProductDetailPage() {
  const { productId = '' } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const apply = useProductCache(productId);
  const canManage = can('products.manage');

  const detail = useQuery({ queryKey: ['product', productId], queryFn: () => api<{ product: ProductDetail }>(`/products/${productId}`) });

  const setStatus = useMutation({
    mutationFn: (status: 'ACTIVE' | 'INACTIVE') => api<{ product: ProductDetail }>(`/products/${productId}`, { method: 'PATCH', body: { status } }),
    onSuccess: apply,
  });
  const remove = useMutation({
    mutationFn: () => api(`/products/${productId}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.removeQueries({ queryKey: ['product', productId] });
      void qc.invalidateQueries({ queryKey: ['products'] });
      void qc.invalidateQueries({ queryKey: ['categories'] });
      navigate('/products', { replace: true });
    },
  });

  if (detail.isLoading) return <Muted>Loading…</Muted>;
  if (detail.isError || !detail.data) return <ErrorText>{errorMessage(detail.error)}</ErrorText>;
  const product = detail.data.product;
  const active = product.status === 'ACTIVE';

  return (
    <>
      <p className="mb-2"><Link to="/products">← All products</Link></p>
      <PageTitle>{product.name}</PageTitle>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted">
        <code>{product.sku}</code> · {product.category?.name ?? 'No category'} · <Badge tone={active ? 'ok' : 'off'}>{active ? 'Active' : 'Switched off'}</Badge>
      </p>

      <DetailsSection product={product} canManage={canManage} />
      <UnitsSection product={product} canManage={canManage} />
      <PricesSection product={product} canEdit={can('prices.manage')} />

      {canManage && (
        <Card className="mt-8">
          <SectionTitle first>{active ? 'Switch off this product' : 'Switch this product back on'}</SectionTitle>
          <Muted small className="mb-3">
            {active
              ? 'A switched-off product cannot be chosen on new sales or purchases, but all its history and reports stay.'
              : 'It will appear again when choosing products.'}
          </Muted>
          <Button variant="ghost" disabled={setStatus.isPending} onClick={() => setStatus.mutate(active ? 'INACTIVE' : 'ACTIVE')}>
            {active ? 'Switch off' : 'Switch on'}
          </Button>
          {setStatus.isError && <ErrorText>{errorMessage(setStatus.error)}</ErrorText>}
        </Card>
      )}

      {can('records.delete') && (
        <Card className="border-danger">
          <SectionTitle first className="text-danger">Delete this product</SectionTitle>
          <Muted small className="mb-3">
            Only for a product created by mistake that has never been used. If it has stock, purchases, sales or any other history, deleting is refused
            and you should switch it off instead. This cannot be undone.
          </Muted>
          <Button
            variant="danger"
            disabled={remove.isPending}
            onClick={() => {
              if (window.confirm(`Permanently delete "${product.name}"? This cannot be undone.`)) remove.mutate();
            }}
          >
            {remove.isPending ? 'Deleting…' : 'Delete product'}
          </Button>
          {remove.isError && <ErrorText>{errorMessage(remove.error)}</ErrorText>}
        </Card>
      )}
    </>
  );
}