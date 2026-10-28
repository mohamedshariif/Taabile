import { useQueryClient } from '@tanstack/react-query';
import type { ProductDetail } from '../../api/types';

/** Every product change answers with the whole updated product. Put it straight into the cache and refresh the lists. */
export function useProductCache(productId: string) {
  const qc = useQueryClient();
  return (r: { product: ProductDetail }) => {
    qc.setQueryData(['product', productId], r);
    void qc.invalidateQueries({ queryKey: ['products'] });
    void qc.invalidateQueries({ queryKey: ['categories'] });
  };
}