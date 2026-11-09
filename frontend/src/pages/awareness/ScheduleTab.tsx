// «Осведомлённость → Расписание» (1.9.0, ADR-0040; docs/specs/awareness.md, раздел 19): правила рассылок,
// «Ближайшие 6 дат» с переносами и причинами, «Проверить сейчас», включить и отключить, архив, последние запуски.
// Задачи создаёт ежечасный прогон backend: здесь только правила.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { awarenessApi, awarenessKeys, type PreviewDate, type Rule, type RuleBody, type RuleItem } from '../../api/awareness';
import { DetailPanel } from '../../components/DetailPanel';
import { useToast } from '../../components/Toast';
import { ConfirmDialog, type ConfirmAsk } from '../settings/ConfirmDialog';
import { todayLocal } from '../tasks/logic';
import {
  CADENCE_KINDS, cadenceOf, DEFAULT_CADENCE, formOfCadence, LEAD_DAYS, leadDaysProblem, MONTHS, ru, STATUS_NAME, WEEKDAYS, type CadenceForm,
} from './logic';
import { Select } from '../../components/Select';

const NEW = 'new';
const days = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

interface RuleForm { title: string; cadence: CadenceForm; startsOn: string; leadDays: number; roleId: string; templateId: string; active: boolean }
const emptyForm = (): RuleForm => ({ title: '', cadence: DEFAULT_CADENCE, startsOn: todayLocal(), leadDays: LEAD_DAYS.default, roleId: '', templateId: '', active: true });
const formOf = (r: Rule): RuleForm => ({
  title: r.title, cadence: formOfCadence(r.cadence), startsOn: r.startsOn, leadDays: r.leadDays, roleId: r.role.id, templateId: r.template?.id ?? '', active: r.active,
});
const bodyOf = (f: RuleForm): RuleBody => ({
  title: f.title, cadence: cadenceOf(f.cadence), startsOn: f.startsOn, leadDays: f.leadDays, roleId: f.roleId, templateId: f.templateId || null, active: f.active,
});

function Dates({ dates }: { dates: readonly PreviewDate[] }) {
  if (!dates.length) return <div className="hint">Ближайших дат нет</div>;
  return (
    <ol className="aw-dates" data-testid="rule-dates">
      {dates.map((d) => (
        <li key={d.nominal} className={d.shifted ? 'shifted' : undefined}>
          <b className="mono">{ru(d.planned)}</b>
          {d.shifted && <span className="hint">вместо {ru(d.nominal)} — {d.reason}</span>}
        </li>
      ))}
    </ol>
  );
}

