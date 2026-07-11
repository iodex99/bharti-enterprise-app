import { useQuery } from '@tanstack/react-query';
import { api } from './client';

export type Health = { ok: boolean; version: string; uptimeSeconds: number; demoMode: boolean };

/** Public health poll — powers the DEMO MODE banner and the login-page hint. */
export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: () => api.get<Health>('/api/system/health'),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}
