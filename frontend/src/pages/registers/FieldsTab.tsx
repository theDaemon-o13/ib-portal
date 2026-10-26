import { useState, type FormEvent } from 'react';
import { registersApi, type CalcRule, type FieldType, type RegisterDetail, type RegisterField } from '../../api/registers';
import { LockIcon } from '../../components/LockIcon';
import { useAction } from '../settings/useAction';
import { ALLOWED_ROLES, describeRule, ROLE_NAMES, TYPE_NAMES, typeTargets } from './logic';
import { rkeys } from './keys';
import { TypeChangeDialog } from './TypeChangeDialog';

const ALL_TYPES = Object.keys(TYPE_NAMES) as FieldType[];

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

function OptionsEditor({ reg, field, canManage }: { reg: RegisterDetail; field: RegisterField; canManage: boolean }) {
  const [editId, setEditId] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [add, setAdd] = useState('');
  const invalidate = [rkeys.detail(reg.id), rkeys.records(reg.id)];
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

function RuleEditorRow({ reg, field, onClose }: { reg: RegisterDetail; field: RegisterField; onClose: () => void }) {
  const [rule, setRule] = useState<CalcRule | null>(field.calcRule);
  const save = useAction(() => registersApi.updateField(field.id, { version: field.version, calcRule: rule ?? undefined }), {
    invalidate: [rkeys.detail(reg.id), rkeys.records(reg.id)], success: () => 'Правило сохранено', onDone: onClose,
  });
  return (
    <div className="grid-gap pad">
      <CalcRuleEditor reg={reg} value={rule} onChange={setRule} selfId={field.id} />
      <div className="row">
        <button className="btn primary sm" type="button" onClick={() => save.mutate(undefined)} disabled={save.isPending || !rule}>Сохранить правило</button>
        <button className="btn sm" type="button" onClick={onClose}>Отмена</button>
      </div>
    </div>
  );
}

export function FieldsTab({ reg, canManage }: { reg: RegisterDetail; canManage: boolean }) {
  const [editId, setEditId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [typeFor, setTypeFor] = useState<RegisterField | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [add, setAdd] = useState<{ label: string; type: FieldType; options: string; role: string; rule: CalcRule | null }>({ label: '', type: 'text', options: '', role: '', rule: null });

  const invalidate = [rkeys.detail(reg.id), rkeys.records(reg.id), rkeys.list];
  const patch = useAction(({ f, body, ok }: { f: RegisterField; body: Omit<Parameters<typeof registersApi.updateField>[1], 'version'>; ok: string }) =>
    registersApi.updateField(f.id, { version: f.version, ...body }).then((r) => ({ r, ok })), {
    invalidate, success: (x) => x.ok, onDone: () => setEditId(null),
  });
  const move = useAction(({ f, dir }: { f: RegisterField; dir: 'up' | 'down' }) => registersApi.moveField(f.id, dir), { invalidate });
  const archive = useAction((f: RegisterField) => (f.archived ? registersApi.restoreField(f.id, f.version) : registersApi.archiveField(f.id, f.version)), {
    invalidate, success: (_r, f) => (f.archived ? `Поле «${f.label}» возвращено` : `Поле «${f.label}» в архиве: значения сохранены`),
  });
  const remove = useAction((f: RegisterField) => registersApi.deleteField(f.id, f.version), {
    invalidate, success: (_r, f) => `Поле «${f.label}» удалено`, onDone: () => setConfirmDel(null),
  });
  const create = useAction(() => registersApi.addField(reg.id, {
    label: add.label,
    type: add.type,
    options: add.type === 'select' || add.type === 'decision' ? add.options.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    analyticsRole: (add.role || null) as 'dimension' | 'metric' | 'date' | 'deadline' | null,
    calcRule: add.type === 'calc' ? (add.rule ?? undefined) : undefined,
  }), {
    invalidate, success: () => `Поле «${add.label}» добавлено — оно уже есть в карточке записи`,
    onDone: () => setAdd({ label: '', type: add.type, options: '', role: '', rule: null }),
  });

  const fields = reg.fields;
  const submitAdd = (e: FormEvent) => { e.preventDefault(); create.mutate(undefined); };

  const summary = (f: RegisterField) => {
    if (f.type === 'calc') return describeRule(reg, f);
    if (f.type === 'user') return 'Справочник сотрудников';
    if (f.type === 'select' || f.type === 'decision') {
      const live = f.options.filter((o) => !o.archived);
      const text = live.map((o) => (o.isClosed ? `${o.label} (закрывает)` : o.label)).join(', ') || 'нет значений';
      return f.type === 'decision' ? `${text} · сохраняется только с документом-основанием` : text;
    }
    return '—';
  };

  return (
    <>
      <div className="tbl-wrap">
        <table className="cat-tbl fields-tbl">
          <thead><tr><th>Поле</th><th>Тип</th><th>Значения / правило</th><th>Для аналитики</th><th /></tr></thead>
          <tbody>
            {fields.map((f, i) => {
              const rows = [];
              if (canManage && editId === f.id) {
                rows.push(
                  // key отличается от строки просмотра: нажатая «Изменить» не превратится в «Сохранить» (урок этапа 2).
                  <tr key={`${f.id}:edit`} className="editing">
                    <td colSpan={4}>
                      <form className="row nowrap" onSubmit={(e) => {
                        e.preventDefault();
                        if (editLabel.trim() === f.label) setEditId(null);
                        else patch.mutate({ f, body: { label: editLabel }, ok: `Поле переименовано: «${editLabel.trim()}». Данные записей не изменились` });
                      }}>
                        <input className="inp" required autoFocus value={editLabel} onChange={(e) => setEditLabel(e.target.value)} aria-label="Название поля" />
                        <button className="btn primary sm" type="submit" disabled={patch.isPending}>Сохранить</button>
                        <button className="btn sm" type="button" onClick={() => setEditId(null)}>Отмена</button>
                      </form>
                    </td>
                    <td />
                  </tr>,
                );
              } else {
                rows.push(
                  <tr key={`${f.id}:view`} className={f.archived ? 'archived' : undefined}>
                    <td>
                      <div className="cv">
                        <b>{f.label}</b>
                        {f.isTitle && <span className="chip acc">Заголовок</span>}
                        {f.isStatus && <span className="chip info">Статус</span>}
                        {f.archived && <span className="chip">В архиве</span>}
                      </div>
                    </td>
                    <td>
                      <span className="type">{TYPE_NAMES[f.type]}</span>
                      {(f.type === 'calc' || f.type === 'decision') && <span className="lock" title="Только для чтения в форме и при импорте"> <LockIcon /></span>}
                    </td>
                    <td className="hint wrap">{summary(f)}</td>
                    <td>
                      {canManage && ALLOWED_ROLES[f.type].length > 0 && !f.archived ? (
                        <select className="inp" value={f.analyticsRole ?? ''} aria-label={`Аналитика для поля ${f.label}`} disabled={patch.isPending}
                          onChange={(e) => patch.mutate({ f, body: { analyticsRole: (e.target.value || null) as 'dimension' | null }, ok: 'Роль для аналитики сохранена' })}>
                          {['', ...ALLOWED_ROLES[f.type]].map((r) => <option key={r} value={r}>{ROLE_NAMES[r]}</option>)}
                        </select>
                      ) : <span className="hint">{ROLE_NAMES[f.analyticsRole ?? '']}</span>}
                    </td>
                    <td>
                      {canManage && confirmDel === f.id ? (
                        <div className="row act" key="confirm">
                          <span className="hint">Удалить поле?</span>
                          <button className="btn sm danger" type="button" onClick={() => remove.mutate(f)} disabled={remove.isPending}>Удалить</button>
                          <button className="btn sm" type="button" onClick={() => setConfirmDel(null)}>Отмена</button>
                        </div>
                      ) : canManage && (
                        <div className="row act wrap-act" key="actions">
                          <button className="btn ghost sm" type="button" aria-label="Выше" disabled={i === 0 || move.isPending} onClick={() => move.mutate({ f, dir: 'up' })}>↑</button>
                          <button className="btn ghost sm" type="button" aria-label="Ниже" disabled={i === fields.length - 1 || move.isPending} onClick={() => move.mutate({ f, dir: 'down' })}>↓</button>
                          <button className="btn ghost sm" type="button" onClick={() => { setEditId(f.id); setEditLabel(f.label); setConfirmDel(null); }}>Изменить</button>
                          {(f.type === 'select' || f.type === 'decision') && (
                            <button className="btn ghost sm" type="button" aria-pressed={openId === f.id} onClick={() => setOpenId(openId === f.id ? null : f.id)}>Значения</button>
                          )}
                          {f.type === 'calc' && (
                            <button className="btn ghost sm" type="button" aria-pressed={openId === f.id} onClick={() => setOpenId(openId === f.id ? null : f.id)}>Правило</button>
                          )}
                          {typeTargets(f.type).length > 0 && !f.isTitle && !f.isStatus && !f.archived && (
                            <button className="btn ghost sm" type="button" onClick={() => setTypeFor(f)}>Сменить тип</button>
                          )}
                          {f.type === 'text' && !f.isTitle && !f.archived && (
                            <button className="btn ghost sm" type="button" onClick={() => patch.mutate({ f, body: { isTitle: true }, ok: `«${f.label}» — заголовок записи` })}>Заголовком</button>
                          )}
                          {f.type === 'select' && !f.archived && (
                            <button className="btn ghost sm" type="button" onClick={() => patch.mutate({ f, body: { isStatus: !f.isStatus }, ok: f.isStatus ? 'Поле больше не статус' : `«${f.label}» — поле статуса` })}>
                              {f.isStatus ? 'Не статус' : 'Статусом'}
                            </button>
                          )}
                          {!f.isTitle && !f.isStatus && (
                            <button className="btn ghost sm" type="button" onClick={() => archive.mutate(f)} disabled={archive.isPending}>{f.archived ? 'Вернуть' : 'В архив'}</button>
                          )}
                          {!f.isTitle && !f.isStatus && (
                            <button className="btn ghost sm danger-t" type="button" onClick={() => { setConfirmDel(f.id); setEditId(null); }}>Удалить</button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>,
                );
              }
              if (openId === f.id) {
                rows.push(
                  <tr key={`${f.id}:open`} className="sub-row">
                    <td colSpan={5}>
                      {f.type === 'calc'
                        ? <RuleEditorRow reg={reg} field={f} onClose={() => setOpenId(null)} />
                        : <OptionsEditor reg={reg} field={f} canManage={canManage} />}
                    </td>
                  </tr>,
                );
              }
              return rows;
            })}
          </tbody>
        </table>
      </div>
      {canManage && (
        <form className="field-form add-field" onSubmit={submitAdd}>
          <label>Название поля<input className="inp" required placeholder="Например: Источник выявления" value={add.label} onChange={(e) => setAdd({ ...add, label: e.target.value })} /></label>
          <label>Тип
            <select className="inp" value={add.type} onChange={(e) => setAdd({ ...add, type: e.target.value as FieldType, role: '', rule: null })}>
              {ALL_TYPES.map((t) => <option key={t} value={t}>{TYPE_NAMES[t]}</option>)}
            </select>
          </label>
          {(add.type === 'select' || add.type === 'decision') && (
            <label>Значения списка (через запятую)
              <input className="inp" required placeholder={add.type === 'decision' ? 'Ожидает решения, Принят, Отклонён' : 'Сканер, Пентест, Аудит'}
                value={add.options} onChange={(e) => setAdd({ ...add, options: e.target.value })} />
            </label>
          )}
          {ALLOWED_ROLES[add.type].length > 0 && (
            <label>Для аналитики
              <select className="inp" value={add.role} onChange={(e) => setAdd({ ...add, role: e.target.value })}>
                {['', ...ALLOWED_ROLES[add.type]].map((r) => <option key={r} value={r}>{ROLE_NAMES[r]}</option>)}
              </select>
            </label>
          )}
          {add.type === 'calc' && <div className="span-all"><CalcRuleEditor reg={reg} value={add.rule} onChange={(rule) => setAdd({ ...add, rule })} /></div>}
          <button className="btn primary" type="submit" disabled={create.isPending}>Добавить поле</button>
        </form>
      )}
      <div className="panel-b">
        <div className="hint">
          Значения записей хранятся по полю, а не по названию: переименование ничего не ломает. Поле с данными нельзя удалить — только отправить в архив.
          Тип поля с данными меняется только в безопасных случаях и после предпросмотра.
        </div>
      </div>
      {typeFor && <TypeChangeDialog key={typeFor.id} reg={reg} field={typeFor} onClose={() => setTypeFor(null)} />}
    </>
  );
}