function CadenceFields({ value, onChange, disabled }: { value: CadenceForm; onChange: (c: CadenceForm) => void; disabled: boolean }) {
  const set = (patch: Partial<CadenceForm>) => onChange({ ...value, ...patch });
  const daySelect = (label: string, v: number, key: 'day' | 'day2') => (
    <label>{label}
      <Select className="inp" value={v} disabled={disabled} onChange={(e) => set({ [key]: Number(e.target.value) })}>
        {days(1, 31).map((d) => <option key={d} value={d}>{d}</option>)}
      </Select>
    </label>
  );
  return (
    <div className="fgrid aw-cadence">
      <label>Периодичность
        <Select className="inp" value={value.kind} disabled={disabled} onChange={(e) => set({ kind: e.target.value as CadenceForm['kind'] })}>
          {CADENCE_KINDS.map((k) => <option key={k.key} value={k.key}>{k.title}</option>)}
        </Select>
      </label>
      {value.kind === 'monthly' && daySelect('День месяца', value.day, 'day')}
      {value.kind === 'twice_monthly' && <>{daySelect('Первый день', value.day, 'day')}{daySelect('Второй день', value.day2, 'day2')}</>}
      {value.kind === 'quarterly' && (
        <>
          <label>Месяц квартала
            <Select className="inp" value={value.quarterMonth} disabled={disabled} onChange={(e) => set({ quarterMonth: Number(e.target.value) })}>
              <option value={1}>первый (январь, апрель…)</option><option value={2}>второй (февраль, май…)</option><option value={3}>третий (март, июнь…)</option>
            </Select>
          </label>
          {daySelect('День', value.day, 'day')}
        </>
      )}
      {value.kind === 'yearly' && (
        <>
          <label>Месяц
            <Select className="inp" value={value.month} disabled={disabled} onChange={(e) => set({ month: Number(e.target.value) })}>
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </Select>
          </label>
          {daySelect('День', value.day, 'day')}
        </>
      )}
      {value.kind === 'weekly' && (
        <>
          <label>Каждую N-ю неделю
            <Select className="inp" value={value.every} disabled={disabled} onChange={(e) => set({ every: Number(e.target.value) })}>
              {days(1, 12).map((n) => <option key={n} value={n}>{n === 1 ? 'каждую' : `каждую ${n}-ю`}</option>)}
            </Select>
          </label>
          <label>День недели
            <Select className="inp" value={value.weekday} disabled={disabled} onChange={(e) => set({ weekday: Number(e.target.value) })}>
              {WEEKDAYS.map((w, i) => <option key={w} value={i + 1}>{w}</option>)}
            </Select>
          </label>
        </>
      )}
      {(value.kind !== 'weekly' && value.day > 28) && <p className="hint aw-wide">Дня {value.day} нет в коротких месяцах — тогда последний день месяца.</p>}
    </div>
  );
}

