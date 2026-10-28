import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { registersApi, type AutomationRule, type RuleTasksPreview, type RuleTasksResult } from '../../api/registers';
import { Overlay } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { rkeys } from './keys';

type Choice = 'keep' | 'archive' | 'delete';

/**
 * Архив или удаление правила (релиз 1.1.0): «Задачи, созданные им (N): оставить / архивировать / удалить»,
 * по умолчанию — оставить; разбивка по статусам и «только нетронутые» (без комментариев и правок людей).
 * Числа предпросмотра уходят на сервер; если задачи успели измениться — новые числа и повторное подтверждение.
 */
export function RuleTasksDialog({ registerId, rule, mode, canDeleteTasks, onClose }: {
  registerId: string; rule: AutomationRule; mode: 'archive' | 'delete'; canDeleteTasks: boolean; onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [choice, setChoice] = useState<Choice>('keep');
  const [onlyUntouched, setOnlyUntouched] = useState(false);
  const [preview, setPreview] = useState<RuleTasksPreview | null>(null);
  const [changed, setChanged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const action = choice === 'delete' ? 'delete' : 'archive';

  useEffect(() => {
    let live = true;
    setPreview(null);
    registersApi.ruleTasksPreview(rule.id, action, choice !== 'keep' && onlyUntouched)
      .then((p) => { if (live) setPreview(p); }, (e: unknown) => { if (live) setError(e instanceof Error ? e.message : 'Не удалось посчитать задачи'); });
    return () => { live = false; };
  }, [rule.id, action, choice, onlyUntouched]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!preview) return;
    const tasks = choice === 'keep'
      ? { action: 'keep' as const }
      : { action: choice, onlyUntouched, expected: { total: preview.total, affected: preview.affected } };
    setBusy(true);
    setError(null);
    try {
      let result: RuleTasksResult;
      if (mode === 'delete') result = (await registersApi.deleteRule(rule.id, rule.version, tasks)).tasks;
      else result = (await registersApi.archiveRule(rule.id, rule.version, tasks)).tasks;
      void qc.invalidateQueries({ queryKey: rkeys.rules(registerId) });
      void qc.invalidateQueries({ queryKey: rkeys.records(registerId) });
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      const what = mode === 'delete' ? 'Правило удалено' : 'Правило в архиве';
      toast(result ? `${what}. Задач: ${result.archived ? `в архив ${result.archived}` : `удалено ${result.deleted}`}` : `${what}, задачи остались`);
      onClose();
    } catch (err) {
      const fresh = err instanceof ApiError && err.code === 'BULK_CHANGED' ? (err.details?.preview as RuleTasksPreview | undefined) : undefined;
      if (fresh) {
        setPreview(fresh);
        setChanged(true);
      } else {
        setError(err instanceof Error ? err.message : 'Не удалось выполнить');
      }
    } finally {
      setBusy(false);
    }
  };

  const total = preview?.total ?? 0;
  return (
    <Overlay>
      <div className="backdrop" role="presentation">
        <form className="modal panel bulk-dialog" role="dialog" aria-modal="true" aria-labelledby="rt-title" onSubmit={(e) => void submit(e)}>
          <h2 id="rt-title">{mode === 'delete' ? 'Удалить правило' : 'Правило в архив'}</h2>
          <p className="hint">«{rule.when} → {rule.then}». {mode === 'delete' ? 'Правило исчезнет из списка; события сохранятся в журнале.' : 'Правило перестанет создавать задачи; вернуть его можно из архива.'}</p>
          {!preview && !error && <p className="hint">Считаем задачи…</p>}
          {preview && (
            <>
              <div data-testid="rule-tasks">
                <b>Задачи, созданные им: {total}</b>
                {preview.byStatus.length > 0 && <div className="hint">{preview.byStatus.map((s) => `${s.label} — ${s.count}`).join(', ')}; нетронутых — {preview.untouched}</div>}
              </div>
              {total > 0 && (
                <div className="grid-gap" role="radiogroup" aria-label="Что сделать с задачами">
                  <label className="check"><input type="radio" name="rt" checked={choice === 'keep'} onChange={() => setChoice('keep')} /> Оставить как есть</label>
                  <label className="check"><input type="radio" name="rt" checked={choice === 'archive'} onChange={() => setChoice('archive')} /> Отправить в архив</label>
                  <label className="check" title={canDeleteTasks ? undefined : 'Нет права «Задачи: удаление»'}>
                    <input type="radio" name="rt" checked={choice === 'delete'} disabled={!canDeleteTasks} onChange={() => setChoice('delete')} /> Удалить
                  </label>
                  {choice !== 'keep' && (
                    <label className="check"><input type="checkbox" checked={onlyUntouched} onChange={(e) => setOnlyUntouched(e.target.checked)} /> Только нетронутые — без комментариев и правок сотрудников</label>
                  )}
                  {choice !== 'keep' && <div className="hint" data-testid="rule-tasks-affected">Затронет задач: {preview.affected}{preview.alreadyInState ? ` (уже в архиве — ${preview.alreadyInState})` : ''}</div>}
                </div>
              )}
            </>
          )}
          {changed && <div className="note" role="status">Задачи изменились, пока окно было открыто. Проверьте числа и подтвердите ещё раз.</div>}
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="row end">
            <button className="btn" type="button" onClick={onClose} disabled={busy}>Отмена</button>
            <button className={mode === 'delete' ? 'btn danger' : 'btn primary'} type="submit" disabled={!preview || busy}>
              {busy ? 'Выполняется…' : mode === 'delete' ? 'Удалить правило' : 'В архив'}
            </button>
          </div>
        </form>
      </div>
    </Overlay>
  );
}
