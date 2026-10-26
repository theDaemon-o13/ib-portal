import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, authApi, type Me } from '../api/client';

export const ME_KEY = ['auth', 'me'] as const;

/** Текущий пользователь; null — не вошёл. */
export function useMe() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: async (): Promise<Me | null> => {
      try {
        return (await authApi.me()).user;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}

export function useSetMe() {
  const qc = useQueryClient();
  return (me: Me | null) => qc.setQueryData(ME_KEY, me);
}
