// Вкладка «Автоматизации» карточки утверждённого документа (1.11.0, ADR-0043): периодическая задача ответственному
// по механизму контроля. Следующий запуск (с переносом), история запусков, «Проверить сейчас». Решает backend.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '../../api/client';
import { automationsApi, controlsApi, dkeys, type ControlCadence, type DocAutomation, type DocAutomationFields } from '../../api/documents';
import { settingsApi } from '../../api/settings';
import { useToast } from '../../components/Toast';
import { formatDate } from '../registers/logic';
import { todayLocal } from '../tasks/logic';

type Kind = ControlCadence['kind'];
const KINDS: { kind: Kind; title: string }[] = [
  { kind: 'daily', title: 'Ежедневно' }, { kind: 'weekly', title: 'Еженедельно' }, { kind: 'monthly', title: 'Ежемесячно' },
  { kind: 'quarterly', title: 'Ежеквартально' }, { kind: 'semiannual', title: 'Раз в полгода' }, { kind: 'yearly', title: 'Ежегодно' },
];
const WEEKDAYS = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const RUN_STATUS: Record<DocAutomation['runs'][number]['status'], string> = {
  created: 'задача создана', skipped_late: 'пропущен (портал не работал больше 7 дней)', no_assignee: 'не создан: нет ответственного', doc_archived: 'документ в архиве',
};

interface Form {
  title: string; description: string; controlId: string; kind: Kind; weekday: number; day: number; month: number;
  startsOn: string; dueDays: string; dueKind: 'calendar' | 'working'; assigneeId: string;
}
const emptyForm = (): Form => ({ title: '', description: '', controlId: '', kind: 'monthly', weekday: 1, day: 1, month: 1, startsOn: todayLocal(), dueDays: '5', dueKind: 'working', assigneeId: '' });

function cadenceOf(f: Form): ControlCadence {
  switch (f.kind) {
    case 'daily': return { kind: 'daily' };
    case 'weekly': return { kind: 'weekly', weekday: f.weekday };
    case 'monthly': return { kind: 'monthly', day: f.day };
    case 'quarterly': return { kind: 'quarterly', month: Math.min(f.month, 3), day: f.day };
    case 'semiannual': return { kind: 'semiannual', month: Math.min(f.month, 6), day: f.day };
    case 'yearly': return { kind: 'yearly', month: f.month, day: f.day };
  }
}
function formOf(a: DocAutomation): Form {
  const c = a.cadence;
  return {
    title: a.title, description: a.description, controlId: a.control?.id ?? '', kind: c.kind,
    weekday: c.kind === 'weekly' ? c.weekday : 1, day: 'day' in c ? c.day : 1, month: 'month' in c ? c.month : 1,
    startsOn: a.startsOn, dueDays: String(a.dueDays), dueKind: a.dueKind, assigneeId: a.assignee.id,
  };
}
const bodyOf = (f: Form): DocAutomationFields => ({
  title: f.title, description: f.description, controlId: f.controlId || null, cadence: cadenceOf(f), startsOn: f.startsOn,
  dueDays: Number(f.dueDays), dueKind: f.dueKind, assigneeId: f.assigneeId,
});

