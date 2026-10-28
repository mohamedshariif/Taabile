import { useQuery } from '@tanstack/react-query';
import { useRef } from 'react';
import { api, newIdempotencyKey } from '../../api/client';
import type { Location } from '../../api/types';
import { useMe } from '../../auth/AuthContext';

/** All locations, and the ones this person may act in for a permission (their own, unless the scope is the whole company). */
export function useLocations(permission?: string) {
  const me = useMe();
  const q = useQuery({ queryKey: ['locations'], queryFn: () => api<{ locations: Location[] }>('/locations') });
  const all = q.data?.locations ?? [];
  const scope = permission ? me.permissions[permission] : 'company';
  const usable = all.filter((l) => l.status === 'ACTIVE' && (scope === 'company' || me.locationIds.includes(l.id)));
  return { all, usable, isLoading: q.isLoading, isError: q.isError, error: q.error };
}

/**
 * One Idempotency-Key per distinct request body: pressing Save again after a network failure re-sends the SAME key
 * (so nothing can be saved twice), while changing the form gives a fresh key.
 */
export function useIdempotencyKey() {
  const last = useRef<{ body: string; key: string } | null>(null);
  return (body: unknown): string => {
    const s = JSON.stringify(body);
    if (!last.current || last.current.body !== s) last.current = { body: s, key: newIdempotencyKey() };
    return last.current.key;
  };
}