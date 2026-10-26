import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { useToast } from '../../components/Toast';

/**
 * Действие в настройках: после успеха — уведомление и перечитывание данных,
 * при ошибке — понятный текст с сервера. Если запись успела измениться (409 VERSION_CONFLICT),
 * данные перечитываются, чтобы пользователь увидел актуальное состояние.
 */
export function useAction<A, R>(
  fn: (args: A) => Promise<R>,
  opts: { invalidate: QueryKey[]; success?: (result: R, args: A) => string | null; onDone?: (result: R) => void },
) {
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = () => Promise.all(opts.invalidate.map((queryKey) => qc.invalidateQueries({ queryKey })));
  return useMutation({
    mutationFn: fn,
    onSuccess: async (result, args) => {
      await refresh();
      const text = opts.success?.(result, args);
      if (text) toast(text);
      opts.onDone?.(result);
    },
    onError: async (err) => {
      if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') {
        await refresh();
        toast('Данные изменил другой пользователь. Обновили — проверьте и повторите', 'error');
        return;
      }
      toast(err instanceof Error ? err.message : 'Не удалось выполнить действие', 'error');
    },
  });
}

export const keys = {
  catalogs: ['settings', 'catalogs'] as const,
  items: (code: string) => ['settings', 'items', code] as const,
  allItems: ['settings', 'items'] as const,
  week: ['settings', 'week'] as const,
  days: (year: number) => ['settings', 'days', year] as const,
  templates: ['settings', 'templates'] as const,
  users: ['settings', 'users'] as const,
  userOptions: ['settings', 'userOptions'] as const,
  roles: ['settings', 'roles'] as const,
  permissions: ['settings', 'permissions'] as const,
  journal: ['settings', 'journal'] as const,
};
