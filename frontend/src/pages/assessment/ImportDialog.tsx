// Импорт Excel в черновик (Д4): исходный шаблон «Чек-лист…» или лист «Ответы» выгрузки портала.
// Файл держится в памяти до подтверждения: предпросмотр ничего не пишет, «Применить» отправляет тот же файл
// с версией оценки из предпросмотра. Пустой ответ в файле не стирает выставленный балл.
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { akeys, assessmentsApi, type Assessment, type ImportResult } from '../../api/assessments';
import { ApiError } from '../../api/client';
import { Overlay } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { dateRu } from '../dashboard/logic';
import { LevelPill } from './Charts';
import { Select } from '../../components/Select';

export function ImportDialog({ a, onClose }: { a: Assessment; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (f: File, sourceId?: string | null) => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await assessmentsApi.importFile(a.id, f, { dryRun: true, sourceId }));
    } catch (err) {
      setPreview(null);
      setError(err instanceof Error ? err.message : 'Не удалось прочитать файл');
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!file || !preview) return;
    setBusy(true);
    try {
      const res = await assessmentsApi.importFile(a.id, file, { dryRun: false, version: preview.version, sourceId: preview.sourceId });
      await qc.invalidateQueries({ queryKey: akeys.all });
      toast(`Импорт применён: разделов изменено ${res.changes.length}. Итог ${res.total} из ${res.max}`);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') {
        await qc.invalidateQueries({ queryKey: akeys.all });
        setError('Оценку изменили после предпросмотра — ничего не записано. Предпросмотр обновлён, проверьте и примените снова');
        await load(file, preview.sourceId);
        return;
      }
      setError(err instanceof Error ? err.message : 'Не удалось применить импорт');
    } finally {
      setBusy(false);
    }
  };

  const canApply = !!preview && !busy && preview.errors.length === 0 && (preview.changes.length > 0 || preview.profile.length > 0);
  return (
    <Overlay>
      <div className="backdrop" role="presentation" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
        <div className="modal panel wide-modal" role="dialog" aria-modal="true" aria-label="Импорт из Excel">
          <h2>Импорт из Excel</h2>
          <p className="hint">
            Файл шаблона «Чек-лист оценки уровня кибербезопасности» или выгрузка портала (лист «Ответы»). Портал найдёт ответы по разделам,
            покажет изменения и ничего не запишет без подтверждения. Пустой ответ в файле не стирает выставленный балл.
          </p>
          <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" aria-label="Файл Excel" disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setFile(f);
              setPreview(null);
              if (f) void load(f);
            }} />
          {busy && !preview && <div className="hint">Читаем файл…</div>}
          {error && <div className="note sa-warn" role="alert">{error}</div>}
          {preview && (
            <div className="sa-imp" data-testid="sa-import-preview">
              <div className="note">
                Найдено разделов: <b>{preview.found} из {a.sections}</b>, с ответом — {preview.answered}. Изменится: <b>{preview.changes.length}</b>.
                После импорта итог — <b>{preview.total} из {preview.max}</b>, «{preview.level.name}»{preview.preliminary ? ' (предварительно)' : ''}.
              </div>
              {preview.sources.length > 1 && (
                <label className="fd-label">Оценка из файла
                  <Select className="inp" value={preview.sourceId ?? ''} disabled={busy} onChange={(e) => file && void load(file, e.target.value)}>
                    {preview.sources.map((s) => <option key={s.id} value={s.id}>{s.title || s.id}{s.date ? ` · ${dateRu(s.date)}` : ''}</option>)}
                  </Select>
                </label>
              )}
              {preview.notes.map((n) => <div key={n} className="hint">{n}</div>)}
              {preview.errors.length > 0 && (
                <div className="note sa-warn">
                  <b>Ошибки в файле — применить нельзя:</b>
                  <ul className="sa-errs">{preview.errors.map((e, i) => <li key={i}>{e.row ? `Строка ${e.row}: ` : ''}{e.message}</li>)}</ul>
                </div>
              )}
              {preview.profile.length > 0 && (
                <div className="tbl-wrap">
                  <table>
                    <thead><tr><th>Профиль</th><th>Было</th><th>Станет</th></tr></thead>
                    <tbody>{preview.profile.map((p) => <tr key={p.label}><td>{p.label}</td><td>{p.from || '—'}</td><td>{p.to}</td></tr>)}</tbody>
                  </table>
                </div>
              )}
              {preview.changes.length > 0 && (
                <div className="tbl-wrap sa-imp-tbl">
                  <table>
                    <thead><tr><th>Раздел</th><th>Было</th><th>Станет</th><th>Комментарий</th></tr></thead>
                    <tbody>
                      {preview.changes.map((c) => (
                        <tr key={c.code}>
                          <td><span className="sa-code">{c.code}</span> {c.name}</td>
                          <td><LevelPill level={c.from} /></td>
                          <td><LevelPill level={c.to} /></td>
                          <td className="hint">{c.comment ? 'обновится' : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {!preview.errors.length && !preview.changes.length && !preview.profile.length && <div className="hint">Изменений нет: оценка уже совпадает с файлом.</div>}
            </div>
          )}
          <div className="row end">
            <button className="btn" type="button" onClick={onClose} disabled={busy}>Закрыть</button>
            <button className="btn primary" type="button" disabled={!canApply} onClick={() => void apply()}>Применить</button>
          </div>
        </div>
      </div>
    </Overlay>
  );
}
