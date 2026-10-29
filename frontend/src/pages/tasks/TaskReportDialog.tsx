import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { settingsApi } from '../../api/settings';
import { tasksApi, tkeys, type TaskReportFilter } from '../../api/tasks';
import { Overlay } from '../../components/Overlay';
import { useToast } from '../../components/Toast';

/** Отчёт по задачам в Excel (релиз 1.2.0, право «Задачи: отчёт»): фильтры и выгрузка. */
export function TaskReportDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const statuses = useQuery({ queryKey: tkeys.statuses, queryFn: () => settingsApi.items('task_statuses', false) });
  const categories = useQuery({ queryKey: tkeys.categories, queryFn: () => settingsApi.items('task_categories', false) });
  const people = useQuery({ queryKey: ['settings', 'userOptions'], queryFn: settingsApi.userOptions });
  const [f, setF] = useState<TaskReportFilter>({ period: 'created' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<TaskReportFilter>) => setF({ ...f, ...patch });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { blob, fileName } = await tasksApi.report(f);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast(`Выгружено: ${fileName}`);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось выгрузить отчёт');
    } finally {
      setBusy(false);
    }
  };
  const person = (label: string, key: 'assigneeId' | 'creatorId') => (
    <label>{label}
      <select className="inp" value={f[key] ?? ''} onChange={(e) => set({ [key]: e.target.value || undefined })}>
        <option value="">Все</option>
        {people.data?.items.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
      </select>
    </label>
  );

  return (
    <Overlay>
      <div className="backdrop" role="presentation">
        <form className="modal panel report-dialog task-form" role="dialog" aria-modal="true" aria-labelledby="tr-title" onSubmit={(e) => void submit(e)}>
          <h2 id="tr-title">Отчёт по задачам</h2>
          <div className="fgrid">
            <label>Период
              <select className="inp" value={f.period ?? 'created'} onChange={(e) => set({ period: e.target.value as TaskReportFilter['period'] })}>
                <option value="created">по дате создания</option>
                <option value="due">по сроку</option>
                <option value="completed">по дате выполнения</option>
              </select>
            </label>
            <label>С<input className="inp" type="date" value={f.from ?? ''} onChange={(e) => set({ from: e.target.value || undefined })} /></label>
            <label>По<input className="inp" type="date" value={f.to ?? ''} onChange={(e) => set({ to: e.target.value || undefined })} /></label>
            {person('Исполнитель', 'assigneeId')}
            {person('Автор', 'creatorId')}
            <label>Категория
              <select className="inp" value={f.categoryId ?? ''} onChange={(e) => set({ categoryId: e.target.value || undefined })}>
                <option value="">Все</option>
                {categories.data?.items.map((c) => <option key={c.id} value={c.id}>{c.value}</option>)}
              </select>
            </label>
            <label>Колонка
              <select className="inp" value={f.statusId ?? ''} onChange={(e) => set({ statusId: e.target.value || undefined })}>
                <option value="">Все</option>
                {statuses.data?.items.map((s) => <option key={s.id} value={s.id}>{s.value}</option>)}
              </select>
            </label>
          </div>
          <label className="chk"><input type="checkbox" checked={f.overdue === 'true'} onChange={(e) => set({ overdue: e.target.checked ? 'true' : undefined })} /> только просроченные</label>
          <label className="chk"><input type="checkbox" checked={f.archived === 'true'} onChange={(e) => set({ archived: e.target.checked ? 'true' : undefined })} /> с задачами из архива</label>
          <p className="hint">
            В отчёте: задача, автор, исполнитель, срок, колонка, даты «создана», «поставлена», «взята в работу», «отправлена на проверку», «выполнена» и дни просрочки.
            Просроченная — открытая со сроком в прошлом или выполненная позже срока. Не больше 100 000 задач за раз.
          </p>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="row end">
            <button className="btn" type="button" onClick={onClose} disabled={busy}>Отмена</button>
            <button className="btn primary" type="submit" disabled={busy}>{busy ? 'Выгружаем…' : 'Выгрузить в Excel'}</button>
          </div>
        </form>
      </div>
    </Overlay>
  );
}
