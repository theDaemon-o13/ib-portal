import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { registersApi, type BulkPreview, type BulkResult, type BulkSelection, type RegisterDetail } from '../../api/registers';
import { Overlay } from '../../components/Overlay';
import { previewLines, reasonLines, records, resultSummary } from './bulk';
import { rkeys } from './keys';

export type BulkMode = 'archive' | 'restore' | 'delete' | 'delete-all';

const TITLES: Record<BulkMode, string> = {
  archive: 'Архивировать выбранные',
  restore: 'Вернуть выбранные из архива',
  delete: 'Удалить выбранные',
  'delete-all': 'Удалить все записи',
};
const BUTTONS: Record<BulkMode, string> = { archive: 'Архивировать', restore: 'Вернуть', delete: 'Удалить', 'delete-all': 'Удалить все записи' };

/**
 * Массовое действие в два шага (ADR-0016): сначала сервер считает, что произойдёт, затем применяет
 * с теми же числами. Если записи успели измениться, сервер отвечает 409 с новыми числами — окно их
 * показывает и просит подтвердить ещё раз. «Удалить все записи» подтверждается вводом названия реестра.
 */
export function BulkDialog({ reg, mode, selection, onClose, onDone }: {
  reg: RegisterDetail; mode: BulkMode; selection: BulkSelection | null; onClose: () => void; onDone: () => void;
}) {
  const qc = useQueryClient();
  const [preview, setPreview] = useState<BulkPreview | null>(null);
  const [changed, setChanged] = useState(false);
  const [result, setResult] = useState<BulkResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const action = mode === 'delete-all' ? 'delete' : mode;

  useEffect(() => {
    let live = true;
    const load = mode === 'delete-all'
      ? registersApi.deleteAllPreview(reg.id)
      : mode === 'delete'
        ? registersApi.bulkDeletePreview(reg.id, selection ?? { ids: [] })
        : registersApi.bulkArchivePreview(reg.id, mode, selection ?? { ids: [] });
    load.then((p) => { if (live) setPreview(p); }, (e: unknown) => { if (live) setError(e instanceof Error ? e.message : 'Не удалось посчитать'); });
    return () => { live = false; };
  }, [reg.id, mode, selection]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || busy) return;
      if (result) finish();
      else onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const finish = () => {
    void qc.invalidateQueries({ queryKey: rkeys.records(reg.id) });
    void qc.invalidateQueries({ queryKey: rkeys.analytics(reg.id) });
    void qc.invalidateQueries({ queryKey: rkeys.list });
    onDone();
  };

  const apply = async (e: FormEvent) => {
    e.preventDefault();
    if (!preview) return;
    const expected = { total: preview.total, willDelete: preview.willDelete, willArchive: preview.willArchive, willRestore: preview.willRestore };
    setBusy(true);
    setError(null);
    try {
      const r = mode === 'delete-all'
        ? await registersApi.deleteAllApply(reg.id, confirmName, expected)
        : mode === 'delete'
          ? await registersApi.bulkDeleteApply(reg.id, selection ?? { ids: [] }, expected)
          : await registersApi.bulkArchiveApply(reg.id, mode, selection ?? { ids: [] }, expected);
      setResult(r);
    } catch (err) {
      const fresh = err instanceof ApiError && err.code === 'BULK_CHANGED' ? (err.details?.preview as BulkPreview | undefined) : undefined;
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

  const nothing = !!preview && preview.willDelete + preview.willArchive + preview.willRestore === 0;
  const nameOk = mode !== 'delete-all' || confirmName.trim() === reg.name.trim();
  const summary = result ? resultSummary(result) : null;
  const why = result ? reasonLines(result.byReason) : preview && action === 'delete' ? reasonLines(preview.byReason) : [];

  return (
    <Overlay>
      <div className="backdrop" role="presentation">
        <form className="modal panel bulk-dialog" role="dialog" aria-modal="true" aria-labelledby="bulk-title" onSubmit={(e) => void apply(e)}>
          <h2 id="bulk-title">{result ? 'Готово' : TITLES[mode]}</h2>
          {result && summary ? (
            <>
              <p className="bulk-result" data-testid="bulk-result">{summary.title}</p>
              {why.length > 0 && (
                <div className="hint">Не удалены — есть зависимости: {why.join(', ')}</div>
              )}
              {summary.hint && <div className="note">{summary.hint}</div>}
              <div className="row end"><button className="btn primary" type="button" onClick={finish} autoFocus>Готово</button></div>
            </>
          ) : (
            <>
              {mode === 'delete-all' && (
                <p>Все записи реестра «{reg.name}», включая архивные{preview ? `: ${records(preview.total)}` : ''}. Удаление мягкое — в журнале остаётся снимок каждой записи.</p>
              )}
              {!preview && !error && <p className="hint">Считаем…</p>}
              {changed && <div className="note" role="status">Записи изменились, пока окно было открыто. Проверьте новые числа и подтвердите ещё раз.</div>}
              {preview && (
                <ul className="bulk-lines" data-testid="bulk-preview">
                  {previewLines(action, preview).map((l) => <li key={l}>{l}</li>)}
                </ul>
              )}
              {preview && why.length > 0 && <div className="hint">Зависимости: {why.join(', ')}. Такие записи не удаляются, а уходят в архив.</div>}
              {mode === 'delete-all' && preview && preview.total > 0 && (
                <label>Чтобы подтвердить, введите название реестра
                  <input className="inp" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={reg.name} autoFocus aria-label="Название реестра" />
                </label>
              )}
              {error && <p className="form-error" role="alert">{error}</p>}
              <div className="row end">
                <button className="btn" type="button" onClick={onClose} disabled={busy}>Отмена</button>
                <button className={action === 'delete' ? 'btn danger' : 'btn primary'} type="submit" disabled={!preview || nothing || !nameOk || busy}>
                  {busy ? 'Выполняется…' : BUTTONS[mode]}
                </button>
              </div>
            </>
          )}
        </form>
      </div>
    </Overlay>
  );
}
