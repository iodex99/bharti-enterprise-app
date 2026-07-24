import { useQuery } from '@tanstack/react-query';
import { api } from './client';

export type MasterOption = { id: number; [key: string]: unknown };

/** Active rows of a master, for select dropdowns on transaction forms. */
export function useMasterOptions(master: string) {
  return useQuery({
    queryKey: ['masters', master, false],
    queryFn: () => api.get<{ items: MasterOption[] }>(`/api/masters/${master}`),
    staleTime: 60_000,
    select: (d) => d.items,
  });
}

export function optionLabel(master: string, o: MasterOption): string {
  switch (master) {
    case 'sizes':
      return o.code as string;
    default:
      return (o.name as string) ?? String(o.id);
  }
}
