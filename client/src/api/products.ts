import { useQuery } from '@tanstack/react-query';
import { api } from './client';

export type ProductCode = { id: number; code: string; imagePath: string | null };

/** Product codes in use (created at cutting) — for job issue / dispatch pickers. */
export function useProducts() {
  return useQuery({
    queryKey: ['products'],
    queryFn: () => api.get<{ items: ProductCode[] }>('/api/products'),
    staleTime: 60_000,
    select: (d) => d.items,
  });
}
