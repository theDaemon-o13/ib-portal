import { useMutation, useQueryClient } from '@tanstack/react-query';
import { akeys, type Assessment } from '../../api/assessments';
import { ApiError } from '../../api/client';
import { useToast } from '../../components/Toast';

/** Действие над оценкой: ответ сервера кладётся в кэш, список перечитывается; ошибка — понятным текстом. */
export function useAssessmentAction<A>(fn: (args: A) => Promise<Assessment>, success?: (a: Assessment) => string, onDone?: (a: Assessment) => void) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (a) => {
      // Окно закрывается вместе с новым статусом на экране, а не после перечитывания списка: иначе статус уже
      // сменился, а фон окна ещё перекрывает страницу и глотает щелчки (так падал e2e «журнал оценки»).
      qc.setQueryData(akeys.one(a.id), a);
      onDone?.(a);
      if (success) toast(success(a));
      await qc.invalidateQueries({ queryKey: akeys.all });
    },
    onError: async (err) => {
      if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') {
        await qc.invalidateQueries({ queryKey: akeys.all });
        toast('Оценка уже изменилась. Обновили — проверьте и повторите', 'error');
        return;
      }
      toast(err instanceof Error ? err.message : 'Не удалось выполнить действие', 'error');
    },
  });
}
