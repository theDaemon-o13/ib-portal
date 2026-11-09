import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { settingsApi, type CalendarDay } from '../../api/settings';
import { ReadOnlyNote } from '../../components/LockIcon';
import { useToast } from '../../components/Toast';
import { formatCalendarDay, toggleWeekend, WEEKDAYS } from './logic';
import { keys, useAction } from './useAction';
import { Select } from '../../components/Select';

type Kind = CalendarDay['kind'];
const KIND_LABEL: Record<Kind, string> = { holiday: 'Праздник (нерабочий)', workday: 'Рабочий день (перенос)' };

interface Draft {
  day: string;
  kind: Kind;
  title: string;
}

export function CalendarEditor({ canEdit }: { canEdit: boolean }) {
  const [year, setYear] = useState(() => new Date().getFullYear());
  const week = useQuery({ queryKey: keys.week, queryFn: settingsApi.workWeek });
  const days = useQuery({ queryKey: keys.days(year), queryFn: () => settingsApi.days(year) });
  const toast = useToast();
  const [editId, setEditId] = useState<string | null>(null);
  const [edit, setEdit] = useState<Draft>({ day: '', kind: 'holiday', title: '' });
  const [add, setAdd] = useState<Draft>({ day: '', kind: 'holiday', title: '' });
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const invalidate = [keys.days(year), keys.journal];
  const setWeek = useAction(
    (weekendDays: number[]) => settingsApi.setWorkWeek({ weekendDays, version: week.data?.version ?? 0 }),
    { invalidate: [keys.week, keys.journal], success: () => 'Выходные дни недели сохранены' },
  );
  const create = useAction((d: Draft) => settingsApi.createDay(d), {
    invalidate,
    success: (r) => `Добавлено: ${formatCalendarDay(r.day)} — ${r.title}`,
    onDone: () => setAdd({ day: '', kind: add.kind, title: '' }),
  });
  const save = useAction(({ d, item }: { d: Draft; item: CalendarDay }) => settingsApi.updateDay(item.id, { version: item.version, ...d }), {
    invalidate,
    success: () => 'Запись календаря сохранена',
    onDone: () => setEditId(null),
  });
  const remove = useAction((item: CalendarDay) => settingsApi.deleteDay(item.id, item.version), {
    invalidate,
    success: (_r, item) => `Удалено: ${formatCalendarDay(item.day)} — ${item.title}`,
    onDone: () => setConfirmId(null),
  });

  const weekend = week.data?.weekendDays ?? [];
  const onToggle = (n: number) => {
    const next = toggleWeekend(weekend, n);
    if (!next) {
      toast('В неделе должен остаться хотя бы один рабочий день', 'error');
      return;
    }
    setWeek.mutate(next);
  };
  const submitAdd = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(add);
  };

  return (
    <section className="panel">
      <div className="panel-h">
        <div>
          <h3>Производственный календарь РТ</h3>
          <span className="sub">Где используется: сроки в рабочих днях — эскалация по п. 7.4, срок задачи из письма</span>
        </div>
      </div>
      <div className="panel-b grid-gap">
        {!canEdit && <ReadOnlyNote who="роль с правом «Настройки: справочники и шаблоны форм»" />}
        <div>
          <div className="eyebrow">Выходные дни недели</div>
          <div className="filters" role="group" aria-label="Выходные дни недели">
            {WEEKDAYS.map((d) => (
              <button key={d.n} type="button" aria-pressed={weekend.includes(d.n)} title={d.name}
                disabled={!canEdit || setWeek.isPending} onClick={() => onToggle(d.n)}>
                {d.short}
              </button>
            ))}
          </div>
          <div className="hint">По умолчанию пятидневка: суббота и воскресенье — выходные.</div>
        </div>
        <div className="note">
          Постоянные праздники РТ на 2026 и 2027 годы внесены заранее. Иди Рамазон и Иди Курбон объявляются ежегодно —
          добавьте их, когда даты станут известны. Переносы выходных по постановлению Правительства тоже вносятся вручную:
          перенесённый выходной — «Праздник», рабочая суббота — «Рабочий день (перенос)».
        </div>
        <div className="row">
          <button className="btn sm" type="button" onClick={() => setYear(year - 1)} aria-label="Предыдущий год">←</button>
          <b className="mono">{year}</b>
          <button className="btn sm" type="button" onClick={() => setYear(year + 1)} aria-label="Следующий год">→</button>
          <span className="hint">{days.data ? `записей: ${days.data.items.length}` : ''}</span>
        </div>
      </div>
      <div className="tbl-wrap">
        <table className="cat-tbl">
          <thead>
            <tr><th>Дата</th><th>Вид</th><th>Название</th><th /></tr>
          </thead>
          <tbody>
            {days.isPending && <tr><td colSpan={4} className="hint">Загрузка…</td></tr>}
            {days.data?.items.length === 0 && <tr><td colSpan={4} className="hint">За {year} год записей нет</td></tr>}
            {days.data?.items.map((d) =>
              canEdit && editId === d.id ? (
                // key отличается от строки просмотра: иначе React переиспользует нажатую «Изменить» как «Сохранить» (submit) и щелчок сразу отправит форму.
                <tr key={`${d.id}:edit`} className="editing">
                  <td>
                    <form id={`cd-${d.id}`} onSubmit={(e) => {
                      e.preventDefault();
                      if (edit.day === d.day && edit.kind === d.kind && edit.title.trim() === d.title) setEditId(null);
                      else save.mutate({ d: edit, item: d });
                    }} />
                    <input form={`cd-${d.id}`} className="inp" type="date" required value={edit.day}
                      onChange={(e) => setEdit({ ...edit, day: e.target.value })} aria-label="Дата" />
                  </td>
                  <td>
                    <Select form={`cd-${d.id}`} className="inp" value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value as Kind })} aria-label="Вид">
                      {(Object.keys(KIND_LABEL) as Kind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                    </Select>
                  </td>
                  <td>
                    <input form={`cd-${d.id}`} className="inp" required value={edit.title}
                      onChange={(e) => setEdit({ ...edit, title: e.target.value })} aria-label="Название" />
                  </td>
                  <td>
                    <div className="row act">
                      <button className="btn primary sm" type="submit" form={`cd-${d.id}`} disabled={save.isPending}>Сохранить</button>
                      <button className="btn sm" type="button" onClick={() => setEditId(null)}>Отмена</button>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr key={`${d.id}:view`}>
                  <td className="mono">{formatCalendarDay(d.day)}</td>
                  <td>{d.kind === 'holiday' ? <span className="chip crit">Праздник</span> : <span className="chip low">Рабочий день</span>}</td>
                  <td>{d.title}</td>
                  <td>
                    {canEdit && (confirmId === d.id ? (
                      <div className="row act" key="confirm">
                        <span className="hint">Удалить?</span>
                        <button className="btn sm danger" type="button" onClick={() => remove.mutate(d)} disabled={remove.isPending}>Удалить</button>
                        <button className="btn sm" type="button" onClick={() => setConfirmId(null)}>Отмена</button>
                      </div>
                    ) : (
                      <div className="row act" key="actions">
                        <button className="btn ghost sm" type="button" onClick={() => { setEditId(d.id); setEdit({ day: d.day, kind: d.kind, title: d.title }); setConfirmId(null); }}>Изменить</button>
                        <button className="btn ghost sm danger-t" type="button" onClick={() => { setConfirmId(d.id); setEditId(null); }}>Удалить</button>
                      </div>
                    ))}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
      {canEdit && (
        <form className="field-form cat-add with-day" onSubmit={submitAdd}>
          <label>Дата<input className="inp" type="date" required value={add.day} onChange={(e) => setAdd({ ...add, day: e.target.value })} /></label>
          <label>
            Вид
            <Select className="inp" value={add.kind} onChange={(e) => setAdd({ ...add, kind: e.target.value as Kind })}>
              {(Object.keys(KIND_LABEL) as Kind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </Select>
          </label>
          <label>Название<input className="inp" required placeholder="Например: Иди Рамазон" value={add.title} onChange={(e) => setAdd({ ...add, title: e.target.value })} /></label>
          <button className="btn primary" type="submit" disabled={create.isPending}>Добавить</button>
        </form>
      )}
    </section>
  );
}