function RulePanel({ id, onClose, onOpen }: { id: string; onClose: () => void; onOpen: (id: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const isNew = id === NEW;
  const q = useQuery({ queryKey: awarenessKeys.rule(id), queryFn: () => awarenessApi.rule(id), enabled: !isNew });
  const roles = useQuery({ queryKey: awarenessKeys.roles, queryFn: awarenessApi.workRoles });
  const templates = useQuery({ queryKey: awarenessKeys.templates, queryFn: () => awarenessApi.templates() });
  const r = q.data;
  const [f, setF] = useState<RuleForm>(emptyForm);
  const [ask, setAsk] = useState<ConfirmAsk | null>(null);
  const [conflict, setConflict] = useState(false);
  useEffect(() => {
    if (r) { setF(formOf(r)); setConflict(false); }
  }, [r]);
  const dirty = isNew ? !!f.title.trim() : !!r && JSON.stringify(bodyOf(f)) !== JSON.stringify(bodyOf(formOf(r)));
  const editable = isNew || (!!r && !r.archived && !conflict);
  const leadProblem = leadDaysProblem(f.leadDays);

  // «Ближайшие 6 дат» по форме — до сохранения.
  const preview = useQuery({
    queryKey: ['awareness', 'rule-preview', JSON.stringify(cadenceOf(f.cadence)), f.startsOn],
    queryFn: () => awarenessApi.preview({ cadence: cadenceOf(f.cadence), startsOn: f.startsOn }),
    enabled: /^\d{4}-\d{2}-\d{2}$/.test(f.startsOn),
    staleTime: 60_000,
    retry: false,
  });

  const done = async (next: Rule, text: string) => {
    qc.setQueryData(awarenessKeys.rule(next.id), next);
    await qc.invalidateQueries({ queryKey: awarenessKeys.rules });
    toast(text);
  };
  const fail = (err: unknown) => {
    if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') setConflict(true);
    else toast(err instanceof Error ? err.message : 'Не удалось', 'error');
  };
  const save = useMutation({
    mutationFn: () => (isNew ? awarenessApi.createRule(bodyOf(f)) : awarenessApi.saveRule(id, { ...bodyOf(f), version: r?.version ?? 0 })),
    onSuccess: async (next) => { await done(next, isNew ? `Правило «${next.title}» создано` : 'Правило сохранено'); if (isNew) onOpen(next.id); },
    onError: fail,
  });
  const toggle = useMutation({
    mutationFn: () => {
      if (!r) throw new Error('Правило не загружено');
      return awarenessApi.saveRule(id, { ...bodyOf(formOf(r)), active: !r.active, version: r.version });
    },
    onSuccess: (next) => done(next, next.active ? 'Правило включено' : 'Правило отключено — задачи не создаются'),
    onError: fail,
  });
  const archive = useMutation({
    mutationFn: (archived: boolean) => awarenessApi.archiveRule(id, r?.version ?? 0, archived),
    onSuccess: (next) => done(next, next.archived ? 'Правило в архиве' : 'Правило возвращено из архива'),
    onError: fail,
  });
  const run = useMutation({
    mutationFn: () => awarenessApi.runRule(id),
    onSuccess: async (res) => {
      await qc.invalidateQueries({ queryKey: awarenessKeys.rule(id) });
      await qc.invalidateQueries({ queryKey: ['tasks'] });
      const parts = [res.created ? `создано задач: ${res.created}` : 'новых задач нет', res.letters ? `черновиков: ${res.letters}` : '', res.escalated ? `эскалаций: ${res.escalated}` : ''].filter(Boolean);
      toast(`Проверено: ${parts.join(', ')}`);
    },
    onError: fail,
  });
  const close = () => {
    if (dirty) setAsk({ title: 'Закрыть без сохранения?', text: 'Изменения в правиле не сохранены.', confirm: 'Закрыть', run: onClose });
    else onClose();
  };
  const busy = save.isPending || toggle.isPending || archive.isPending || run.isPending;
  const role = roles.data?.items.find((x) => x.id === f.roleId);
  const tplOptions = (templates.data?.items ?? []).filter((t) => !t.archived);
  const currentArchivedTpl = r?.template?.archived && r.template.id === f.templateId ? r.template : null;

  const footer = (
    <>
      {editable && <button className="btn primary" type="button" disabled={busy || !dirty || !f.title.trim() || !f.roleId || !!leadProblem} onClick={() => save.mutate()}>{isNew ? 'Создать правило' : 'Сохранить'}</button>}
      {r && !r.archived && r.active && <button className="btn" type="button" disabled={busy || dirty} title={dirty ? 'Сначала сохраните изменения' : undefined} onClick={() => run.mutate()}>Проверить сейчас</button>}
      {r && !r.archived && <button className="btn" type="button" disabled={busy || dirty} onClick={() => toggle.mutate()}>{r.active ? 'Отключить' : 'Включить'}</button>}
      <span className="grow" />
      {r && !r.archived && <button className="btn ghost" type="button" disabled={busy} onClick={() => setAsk({ title: 'Отправить правило в архив?', text: 'Правило перестанет создавать задачи. Созданные задачи и письма останутся.', confirm: 'В архив', run: () => { setAsk(null); archive.mutate(true); } })}>В архив</button>}
      {r?.archived && <button className="btn ghost" type="button" disabled={busy} onClick={() => archive.mutate(false)}>Из архива</button>}
    </>
  );

  return (
    <DetailPanel label="Правило рассылки" variant="sheet" wide onClose={close} scrollKey={id} testId="rule-panel"
      eyebrow={isNew ? 'Новое правило' : r ? r.cadenceText : 'Правило'}
      title={f.title || r?.title || (isNew ? 'Новое правило' : 'Загрузка…')}
      badges={r && <>
        <span className={`chip ${r.active && !r.archived ? 'low' : ''}`}>{r.archived ? 'В архиве' : r.active ? 'Активно' : 'Отключено'}</span>
        {r.roleHolders === 0 && <span className="chip crit">у роли нет участников</span>}
        {r.template?.archived && <span className="chip high">шаблон в архиве</span>}
      </>}
      footer={footer}>
      {q.isError && <div className="form-error">{q.error.message}</div>}
      {conflict && (
        <div className="note conflict" role="alert">
          Правило изменил другой пользователь — ваши изменения не сохранены.
          <div className="row mt6"><button className="btn sm primary" type="button" onClick={() => void q.refetch()}>Перечитать правило</button></div>
        </div>
      )}
      {(isNew || r) && (
        <div className="aw-letter">
          {!isNew && <div className="note ro">Правка и отключение не меняют уже созданные задачи и письма. Новые задачи будут по новой периодичности.</div>}
          <label>Название (входит в название задачи «Рассылка: …»)
            <input className="inp" required maxLength={200} value={f.title} disabled={!editable} onChange={(e) => setF({ ...f, title: e.target.value })} />
          </label>
          <CadenceFields value={f.cadence} disabled={!editable} onChange={(cadence) => setF({ ...f, cadence })} />
          <div className="fgrid">
            <label>Дата начала
              <input className="inp" type="date" required value={f.startsOn} disabled={!editable} onChange={(e) => setF({ ...f, startsOn: e.target.value })} />
            </label>
            <label>Опережение, дней (7–90)
              <input className="inp" type="number" min={LEAD_DAYS.min} max={LEAD_DAYS.max} step={1} required disabled={!editable}
                value={Number.isNaN(f.leadDays) ? '' : f.leadDays} aria-invalid={!!leadProblem}
                onChange={(e) => setF({ ...f, leadDays: e.target.value === '' ? Number.NaN : Number(e.target.value) })} />
              <span className={leadProblem ? 'form-error' : 'hint'}>{leadProblem ?? 'За столько дней до плановой даты появится задача'}</span>
            </label>
          </div>
          <div className="fgrid">
            <label>Роль-исполнитель
              <Select className="inp" required value={f.roleId} disabled={!editable} onChange={(e) => setF({ ...f, roleId: e.target.value })}>
                <option value="" disabled>Выберите роль…</option>
                {roles.data?.items.map((x) => <option key={x.id} value={x.id}>{x.name} — участников: {x.holders}</option>)}
                {r && !roles.data?.items.some((x) => x.id === r.role.id) && <option value={r.role.id}>{r.role.name} — нет права «Работа в разделах ИБ»</option>}
              </Select>
              <span className="hint">{role && role.holders === 0 ? 'У роли нет участников: задача будет без кандидатов, сразу эскалация начальнику ИБ' : 'Задачу видят все сотрудники ИБ, взять её могут держатели роли'}</span>
            </label>
            <label>Шаблон (необязательно)
              <Select className="inp" value={f.templateId} disabled={!editable} onChange={(e) => setF({ ...f, templateId: e.target.value })}>
                <option value="">— без шаблона</option>
                {tplOptions.map((t) => <option key={t.id} value={t.id}>{t.title}{t.tooLarge ? ' — больше лимита' : ''}</option>)}
                {currentArchivedTpl && <option value={currentArchivedTpl.id}>{currentArchivedTpl.title} — в архиве</option>}
              </Select>
              <span className="hint">С шаблоном черновик письма создаётся сразу; без шаблона — письмо создают из задачи.</span>
            </label>
          </div>
          <label className="row gap6 aw-check">
            <input type="checkbox" checked={f.active} disabled={!editable} onChange={(e) => setF({ ...f, active: e.target.checked })} />Активно — создавать задачи
          </label>

          <div className="aw-block">
            <div className="eyebrow">Ближайшие 6 дат{preview.data ? ` — ${preview.data.cadenceText}` : ''}</div>
            {preview.isError ? <div className="form-error">{preview.error.message}</div> : preview.data ? <Dates dates={preview.data.dates} /> : <div className="hint">Считаем…</div>}
            <div className="hint">Дата на выходной или праздник переносится на предыдущий рабочий день. Этапы: черновик — за 7 дней, согласование — за 3.</div>
          </div>

          {r && r.runs.length > 0 && (
            <div className="aw-block">
              <div className="eyebrow">Последние запуски</div>
              <table className="cat-tbl" data-testid="rule-runs">
                <thead><tr><th>Отправка</th><th>Задача</th><th>Письмо</th></tr></thead>
                <tbody>
                  {r.runs.map((x) => (
                    <tr key={x.id}>
                      <td className="mono">{ru(x.plannedDate)}{x.escalatedAt && <span className="chip high ml6">эскалация</span>}</td>
                      <td>{x.task ? <Link to={`/tasks?task=${x.task.id}`}>#{x.task.number}</Link> : '—'}{x.task?.done && <span className="hint"> выполнена</span>}</td>
                      <td>{x.letter ? <Link to={`/awareness/letters?letter=${x.letter.id}`}>№ {x.letter.number} · {STATUS_NAME[x.letter.status]}</Link> : <span className="hint">нет</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {ask && <ConfirmDialog ask={ask} busy={busy} onClose={() => setAsk(null)} />}
    </DetailPanel>
  );
}

export function ScheduleTab() {
  const [params, setParams] = useSearchParams();
  const selected = params.get('rule');
  const archived = params.get('archive') === '1';
  const list = useQuery({ queryKey: [...awarenessKeys.rules, { archived }], queryFn: () => awarenessApi.rules(archived ? 'archived' : 'active') });
  const select = useCallback((id: string | null) => {
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (id === null) n.delete('rule'); else n.set('rule', id);
      return n;
    }, { preventScrollReset: true });
  }, [setParams]);
  const items = list.data?.items ?? [];

  const row = (r: RuleItem) => (
    <tr key={r.id} className={r.id === selected ? 'sel' : undefined} tabIndex={0} data-rule={r.title}
      onClick={() => select(r.id)} onKeyDown={(e) => { if (e.key === 'Enter') select(r.id); }}>
      <td><div className="w500">{r.title}</div><div className="hint">{r.cadenceText}</div></td>
      <td>{r.role.name}{r.roleHolders === 0 && <span className="chip crit ml6">нет участников</span>}</td>
      <td>{r.template ? <>{r.template.title}{r.template.archived && <span className="chip high ml6">в архиве</span>}</> : <span className="hint">—</span>}</td>
      <td className="mono">{r.next ? <>{ru(r.next.planned)}{r.next.shifted && <span className="hint"> (перенос)</span>}</> : '—'}</td>
      <td><span className={`chip ${r.active ? 'low' : ''}`}>{r.archived ? 'в архиве' : r.active ? 'активно' : 'отключено'}</span></td>
    </tr>
  );

  return (
    <>
      <div className="row docs-bar">
        <div className="filters toolbar-grow" role="group" aria-label="Правила">
          <button type="button" aria-pressed={!archived} onClick={() => setParams({}, { replace: true })}>Действующие</button>
          <button type="button" aria-pressed={archived} onClick={() => setParams({ archive: '1' }, { replace: true })}>Архив</button>
        </div>
        <button className="btn primary" type="button" onClick={() => select(NEW)}>Новое правило</button>
      </div>
      <p className="hint">Задачи «Рассылка: …» создаются раз в час на плановые даты в пределах опережения. Если задачу никто не взял за 3 рабочих дня до срока — начальнику ИБ приходит уведомление.</p>
      {list.isError && <div className="form-error">{list.error.message}</div>}
      <section className="panel">
        <div className="tbl-wrap">
          <table className="docs-tbl aw-letters" data-testid="rules-table">
            <thead><tr><th>Правило</th><th>Роль</th><th>Шаблон</th><th>Ближайшая</th><th>Состояние</th></tr></thead>
            <tbody>
              {items.map(row)}
              {list.isSuccess && items.length === 0 && <tr><td colSpan={5} className="hint">{archived ? 'В архиве правил нет' : 'Правил пока нет'}</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      {selected && <RulePanel key={selected} id={selected} onClose={() => select(null)} onOpen={(id) => select(id)} />}
    </>
  );
}
