import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { registersApi, type AutomationRule, type RegisterDetail, type RuleAction, type RuleCondition } from '../../api/registers';
import { settingsApi } from '../../api/settings';
import { useAction } from '../settings/useAction';
import { rkeys } from './keys';
import { EVENT_TYPE_NAMES, formatDate, isBasisRule, isScoreRule } from './logic';

type CondKind = RuleCondition['kind'];
type Recipient = Extract<RuleAction, { eventType: 'remind' | 'notify' | 'escalate' }>['recipients'][number];

const RECIPIENTS = 'notify_recipients';

const EVENT_TONE: Record<string, string> = { remind: 'info', notify: 'high', escalate: 'crit', set_option: 'acc' };

type TaskAction = Extract<RuleAction, { recipients: { kind: string }[] }> & { eventType: 'remind' | 'notify' | 'escalate' };

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/**
 * Новое правило: условие (за N дней до даты / дата просрочена / поле = значение / ежегодно / канал без основания)
 * → задачи получателям или «установить значение».
 */
function RuleForm({ reg }: { reg: RegisterDetail }) {
  const live = reg.fields.filter((f) => !f.archived);
  const dates = live.filter((f) => f.type === 'date' || (f.type === 'calc' && !isScoreRule(f.calcRule) && !isBasisRule(f.calcRule)));
  const selects = live.filter((f) => f.type === 'select');
  const basisFields = live.filter((f) => f.type === 'calc' && isBasisRule(f.calcRule));
  const status = live.find((f) => f.isStatus);
  const users = live.filter((f) => f.type === 'user');
  const fillable = live.filter((f) => f.type !== 'calc' && f.type !== 'decision' && f.type !== 'file');
  const people = useQuery({ queryKey: rkeys.userOptions, queryFn: settingsApi.userOptions });
  // Метки — из справочника «Получатели уведомлений»: за меткой стоят пользователи и e-mail.
  const labels = useQuery({ queryKey: ['settings', 'items', RECIPIENTS, 'active'], queryFn: () => settingsApi.items(RECIPIENTS, false) });

  const [kind, setKind] = useState<CondKind>(dates.length ? 'before' : 'equals');
  const [fieldId, setFieldId] = useState('');
  const [optionId, setOptionId] = useState('');
  const [days, setDays] = useState('3');
  const [skipYearEnd, setSkipYearEnd] = useState(false);
  const [workdays, setWorkdays] = useState('');
  const [unless, setUnless] = useState('');
  const [month, setMonth] = useState('12');
  const [day, setDay] = useState('1');
  const [statusIds, setStatusIds] = useState<string[]>([]);
  const [eventType, setEventType] = useState<TaskAction['eventType'] | 'set_option'>('remind');
  const [title, setTitle] = useState('');
  const [setField, setSetField] = useState('');
  const [setTo, setSetTo] = useState('');
  const [setFrom, setSetFrom] = useState<string[]>([]);
  const [recipients, setRecipients] = useState<Recipient[]>(users[0] ? [{ kind: 'field', fieldId: users[0].id }] : []);

  const pool = kind === 'equals' ? selects : kind === 'basis_missing' ? basisFields : dates;
  const field = pool.find((f) => f.id === fieldId) ?? pool[0];
  const option = field?.options.filter((o) => !o.archived).find((o) => o.id === optionId) ?? field?.options.find((o) => !o.archived);
  const target = selects.find((f) => f.id === setField) ?? status ?? selects[0];
  const setOption = eventType === 'set_option';

  const condition = (): RuleCondition | null => {
    if (kind === 'yearly') return { kind, month: Number(month), day: Number(day), ...(statusIds.length ? { statusOptionIds: statusIds } : {}) };
    if (!field) return null;
    if (kind === 'basis_missing') return { kind, fieldId: field.id };
    if (kind === 'before') return { kind, fieldId: field.id, days: Math.max(0, Math.trunc(Number(days) || 0)), ...(skipYearEnd ? { skipYearEnd } : {}) };
    if (kind === 'overdue') {
      return {
        kind, fieldId: field.id,
        workdays: workdays.trim() ? Math.max(1, Math.trunc(Number(workdays))) : null,
        unlessFilledFieldId: unless || null,
      };
    }
    return option ? { kind, fieldId: field.id, optionId: option.id } : null;
  };
  const action = (): RuleAction => (setOption
    ? { eventType: 'set_option', fieldId: target?.id ?? '', optionId: setTo || (target?.options.find((o) => !o.archived)?.id ?? ''), fromOptionIds: setFrom, recipients: [] }
    : { eventType, recipients, ...(title.trim() ? { title: title.trim() } : {}) });
  const create = useAction(() => {
    const c = condition();
    if (!c) throw new Error('Выберите поле условия');
    return registersApi.createRule(reg.id, { condition: c, action: action() });
  }, {
    invalidate: [rkeys.rules(reg.id)],
    success: (r) => `Правило добавлено: ${r.when} → ${r.then}`,
  });
  const addRecipient = (r: Recipient) => {
    const same = (x: Recipient) => (x.kind === 'field' && r.kind === 'field' ? x.fieldId === r.fieldId
      : x.kind === 'label' && r.kind === 'label' ? x.itemId === r.itemId
        : x.kind === 'user' && r.kind === 'user' && x.userId === r.userId);
    if (!recipients.some(same)) setRecipients([...recipients, r]);
  };
  const recipientName = (r: Recipient) => (r.kind === 'field' ? `${reg.fields.find((f) => f.id === r.fieldId)?.label ?? '?'} (из записи)`
    : r.kind === 'user' ? (r.name ?? 'сотрудник') : (r.label ?? ''));
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const submit = (e: FormEvent) => { e.preventDefault(); create.mutate(undefined); };

  if (!dates.length && !selects.length && !basisFields.length) {
    return <div className="hint pad">Для правил нужно поле-дата, вычисляемый срок, список или статус основания.</div>;
  }
  return (
    <form className="rule-form" onSubmit={submit} aria-label="Новое правило">
      <label>Условие
        <select className="inp" value={kind} onChange={(e) => { const k = e.target.value as CondKind; setKind(k); setFieldId(''); if (k === 'yearly' && setOption) setEventType('notify'); }} aria-label="Условие">
          {dates.length > 0 && <option value="before">За N дней до даты</option>}
          {dates.length > 0 && <option value="overdue">Дата просрочена</option>}
          {selects.length > 0 && <option value="equals">Поле = значение</option>}
          <option value="yearly">Ежегодно — сводная задача</option>
          {basisFields.length > 0 && <option value="basis_missing">Канал открыт без основания</option>}
        </select>
      </label>
      {kind === 'yearly' ? (
        <label>День
          <span className="row nowrap">
            <input className="inp" type="number" min={1} max={31} value={day} onChange={(e) => setDay(e.target.value)} aria-label="День месяца" />
            <select className="inp" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Месяц">
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          </span>
        </label>
      ) : (
        <label>Поле
          <select className="inp" value={field?.id ?? ''} onChange={(e) => { setFieldId(e.target.value); setOptionId(''); }} aria-label="Поле условия">
            {pool.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </label>
      )}
      {kind === 'before' && (
        <>
          <label>За дней
            <input className="inp" type="number" min={0} max={365} value={days} onChange={(e) => setDays(e.target.value)} aria-label="За сколько дней" />
          </label>
          <label className="check">
            <input type="checkbox" checked={skipYearEnd} onChange={(e) => setSkipYearEnd(e.target.checked)} />
            кроме дат 31.12
          </label>
        </>
      )}
      {kind === 'overdue' && (
        <>
          <label>Просрочка, раб. дн.
            <input className="inp" type="number" min={1} max={365} placeholder="сразу" value={workdays} onChange={(e) => setWorkdays(e.target.value)} aria-label="Рабочих дней просрочки" />
          </label>
          <label>…и пусто поле
            <select className="inp" value={unless} onChange={(e) => setUnless(e.target.value)} aria-label="Если пусто поле">
              <option value="">— не важно</option>
              {fillable.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </label>
        </>
      )}
      {kind === 'equals' && (
        <label>Значение
          <select className="inp" value={option?.id ?? ''} onChange={(e) => setOptionId(e.target.value)} aria-label="Значение условия">
            {field?.options.filter((o) => !o.archived).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </label>
      )}
      {kind === 'yearly' && status && (
        <div className="span-all row">
          <span className="hint">В списке — открытые записи{statusIds.length ? ' со статусом:' : '. Только со статусом:'}</span>
          {status.options.filter((o) => !o.archived).map((o) => (
            <label key={o.id} className="check"><input type="checkbox" checked={statusIds.includes(o.id)} onChange={() => setStatusIds(toggle(statusIds, o.id))} />{o.label}</label>
          ))}
        </div>
      )}
      <label>Действие
        <select className="inp" value={eventType} onChange={(e) => setEventType(e.target.value as typeof eventType)} aria-label="Действие">
          {Object.entries(EVENT_TYPE_NAMES).filter(([k]) => k !== 'set_option' || (kind !== 'yearly' && selects.length > 0)).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>
      {setOption ? (
        <div className="span-all row">
          <label>Поле
            <select className="inp" value={target?.id ?? ''} onChange={(e) => { setSetField(e.target.value); setSetTo(''); setSetFrom([]); }} aria-label="Какое поле изменить">
              {selects.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </label>
          <label>Поставить
            <select className="inp" value={setTo} onChange={(e) => setSetTo(e.target.value)} aria-label="Новое значение">
              {target?.options.filter((o) => !o.archived).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </label>
          <span className="hint">если сейчас:</span>
          {target?.options.filter((o) => !o.archived).map((o) => (
            <label key={o.id} className="check"><input type="checkbox" checked={setFrom.includes(o.id)} onChange={() => setSetFrom(toggle(setFrom, o.id))} />{o.label}</label>
          ))}
        </div>
      ) : (
        <>
          <label>Заголовок задачи
            <input className="inp" placeholder={kind === 'yearly' ? 'Продление разрешений на {год}' : 'по умолчанию — из условия'} value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Заголовок задачи" />
          </label>
          <div className="span-all grid-gap">
            <div className="eyebrow">Кому</div>
            <div className="cover">
              {recipients.map((r, i) => (
                <span key={i} className="chip acc">
                  {recipientName(r)}
                  <button type="button" className="chip-x" aria-label={`Убрать ${recipientName(r)}`} onClick={() => setRecipients(recipients.filter((_, j) => j !== i))}>×</button>
                </span>
              ))}
              {recipients.length === 0 && <span className="hint">Добавьте хотя бы одного получателя</span>}
            </div>
            <div className="row">
              {kind !== 'yearly' && users.map((f) => <button key={f.id} type="button" className="btn sm" onClick={() => addRecipient({ kind: 'field', fieldId: f.id })}>+ {f.label}</button>)}
              {labels.data?.items.map((l) => (
                <button key={l.id} type="button" className="btn sm" title={l.members.length || l.emails.length ? [...l.members.map((m) => m.fullName), ...l.emails].join(', ') : 'У метки пока нет участников — задача будет без ответственного'}
                  onClick={() => addRecipient({ kind: 'label', itemId: l.id, label: l.value })}>+ {l.value}</button>
              ))}
              <select className="inp" value="" aria-label="Сотрудник-получатель"
                onChange={(e) => { const u = people.data?.items.find((x) => x.id === e.target.value); if (u) addRecipient({ kind: 'user', userId: u.id, name: u.fullName }); }}>
                <option value="">+ сотрудник…</option>
                {people.data?.items.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
              </select>
            </div>
            <div className="hint">Кто стоит за меткой — в «Настройки → Справочники → Получатели уведомлений». «Владелец системы» — из справочника «Системы» по полю «Система» записи. {'{год}'} в заголовке — следующий год.</div>
          </div>
        </>
      )}
      <div className="span-all row">
        <button className="btn primary" type="submit" disabled={create.isPending || (!setOption && recipients.length === 0) || (setOption && !setFrom.length) || (kind !== 'yearly' && !field)}>Добавить правило</button>
        <span className="hint">{setOption ? 'Значение ставится автоматически, в истории записи — от имени системы.' : 'Сработавшее правило создаёт задачи получателям; если по той же записи задача ещё открыта — добавляет в неё комментарий.'}</span>
      </div>
    </form>
  );
}

function RuleRow({ reg, rule, canManage }: { reg: RegisterDetail; rule: AutomationRule; canManage: boolean }) {
  const invalidate = [rkeys.rules(reg.id)];
  const toggle = useAction(() => registersApi.updateRule(rule.id, { version: rule.version, enabled: !rule.enabled }), {
    invalidate, success: (r) => (r.enabled ? 'Правило включено' : 'Правило выключено'),
  });
  const archive = useAction(() => registersApi.archiveRule(rule.id, rule.version), { invalidate, success: () => 'Правило в архиве: события сохранены' });
  const remove = useAction(() => registersApi.deleteRule(rule.id, rule.version), { invalidate, success: () => 'Правило удалено' });
  return (
    <tr className={rule.enabled ? undefined : 'archived'}>
      <td><b>Когда</b> {rule.when}{rule.systemKey && <> <span className="chip" title="Правило процедуры (п. 7.4): только включается и выключается">Системное</span></>}</td>
      <td>
        <b>Тогда</b> {rule.then}
        {rule.recipientMissing && (
          <div><span className="chip crit" title="Метки нет в справочнике «Получатели уведомлений»: по ней задачи ставятся без ответственного. Удалите получателя из правила или верните метку">получатель не найден</span></div>
        )}
      </td>
      <td>
        {canManage && (
          <div className="row act">
            <label className="check">
              <input type="checkbox" checked={rule.enabled} disabled={toggle.isPending} onChange={() => toggle.mutate(undefined)} aria-label={`Правило «${rule.when}» включено`} />
              включено
            </label>
            {!rule.systemKey && (
              <>
                <button className="btn ghost sm" type="button" disabled={archive.isPending} onClick={() => archive.mutate(undefined)}>В архив</button>
                <button className="btn ghost sm danger-t" type="button" disabled={remove.isPending} onClick={() => remove.mutate(undefined)}>Удалить</button>
              </>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

/** Журнал событий реестра: новые сверху; каждое событие ведёт к своим задачам. */
function EventLog({ reg }: { reg: RegisterDetail }) {
  const [status, setStatus] = useState<'new' | 'processed' | ''>('');
  const events = useInfiniteQuery({
    queryKey: [...rkeys.events(reg.id), 'log', status],
    queryFn: ({ pageParam }) => registersApi.events(reg.id, { status: status || undefined, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = events.data?.pages.flatMap((p) => p.items) ?? [];
  const total = events.data?.pages[0]?.total ?? 0;
  return (
    <div className="grid-gap">
      <div className="row">
        <div className="eyebrow">События</div>
        <select className="inp sm-inp" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Статус событий">
          <option value="">Все</option>
          <option value="new">Ждут задач</option>
          <option value="processed">Стали задачами</option>
        </select>
        <span className="hint mono">{items.length} из {total}</span>
      </div>
      <div className="tbl-wrap">
        <table className="cat-tbl events-tbl">
          <thead><tr><th>Когда</th><th>Запись</th><th>Событие</th><th>Кому</th><th>Задачи</th></tr></thead>
          <tbody>
            {events.isSuccess && items.length === 0 && <tr><td colSpan={5} className="hint">Событий нет</td></tr>}
            {items.map((e) => (
              <tr key={e.id}>
                <td className="mono">{formatDate(e.fireAt)}</td>
                <td><span className="mono">#{e.recordNumber}</span> {e.recordTitle}</td>
                <td><span className={`chip ${EVENT_TONE[e.eventType] ?? ''}`}>{EVENT_TYPE_NAMES[e.eventType]}</span> {e.when}</td>
                <td>{e.recipients.map((r) => (r.kind === 'user' ? r.name : r.label)).join(', ')}</td>
                <td><EventTasks e={e} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {events.hasNextPage && <button className="btn sm" type="button" onClick={() => void events.fetchNextPage()} disabled={events.isFetchingNextPage}>Показать ещё</button>}
    </div>
  );
}

export function EventTasks({ e }: { e: { status: string; tasks: { id: string; number: number; action: string }[] } }) {
  if (e.status === 'new') return <span className="chip acc">ждёт</span>;
  if (!e.tasks.length) return <span className="hint">запись закрыта или в архиве</span>;
  return (
    <span className="row nowrap">
      {e.tasks.map((t) => (
        <Link key={t.id} to={`/tasks?task=${t.id}`} title={t.action === 'commented' ? 'Добавлен комментарий в открытую задачу' : 'Создана задача'}>
          #{t.number}{t.action === 'commented' ? ' · комментарий' : ''}
        </Link>
      ))}
    </span>
  );
}

export function AutomationTab({ reg, canManage }: { reg: RegisterDetail; canManage: boolean }) {
  const rules = useQuery({ queryKey: rkeys.rules(reg.id), queryFn: () => registersApi.rules(reg.id) });
  const run = useAction(() => registersApi.runRules(reg.id), {
    invalidate: [rkeys.events(reg.id), rkeys.records(reg.id), ['tasks']],
    success: (r) => (r.ran
      ? (r.created || r.tasksCreated || r.tasksCommented
        ? `Событий: ${r.created}, задач создано: ${r.tasksCreated}, дополнено комментарием: ${r.tasksCommented}`
        : 'Новых событий нет')
      : 'Проверка уже идёт — попробуйте через минуту'),
  });
  const items = rules.data?.items ?? [];
  return (
    <div className="panel-b grid-gap">
      <div className="row">
        <span className="hint">Правила проверяются автоматически раз в час и сразу после загрузки отчёта сканера. Повторная проверка дублей не создаёт.</span>
        {canManage && <button className="btn sm" type="button" disabled={run.isPending} onClick={() => run.mutate(undefined)}>Проверить сейчас</button>}
      </div>
      <div className="tbl-wrap">
        <table className="cat-tbl rules-tbl">
          <tbody>
            {rules.isPending && <tr><td className="hint">Загрузка…</td></tr>}
            {rules.isSuccess && items.length === 0 && <tr><td className="hint">Правил пока нет</td></tr>}
            {items.map((r) => <RuleRow key={r.id} reg={reg} rule={r} canManage={canManage} />)}
          </tbody>
        </table>
      </div>
      {canManage && (
        <details className="grid-gap" open={items.length === 0}>
          <summary className="eyebrow">Новое правило</summary>
          <RuleForm reg={reg} />
        </details>
      )}
      <EventLog reg={reg} />
    </div>
  );
}
