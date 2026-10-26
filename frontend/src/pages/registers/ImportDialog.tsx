import { Overlay } from '../../components/Overlay';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { registersApi, type ImportPreview, type RegisterDetail } from '../../api/registers';
import { useToast } from '../../components/Toast';
import { rkeys } from './keys';

/** Импорт Excel, шаг 1 → 2: предпросмотр (ничего не изменено), затем применение одной транзакцией. */
export function ImportDialog({ reg, preview, onClose }: { reg: RegisterDetail; preview: ImportPreview; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const s = preview.summary;
  const nothing = s.added + s.updated === 0;

  const apply = useMutation({
    mutationFn: () => registersApi.applyImport(preview.id),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: rkeys.records(reg.id) });
      await qc.invalidateQueries({ queryKey: rkeys.list });
      toast(`Импорт применён: добавлено ${r.added}, изменено ${r.updated}${r.skipped ? `, пропущено строк с ошибками ${r.skipped}` : ''}`);
      onClose();
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Не удалось применить', 'error'),
  });
  const cancel = async () => {
    try {
      await registersApi.cancelImport(preview.id);
    } catch {
      // не критично: предпросмотр сам устареет через 30 минут
    }
    onClose();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !apply.isPending) void cancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  return (
    <Overlay>
    <div className="backdrop" role="presentation">
      <div className="modal panel wide-modal" role="dialog" aria-modal="true" aria-labelledby="imp-title">
        <h2 id="imp-title">Импорт в «{reg.name}»</h2>
        <p className="hint">Файл «{s.fileName}», строк: {s.rows}. Пока ничего не изменено.</p>
        <div className="imp-kpis">
          <div><b className="mono">{s.added}</b><span>добавится</span></div>
          <div><b className="mono">{s.updated}</b><span>изменится</span></div>
          <div><b className="mono">{s.unchanged}</b><span>без изменений</span></div>
          <div className={s.errorRows ? 'bad' : undefined}><b className="mono">{s.errorRows}</b><span>строк с ошибками</span></div>
        </div>
        {s.fieldChanges.length > 0 && (
          <div>
            <div className="eyebrow">Изменится по полям</div>
            <div className="cover">{s.fieldChanges.map((c) => <span key={c.fieldId} className="chip acc">{c.label}: {c.count}</span>)}</div>
          </div>
        )}
        {s.warnings.length > 0 && <ul className="warn-list">{s.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
        {s.errors.length > 0 && (
          <div className="grid-gap">
            <div className="eyebrow">Строки с ошибками — не будут применены</div>
            <div className="tbl-wrap imp-errors">
              <table className="cat-tbl">
                <thead><tr><th>Строка</th><th>ID</th><th>Поле</th><th>Ошибка</th></tr></thead>
                <tbody>
                  {s.errors.map((e, i) => (
                    <tr key={i}><td className="mono">{e.row}</td><td className="mono">{e.id ?? '—'}</td><td>{e.field ?? '—'}</td><td>{e.message}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        <div className="row end">
          <button className="btn" type="button" onClick={() => void cancel()} disabled={apply.isPending}>Отмена</button>
          <button className="btn primary" type="button" onClick={() => apply.mutate()} disabled={nothing || apply.isPending}>
            {nothing ? 'Нечего применять' : `Применить: +${s.added}, изменить ${s.updated}`}
          </button>
        </div>
      </div>
    </div>
    </Overlay>
  );
}
