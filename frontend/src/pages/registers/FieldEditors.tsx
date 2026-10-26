import { useState } from 'react';
import { registersApi, type CalcRule, type RegisterDetail, type RegisterField } from '../../api/registers';
import { useAction } from '../settings/useAction';
import { rkeys } from './keys';

/** Правило вычисляемого поля: дата + срок в днях по значению списка, с переопределением датой. */
export function CalcRuleEditor({ reg, value, onChange, selfId }: { reg: RegisterDetail; value: CalcRule | null; onChange: (r: CalcRule | null) => void; selfId?: string }) {
  const live = reg.fields.filter((f) => !f.archived && f.id !== selfId);
  const dates = live.filter((f) => f.type === 'date');
  const selects = live.filter((f) => f.type === 'select');
  const rule: CalcRule = value ?? { fromFieldId: dates[0]?.id ?? '', byFieldId: selects[0]?.id ?? '', days: {}, overrideFieldId: null };
  const by = selects.find((f) => f.id === rule.byFieldId);
  const set = (patch: Partial<CalcRule>) => onChange({ ...rule, ...patch });
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
      <div className="calc-days">
        {by?.options.filter((o) => !o.archived).map((o) => (
          <label key={o.id}>{o.label}, дн.
            <input className="inp" type="number" min={0} max={3650} value={rule.days[o.id] ?? ''} aria-label={`Дней: ${o.label}`}
              onChange={(e) => {
                const rest = Object.fromEntries(Object.entries(rule.days).filter(([k]) => k !== o.id));
                set({ days: e.target.value === '' ? rest : { ...rest, [o.id]: Math.max(0, Math.trunc(Number(e.target.value))) } });
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
                    <input type="checkbox" checked={o.isClosed} disabled={!canManage || closed.isPending}
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
                    <button className="btn ghost sm" type="button" onClick={() => archive.mutate({ id: o.id, version: o.version, archived: o.archived })} disabled={archive.isPending}>{o.archived ? 'Вернуть' : 'В архив'}</button>
                    <button className="btn ghost sm danger-t" type="button" onClick={() => remove.mutate({ id: o.id, version: o.version })} disabled={remove.isPending}>Удалить</button>
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
