import { Overlay } from '../../components/Overlay';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { registersApi, type ImportPreview, type RegisterDetail } from '../../api/registers';
import { useToast } from '../../components/Toast';
import { rkeys } from './keys';

const MATCH_NAMES = { add: 'новая запись', update: 'обновление', unchanged: 'без изменений', error: 'ошибка — не применяется' } as const;

/** Импорт Excel, шаг 1 → 2: предпросмотр (ничего не изменено), затем применение одной транзакцией. */
export function ImportDialog({ reg, preview, onClose }: { reg: RegisterDetail; preview: ImportPreview; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const s = preview.summary;
  const nothing = s.added + s.updated === 0;
  const byKey = s.matchBy === 'key';
  const [show, setShow] = useState<'all' | 'add' | 'update' | 'unchanged' | 'error'>('all');
  const matches = s.matches.filter((m) => show === 'all' || m.action === show);

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
        {byKey
          ? <p className="imp-kind">Сопоставление по ключу <span className="chip acc">{s.keyField?.label}</span>: найдена запись — обновление, нет — новая. Колонки ID в файле нет.</p>
          : <p className="imp-kind">Файл распознан как <span className="chip info">Выгрузка реестра</span> — записи обновляются по колонке ID.</p>}
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
        {byKey && s.matches.length > 0 && (
          <div className="grid-gap">
            <div className="row sb">
              <div className="eyebrow">Сопоставление строк файла</div>
              <div className="filters" role="group" aria-label="Показать строки">
                {([['all', 'Все'], ['add', 'Новые'], ['update', 'Изменятся'], ['unchanged', 'Без изменений'], ['error', 'Ошибки']] as const).map(([k, t]) => (
                  <button key={k} type="button" aria-pressed={show === k} onClick={() => setShow(k)}>{t}</button>
                ))}
              </div>
            </div>
            <div className="tbl-wrap imp-errors">
              <table className="cat-tbl" aria-label="Сопоставление строк">
                <thead><tr><th>Строка</th><th>{s.keyField?.label}</th><th>Запись</th><th>Что будет</th></tr></thead>
                <tbody>
                  {matches.map((m) => (
                    <tr key={m.row}>
                      <td className="mono">{m.row}</td><td>{m.key || '—'}</td><td className="mono">{m.number ? `#${m.number}` : '—'}</td>
                      <td>{MATCH_NAMES[m.action]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {byKey && (
          <div className="grid-gap">
            <div className="eyebrow">Нет в файле: {s.missingTotal}</div>
            {s.missingTotal === 0
              ? <div className="hint">Все действующие записи реестра есть в файле</div>
              : (
                <>
                  <p className="hint">Действующие записи, которых нет в файле, — кандидаты на «Выведено». Портал их не меняет: проверьте и закройте вручную.</p>
                  <div className="tbl-wrap imp-errors">
                    <table className="cat-tbl" aria-label="Нет в файле">
                      <thead><tr><th>Запись</th><th>{s.keyField?.label}</th><th>Заголовок</th></tr></thead>
                      <tbody>{s.missing.map((m) => <tr key={m.id}><td className="mono">#{m.number}</td><td>{m.key || '—'}</td><td>{m.title}</td></tr>)}</tbody>
                    </table>
                  </div>
                </>
              )}
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