export function DocumentAutomations({ docId }: { docId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: dkeys.automations(docId), queryFn: () => automationsApi.list(docId) });
  const [mode, setMode] = useState<{ kind: 'add' } | { kind: 'edit'; a: DocAutomation } | null>(null);
  const [form, setForm] = useState<Form>(emptyForm);
  const [stale, setStale] = useState<string | null>(null);
  const controls = useQuery({ queryKey: dkeys.controls(docId), queryFn: () => controlsApi.list(docId), enabled: mode !== null });
  const people = useQuery({ queryKey: ['users', 'options', 'ib'], queryFn: settingsApi.userOptions, enabled: mode !== null });
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: dkeys.automations(docId) }), qc.invalidateQueries({ queryKey: ['documents', 'list'] }), qc.invalidateQueries({ queryKey: ['tasks'] })]);
  const close = () => { setMode(null); setForm(emptyForm()); };
  const onError = (e: unknown) => {
    if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') { setStale(e.message); return; }
    toast(e instanceof Error ? e.message : 'Не удалось сохранить', 'error');
  };
  const create = useMutation({ mutationFn: () => automationsApi.create(docId, bodyOf(form)), onSuccess: async () => { close(); await refresh(); toast('Автоматизация добавлена'); }, onError });
  const update = useMutation({
    mutationFn: (x: { a: DocAutomation; patch: Partial<DocAutomationFields> }) => automationsApi.update(docId, x.a.id, { version: x.a.version, ...x.patch }),
    onSuccess: async (_r, x) => { close(); await refresh(); toast(x.patch.active === false ? 'Автоматизация отключена' : x.patch.active === true ? 'Автоматизация включена' : 'Автоматизация сохранена'); },
    onError,
  });
  const run = useMutation({
    mutationFn: (a: DocAutomation) => automationsApi.run(docId, a.id),
    onSuccess: async (r) => {
      await refresh();
      toast(r.created ? `Создано задач: ${r.created}` : r.noAssignee ? 'Задача не создана: нет ответственного' : 'Сейчас запусков нет — следующий по расписанию');
    },
    onError,
  });
  const busy = create.isPending || update.isPending || run.isPending;

  if (list.isError) return <div className="form-error">{list.error.message}</div>;
  if (!list.data) return <div className="hint">Загружаем автоматизации</div>;
  const { items, canManage } = list.data;
  const set = <K extends keyof Form>(k: K) => (e: { target: { value: string } }) => setForm({ ...form, [k]: (k === 'weekday' || k === 'day' || k === 'month' ? Number(e.target.value) : e.target.value) as Form[K] });
  const valid = form.title.trim() && form.assigneeId && /^\d{4}-\d{2}-\d{2}$/.test(form.startsOn) && Number(form.dueDays) >= 1 && Number(form.dueDays) <= 365;

  return (
    <div aria-label="Автоматизации" data-testid="doc-automations">
      {stale && (
        <div className="note conflict" role="alert">
          {stale}
          <div className="row mt6"><button className="btn sm primary" type="button" onClick={() => { setStale(null); close(); void refresh(); }}>Перечитать</button></div>
        </div>
      )}
      {items.length === 0 && <div className="hint">Автоматизаций нет. {canManage ? 'Автоматизация ставит задачу ответственному с выбранной периодичностью.' : ''}</div>}
      <div className="hist">
        {items.map((a) => (
          <div key={a.id} className={`hist-item${a.active ? '' : ' muted'}`} data-automation={a.title}>
            <div className="row">
              <b>{a.title}</b>
              {!a.active && <span className="chip">отключена</span>}
              {a.noAssignee && <span className="chip crit" data-testid="no-assignee">Нет ответственного</span>}
            </div>
            <div className="hint">{a.cadenceLabel} · срок {a.dueDays} {a.dueKind === 'working' ? 'раб.' : 'кал.'} дн. · ответственный {a.assignee.fullName}</div>
            {a.control && <div className="hint">Механизм контроля {a.control.position}: {a.control.requirement}</div>}
            {a.next && (
              <div className="hint" data-testid="next-run">
                Следующий запуск: {formatDate(a.next.planned)}{a.next.planned !== a.next.nominal ? ` (перенос с ${formatDate(a.next.nominal)})` : ''}
              </div>
            )}
            {a.runs.length > 0 && (
              <details>
                <summary>Запуски ({a.runs.length})</summary>
                <ul className="plain" data-testid="runs">
                  {a.runs.map((r) => (
                    <li key={r.nominalDate}>
                      {formatDate(r.plannedDate)} — {RUN_STATUS[r.status]}
                      {r.task && <> · <a href={`/tasks?task=${r.task.id}`}>задача #{r.task.number}</a> ({r.task.archived ? 'в архиве' : r.task.status})</>}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {canManage && !mode && (
              <div className="row">
                {a.active && <button type="button" className="btn sm" disabled={busy} onClick={() => run.mutate(a)}>Проверить сейчас</button>}
                <button type="button" className="btn ghost sm" disabled={busy} onClick={() => { setForm(formOf(a)); setMode({ kind: 'edit', a }); }}>Изменить</button>
                <button type="button" className="btn ghost sm" disabled={busy} onClick={() => update.mutate({ a, patch: { active: !a.active } })}>{a.active ? 'Отключить' : 'Включить'}</button>
              </div>
            )}
          </div>
        ))}
      </div>
      {canManage && !mode && <div className="row"><button type="button" className="btn sm" onClick={() => { setForm(emptyForm()); setMode({ kind: 'add' }); }}>Добавить автоматизацию</button></div>}
      {mode && (
        <form className="task-form" aria-label={mode.kind === 'add' ? 'Новая автоматизация' : 'Автоматизация'}
          onSubmit={(e) => { e.preventDefault(); if (mode.kind === 'add') create.mutate(); else update.mutate({ a: mode.a, patch: bodyOf(form) }); }}>
          <label>Название задачи<input className="inp" required maxLength={300} value={form.title} onChange={set('title')} /></label>
          <label>Описание задачи (необязательно)<textarea className="inp" maxLength={4000} value={form.description} onChange={set('description')} /></label>
          <label>Механизм контроля (необязательно)
            <select className="inp" value={form.controlId} onChange={set('controlId')}>
              <option value="">— без механизма</option>
              {(controls.data?.items ?? []).filter((c) => c.active || c.id === form.controlId).map((c) => <option key={c.id} value={c.id}>{c.position}. {c.requirement}</option>)}
            </select>
          </label>
          <div className="fgrid">
            <label>Периодичность
              <select className="inp" value={form.kind} onChange={set('kind')}>{KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.title}</option>)}</select>
            </label>
            {form.kind === 'weekly' && (
              <label>День недели<select className="inp" value={form.weekday} onChange={set('weekday')}>{WEEKDAYS.map((w, i) => <option key={w} value={i + 1}>{w}</option>)}</select></label>
            )}
            {(form.kind === 'quarterly' || form.kind === 'semiannual' || form.kind === 'yearly') && (
              <label>{form.kind === 'yearly' ? 'Месяц' : form.kind === 'quarterly' ? 'Месяц квартала' : 'Месяц полугодия'}
                <input className="inp" type="number" min={1} max={form.kind === 'yearly' ? 12 : form.kind === 'quarterly' ? 3 : 6} value={form.month} onChange={set('month')} />
              </label>
            )}
            {form.kind !== 'daily' && form.kind !== 'weekly' && (
              <label>День месяца<input className="inp" type="number" min={1} max={31} value={form.day} onChange={set('day')} /></label>
            )}
            <label>Первый запуск<input className="inp" type="date" required value={form.startsOn} onChange={set('startsOn')} /></label>
          </div>
          <div className="fgrid">
            <label>Срок, дней<input className="inp" type="number" min={1} max={365} required value={form.dueDays} onChange={set('dueDays')} /></label>
            <label>Дни
              <select className="inp" value={form.dueKind} onChange={set('dueKind')}>
                <option value="working">рабочие (по производственному календарю)</option>
                <option value="calendar">календарные</option>
              </select>
            </label>
            <label>Ответственный
              <select className="inp" required value={form.assigneeId} onChange={set('assigneeId')}>
                <option value="">— выберите</option>
                {(people.data?.items ?? []).filter((p) => p.ibWork).map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
              </select>
            </label>
          </div>
          <div className="hint">Срок в рабочих днях: запуск с выходного или праздника — в предыдущий рабочий день. Срок задачи считается от дня её создания.</div>
          <div className="row">
            <button className="btn primary" type="submit" disabled={busy || !valid}>{mode.kind === 'add' ? 'Добавить' : 'Сохранить'}</button>
            <button className="btn" type="button" onClick={close}>Отмена</button>
          </div>
        </form>
      )}
    </div>
  );
}
