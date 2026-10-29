import { useQuery, useQueryClient } from '@tanstack/react-query';
import { markExpired } from './session';
import { ApiError, authApi, type Me } from '../api/client';

export const ME_KEY = ['auth', 'me'] as const;

/** Текущий пользователь; null — не вошёл. */
export function useMe() {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ME_KEY,
    queryFn: async (): Promise<Me | null> => {
      try {
        return (await authApi.me()).user;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          // Был вошедший пользователь — сессия завершилась посреди работы.
          if (qc.getQueryData(ME_KEY)) markExpired();
          return null;
        }
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
