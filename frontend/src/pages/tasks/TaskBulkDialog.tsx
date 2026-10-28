import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { tasksApi, tkeys, type TaskBulkPreview } from '../../api/tasks';
import { Overlay } from '../../components/Overlay';
import { useToast } from '../../components/Toast';

/** Выбранные на доске задачи: в архив или удалить (мягко). Предпросмотр → подтверждение (ADR-0016). */
export function TaskBulkDialog({ action, ids, onClose, onDone }: {
  action: 'archive' | 'delete'; ids: string[]; onClose: () => void; onDone: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [preview, setPreview] = useState<TaskBulkPreview | null>(null);
  const [changed, setChanged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    tasksApi.bulkPreview(action, ids).then((p) => { if (live) setPreview(p); }, (e: unknown) => { if (live) setError(e instanceof Error ? e.message : 'Не удалось посчитать'); });
    return () => { live = false; };
  }, [action, ids]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const r = await tasksApi.bulkApply(action, ids, { total: preview.total, affected: preview.affected });
      void qc.invalidateQueries({ queryKey: tkeys.all });
      toast(action === 'archive' ? `В архив: ${r.archived}` : `Удалено задач: ${r.deleted}`);
      onDone();
    } catch (err) {
      const fresh = err instanceof ApiError && err.code === 'BULK_CHANGED' ? (err.details?.preview as TaskBulkPreview | undefined) : undefined;
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

  return (
    <Overlay>
      <div className="backdrop" role="presentation">
        <form className="modal panel bulk-dialog" role="dialog" aria-modal="true" aria-labelledby="tb-title" onSubmit={(e) => void submit(e)}>
          <h2 id="tb-title">{action === 'archive' ? 'Архивировать выбранные' : 'Удалить выбранные'}</h2>
          {!preview && !error && <p className="hint">Считаем…</p>}
          {preview && (
            <div data-testid="task-bulk-preview">
              <b>{action === 'archive' ? `Уйдёт в архив: ${preview.affected}` : `Будет удалено: ${preview.affected}`}</b>
              {preview.alreadyInState > 0 && <div className="hint">Уже в архиве: {preview.alreadyInState}</div>}
              <div className="hint">{preview.byStatus.map((s) => `${s.label} — ${s.count}`).join(', ')}</div>
              {action === 'delete' && <div className="hint">Удаление мягкое: в журнале остаётся запись о каждой задаче.</div>}
            </div>
          )}
          {changed && <div className="note" role="status">Задачи изменились, пока окно было открыто. Проверьте числа и подтвердите ещё раз.</div>}
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="row end">
            <button className="btn" type="button" onClick={onClose} disabled={busy}>Отмена</button>
            <button className={action === 'delete' ? 'btn danger' : 'btn primary'} type="submit" disabled={!preview || !preview.affected || busy}>
              {busy ? 'Выполняется…' : action === 'archive' ? 'Архивировать' : 'Удалить'}
            </button>
          </div>
        </form>
      </div>
    </Overlay>
  );
}
