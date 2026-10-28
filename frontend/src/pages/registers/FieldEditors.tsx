import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { registersApi, type BasisRule, type DueRule, type FieldSettings, type RegisterDetail, type RegisterField } from '../../api/registers';
import { useAction } from '../settings/useAction';
import { rkeys } from './keys';

/** Правило вычисляемого поля: дата + срок в днях по значению списка, с переопределением датой. */
export function CalcRuleEditor({ reg, value, onChange, selfId }: { reg: RegisterDetail; value: DueRule | null; onChange: (r: DueRule | null) => void; selfId?: string }) {
  const live = reg.fields.filter((f) => !f.archived && f.id !== selfId);
  const dates = live.filter((f) => f.type === 'date');
  const selects = live.filter((f) => f.type === 'select');
  const rule: DueRule = value ?? { fromFieldId: dates[0]?.id ?? '', byFieldId: selects[0]?.id ?? '', days: {}, overrideFieldId: null };
  const by = selects.find((f) => f.id === rule.byFieldId);
  const set = (patch: Partial<DueRule>) => onChange({ ...rule, ...patch });
  const fillable = live.filter((f) => f.type !== 'calc' && f.type !== 'decision');
  if (!dates.length || !selects.length) {
    return <div className="hint">Для вычисляемого поля нужны поле-дата и поле-список в этом реестре.</div>;
  }
  return (
    <div className="calc-editor">
      <label>От даты
        <select className="inp" value={rule.fromFieldId} onChange={(e) => set({ fromFieldId: e.target.value })} aria-label="Поле-дата">
          {dates.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
      </label>
      <label>Срок по значению
        <select className="inp" value={rule.byFieldId} onChange={(e) => set({ byFieldId: e.target.value, days: {} })} aria-label="Поле-список">
          {selects.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
      </label>
      <label>Если задано, берётся
        <select className="inp" value={rule.overrideFieldId ?? ''} onChange={(e) => set({ overrideFieldId: e.target.value || null })} aria-label="Переопределение">
          <option value="">— не переопределяется</option>
          {dates.filter((f) => f.id !== rule.fromFieldId).map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
      </label>
      {rule.overrideFieldId && (
        <label>…только если заполнено
          <select className="inp" value={rule.overrideWhenFilledFieldId ?? ''} onChange={(e) => set({ overrideWhenFilledFieldId: e.target.value || null })} aria-label="Условие переопределения">
            <option value="">— без условия</option>
            {fillable.filter((f) => f.id !== rule.overrideFieldId).map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </label>
      )}
      <label className="check">
        <input type="checkbox" checked={!!rule.shiftToWorkday} onChange={(e) => set({ shiftToWorkday: e.target.checked })} />
        Срок на выходной или праздник — перенос на рабочий день
      </label>
      <div className="calc-days">
        {by?.options.filter((o) => !o.archived).map((o) => (
          <label key={o.id}>{o.label}, дн.
            <input className="inp" type="number" min={0} max={3650} value={rule.days[o.id] ?? ''} aria-label={`Дней: ${o.label}`}
              onChange={(e) => {
                const rest = Object.fromEntries(Object.entries(rule.days).filter(([k]) => k !== o.id));
                set({ days: e.target.value === '' ? (rest as Record<string, number>) : { ...rest, [o.id]: Math.max(0, Math.trunc(Number(e.target.value))) } });
              }} />
          </label>
        ))}
      </div>
    </div>
  );
}

export function OptionsEditor({ reg, field, canManage }: { reg: RegisterDetail; field: RegisterField; canManage: boolean }) {
  const [editId, setEditId] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [add, setAdd] = useState('');
  const invalidate = [rkeys.detail(reg.id), rkeys.records(reg.id), rkeys.analytics(reg.id)];
  const rename = useAction(({ id, version }: { id: string; version: number }) => registersApi.updateOption(id, { version, label }), {
    invalidate, success: () => 'Значение переименовано: записи сохранили ссылку на него', onDone: () => setEditId(null),
  });
  const closed = useAction(({ id, version, isClosed }: { id: string; version: number; isClosed: boolean }) => registersApi.updateOption(id, { version, isClosed }), {
    invalidate, success: (_r, a) => (a.isClosed ? 'Значение закрывает запись' : 'Значение больше не закрывает запись'),
  });
  const move = useAction(({ id, dir }: { id: string; dir: 'up' | 'down' }) => registersApi.moveOption(id, dir), { invalidate });
  const archive = useAction(({ id, version, archived }: { id: string; version: number; archived: boolean }) =>
    (archived ? registersApi.restoreOption(id, version) : registersApi.archiveOption(id, version)), {
    invalidate, success: (_r, a) => (a.archived ? 'Значение снова доступно' : 'Значение в архиве: записи его сохранят'),
  });
  const remove = useAction(({ id, version }: { id: string; version: number }) => registersApi.deleteOption(id, version), {
    invalidate, success: () => 'Значение удалено',
  });
  const create = useAction(() => registersApi.addOption(field.id, add), { invalidate, success: () => 'Значение добавлено', onDone: () => setAdd('') });
  const opts = field.options;
  return (
    <div className="options-editor">
      <table className="cat-tbl">
        <tbody>
          {opts.map((o, i) => canManage && editId === o.id ? (
            <tr key={`${o.id}:edit`} className="editing">
              <td colSpan={field.isStatus ? 2 : 1}>
                <form className="row nowrap" onSubmit={(e) => { e.preventDefault(); if (label.trim() === o.label) setEditId(null); else rename.mutate({ id: o.id, version: o.version }); }}>
                  <input className="inp" required autoFocus value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Значение списка" />
                  <button className="btn primary sm" type="submit" disabled={rename.isPending}>Сохранить</button>
                  <button className="btn sm" type="button" onClick={() => setEditId(null)}>Отмена</button>
                </form>
              </td>
              <td />
            </tr>
          ) : (
            <tr key={`${o.id}:view`} className={o.archived ? 'archived' : undefined}>
              <td><div className="cv"><b>{o.label}</b>{o.archived && <span className="chip">В архиве</span>}</div></td>
              {field.isStatus && (
                <td>
                  <label className="check">
                    <input type="checkbox" checked={o.isClosed} disabled={!canManage || closed.isPending || !!o.systemKey}
                      onChange={(e) => closed.mutate({ id: o.id, version: o.version, isClosed: e.target.checked })} aria-label={`«${o.label}» закрывает запись`} />
                    закрывает запись
                  </label>
                </td>
              )}
              <td>
                {canManage && (
                  <div className="row act" key="actions">
                    <button className="btn ghost sm" type="button" aria-label="Выше" disabled={i === 0 || move.isPending} onClick={() => move.mutate({ id: o.id, dir: 'up' })}>↑</button>
                    <button className="btn ghost sm" type="button" aria-label="Ниже" disabled={i === opts.length - 1 || move.isPending} onClick={() => move.mutate({ id: o.id, dir: 'down' })}>↓</button>
                    <button className="btn ghost sm" type="button" onClick={() => { setEditId(o.id); setLabel(o.label); }}>Изменить</button>
                    {o.systemKey ? <span className="hint" title="На значении держится формула или статус системного реестра">системное</span> : (
                      <>
                        <button className="btn ghost sm" type="button" onClick={() => archive.mutate({ id: o.id, version: o.version, archived: o.archived })} disabled={archive.isPending}>{o.archived ? 'Вернуть' : 'В архив'}</button>
                        <button className="btn ghost sm danger-t" type="button" onClick={() => remove.mutate({ id: o.id, version: o.version })} disabled={remove.isPending}>Удалить</button>
                      </>
                    )}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {canManage && (
        <form className="row nowrap pad" onSubmit={(e) => { e.preventDefault(); create.mutate(undefined); }}>
          <input className="inp" required placeholder="Новое значение" value={add} onChange={(e) => setAdd(e.target.value)} aria-label={`Новое значение поля «${field.label}»`} />
          <button className="btn sm" type="submit" disabled={create.isPending}>Добавить значение</button>
        </form>
      )}
      {field.type === 'decision' && <div className="hint pad">Первое значение показывается, пока решения нет. Решение вносится только с документом-основанием.</div>}
    </div>
  );
}

/**
 * Статус основания (сверка с DLP, этап 8б): канал этой записи и разрешения другого реестра, которые ссылаются
 * на неё полем «Связь с записью». Вид разрешения, «действующие» статусы, «Действует до» и номер — из того реестра.
 */
export function BasisRuleEditor({ reg, value, onChange, selfId }: { reg: RegisterDetail; value: BasisRule | null; onChange: (r: BasisRule | null) => void; selfId?: string }) {
  const regs = useQuery({ queryKey: rkeys.listWith(false), queryFn: () => registersApi.list(false) });
  const channels = reg.fields.filter((f) => !f.archived && f.type === 'select' && f.id !== selfId);
  const sourceId = value?.sourceRegisterId ?? '';
  const src = useQuery({ queryKey: rkeys.detail(sourceId), queryFn: () => registersApi.get(sourceId), enabled: !!sourceId });
  const sf = (src.data?.fields ?? []).filter((f) => !f.archived);
  const status = sf.find((f) => f.isStatus);
  const rule: BasisRule = value ?? {
    kind: 'link_basis', channelFieldId: channels[0]?.id ?? '', closedOptionIds: [], sourceRegisterId: '', linkFieldId: '', kindFieldId: null,
    kindOptionIds: [], statusFieldId: '', activeOptionIds: [], untilFieldId: null, numberFieldId: null,
  };
  const set = (patch: Partial<BasisRule>) => onChange({ ...rule, ...patch });
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const channel = channels.find((f) => f.id === rule.channelFieldId);
  const kind = sf.find((f) => f.id === rule.kindFieldId);
  // Выбрали реестр разрешений — подставить поля по типам.
  useEffect(() => {
    if (!src.data || rule.linkFieldId) return;
    set({
      linkFieldId: sf.find((f) => f.type === 'link' && f.linkRegisterId === reg.id)?.id ?? '',
      statusFieldId: status?.id ?? '',
      untilFieldId: sf.find((f) => f.type === 'date' && f.analyticsRole === 'deadline')?.id ?? null,
      numberFieldId: sf.find((f) => f.type === 'text' && f.label.trim().startsWith('№'))?.id ?? null,
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- только при загрузке реестра-источника
  }, [src.data]);
  if (!channels.length) return <div className="hint">Нужно поле-список канала доступа в этом реестре.</div>;
  return (
    <div className="calc-editor">
      <label>Канал (в этом реестре)
        <select className="inp" value={rule.channelFieldId} onChange={(e) => set({ channelFieldId: e.target.value, closedOptionIds: [] })} aria-label="Поле канала">
          {channels.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
      </label>
      <div className="row"><span className="hint">Канал закрыт, если:</span>
        {channel?.options.filter((o) => !o.archived).map((o) => (
          <label key={o.id} className="check"><input type="checkbox" checked={rule.closedOptionIds.includes(o.id)} onChange={() => set({ closedOptionIds: toggle(rule.closedOptionIds, o.id) })} />{o.label}</label>
        ))}
      </div>
      <label>Реестр разрешений
        <select className="inp" value={rule.sourceRegisterId} onChange={(e) => set({ sourceRegisterId: e.target.value, linkFieldId: '', kindFieldId: null, kindOptionIds: [], activeOptionIds: [] })} aria-label="Реестр разрешений">
          <option value="">— выберите</option>
          {regs.data?.items.filter((r) => r.id !== reg.id).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </label>
      {src.data && (
        <>
          <label>Связь с этим реестром
            <select className="inp" value={rule.linkFieldId} onChange={(e) => set({ linkFieldId: e.target.value })} aria-label="Поле связи">
              <option value="">— выберите</option>
              {sf.filter((f) => f.type === 'link' && f.linkRegisterId === reg.id).map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </label>
          <label>Вид разрешения
            <select className="inp" value={rule.kindFieldId ?? ''} onChange={(e) => set({ kindFieldId: e.target.value || null, kindOptionIds: [] })} aria-label="Поле вида">
              <option value="">— любой</option>
              {sf.filter((f) => f.type === 'select' && !f.isStatus).map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </label>
          {kind && (
            <div className="row"><span className="hint">Подходит каналу:</span>
              {kind.options.filter((o) => !o.archived).map((o) => (
                <label key={o.id} className="check"><input type="checkbox" checked={rule.kindOptionIds.includes(o.id)} onChange={() => set({ kindOptionIds: toggle(rule.kindOptionIds, o.id) })} />{o.label}</label>
              ))}
            </div>
          )}
          {status && (
            <div className="row"><span className="hint">«{status.label}» действует, если:</span>
              {status.options.filter((o) => !o.archived).map((o) => (
                <label key={o.id} className="check"><input type="checkbox" checked={rule.activeOptionIds.includes(o.id)} onChange={() => set({ statusFieldId: status.id, activeOptionIds: toggle(rule.activeOptionIds, o.id) })} />{o.label}</label>
              ))}
            </div>
          )}
          <label>Действует до
            <select className="inp" value={rule.untilFieldId ?? ''} onChange={(e) => set({ untilFieldId: e.target.value || null })} aria-label="Поле срока">
              <option value="">— бессрочно</option>
              {sf.filter((f) => f.type === 'date').map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </label>
          <label>Номер документа
            <select className="inp" value={rule.numberFieldId ?? ''} onChange={(e) => set({ numberFieldId: e.target.value || null })} aria-label="Поле номера">
              <option value="">— номер записи</option>
              {sf.filter((f) => f.type === 'text').map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </label>
        </>
      )}
    </div>
  );
}

/**
 * Фиксация при статусах (любое поле, кроме вычисляемого, решения и статуса) и ограничения даты.
 * Ослабить фиксацию для статуса, который уже есть у записей, сервер не даст.
 */
export function SettingsEditor({ reg, field, onSave, pending }: { reg: RegisterDetail; field: RegisterField; onSave: (s: FieldSettings | null) => void; pending: boolean }) {
  const status = reg.fields.find((f) => f.isStatus && !f.archived);
  const [lockIds, setLockIds] = useState<string[]>(field.settings.lock?.statusOptionIds ?? []);
  const [mode, setMode] = useState<'locked' | 'reason'>(field.settings.lock?.mode ?? 'locked');
  const [anchor, setAnchor] = useState(field.settings.date?.notAfterYearEndOfFieldId ?? '');
  const [endOfYear, setEndOfYear] = useState(!!field.settings.date?.defaultEndOfYear);
  const [multiline, setMultiline] = useState(!!field.settings.text?.multiline);
  const lockable = field.type !== 'calc' && field.type !== 'decision' && !field.isStatus && !!status;
  const dates = reg.fields.filter((f) => !f.archived && f.type === 'date' && f.id !== field.id);
  const toggle = (id: string) => setLockIds(lockIds.includes(id) ? lockIds.filter((x) => x !== id) : [...lockIds, id]);
  const settings: FieldSettings = {
    ...(lockIds.length ? { lock: { statusOptionIds: lockIds, mode } } : {}),
    ...(field.type === 'date' && (anchor || endOfYear) ? { date: { notAfterYearEndOfFieldId: anchor || null, defaultEndOfYear: endOfYear } } : {}),
    ...(field.type === 'text' && multiline ? { text: { multiline: true } } : {}),
  };
  if (!lockable && field.type !== 'date' && field.type !== 'text') return <div className="hint">{status ? 'Это поле не фиксируется.' : 'Фиксация задаётся по значениям поля статуса — в реестре его нет.'}</div>;
  return (
    <div className="grid-gap">
      {lockable && (
        <>
          <div className="row"><span className="hint">Фиксировать при статусах:</span>
            {status?.options.filter((o) => !o.archived || lockIds.includes(o.id)).map((o) => (
              <label key={o.id} className="check"><input type="checkbox" checked={lockIds.includes(o.id)} onChange={() => toggle(o.id)} />{o.label}</label>
            ))}
          </div>
          {lockIds.length > 0 && (
            <label className="fd-label">Режим
              <select className="inp" value={mode} onChange={(e) => setMode(e.target.value as 'locked' | 'reason')}>
                <option value="locked">Не меняется — только новой записью</option>
                <option value="reason">Меняется только с причиной</option>
              </select>
            </label>
          )}
        </>
      )}
      {field.type === 'date' && (
        <>
          <label className="fd-label">Не позже 31.12 года поля
            <select className="inp" value={anchor} onChange={(e) => setAnchor(e.target.value)}>
              <option value="">— без ограничения</option>
              {dates.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </label>
          <label className="check"><input type="checkbox" checked={endOfYear} onChange={(e) => setEndOfYear(e.target.checked)} />По умолчанию — 31.12 текущего года</label>
        </>
      )}
      {field.type === 'text' && (
        <label className="check">
          <input type="checkbox" checked={multiline} onChange={(e) => setMultiline(e.target.checked)} />
          Многострочный текст — в карточке поле от 6 строк, до 20 000 символов вместо 4000
        </label>
      )}
      <div className="row">
        <button className="btn primary sm" type="button" disabled={pending} onClick={() => onSave(Object.keys(settings).length ? settings : null)}>Сохранить</button>
        {lockable && <span className="hint">Пока статус записи фиксирующий, запись не удаляется, а статус меняется только на другой фиксирующий.</span>}
      </div>
    </div>
  );
}
