import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent, type MouseEvent } from 'react';
import { settingsApi } from '../../api/settings';
import { registersApi, type BasisRule, type DueRule, type FieldType, type RegisterDetail, type RegisterField } from '../../api/registers';
import { LockIcon } from '../../components/LockIcon';
import { useAction } from '../settings/useAction';
import { FieldDrawer } from './FieldDrawer';
import { BasisRuleEditor, CalcRuleEditor } from './FieldEditors';
import { ALLOWED_ROLES, describeRule, ROLE_NAMES, TYPE_NAMES } from './logic';
import { rkeys } from './keys';

const ALL_TYPES = Object.keys(TYPE_NAMES) as FieldType[];

/** Щелчок по списку или стрелкам не открывает панель поля. */
const stop = (e: MouseEvent) => e.stopPropagation();

export function FieldsTab({ reg, canManage }: { reg: RegisterDetail; canManage: boolean }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [add, setAdd] = useState<{ label: string; type: FieldType; options: string; role: string; rule: DueRule | null; catalogCode: string; linkRegisterId: string; basis: BasisRule | null; calcKind: 'due' | 'basis' }>(
    { label: '', type: 'text', options: '', role: '', rule: null, catalogCode: '', linkRegisterId: '', basis: null, calcKind: 'due' });
  const regs = useQuery({ queryKey: rkeys.listWith(false), queryFn: () => registersApi.list(false) });
  const regName = (id: string | null) => regs.data?.items.find((r) => r.id === id)?.name ?? 'реестр';
  // Для «Значения справочника» — обычные справочники значений (не статусы, правила почты и метки получателей).
  const catalogs = useQuery({ queryKey: ['settings', 'catalogs'], queryFn: settingsApi.catalogs });
  const fieldCatalogs = (catalogs.data?.items ?? []).filter((c) => c.kind === 'values' && c.code !== 'notify_recipients');
  const catalogName = (code: string | null) => catalogs.data?.items.find((c) => c.code === code)?.name ?? code ?? '';

  const invalidate = [rkeys.detail(reg.id), rkeys.records(reg.id), rkeys.list, rkeys.analytics(reg.id)];
  const setRole = useAction(({ f, role }: { f: RegisterField; role: string }) =>
    registersApi.updateField(f.id, { version: f.version, analyticsRole: (role || null) as 'dimension' | null }), {
    invalidate, success: () => 'Роль для аналитики сохранена',
  });
  const move = useAction(({ f, dir }: { f: RegisterField; dir: 'up' | 'down' }) => registersApi.moveField(f.id, dir), { invalidate });
  const create = useAction(() => registersApi.addField(reg.id, {
    label: add.label,
    type: add.type,
    options: add.type === 'select' || add.type === 'decision' ? add.options.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    analyticsRole: (add.role || null) as 'dimension' | 'metric' | 'date' | 'deadline' | null,
    calcRule: add.type === 'calc' ? ((add.calcKind === 'basis' ? add.basis : add.rule) ?? undefined) : undefined,
    catalogCode: add.type === 'catalog' ? add.catalogCode : undefined,
    linkRegisterId: add.type === 'link' ? add.linkRegisterId : undefined,
  }), {
    invalidate, success: () => `Поле «${add.label}» добавлено — оно уже есть в карточке записи`,
    onDone: () => setAdd({ ...add, label: '', options: '', role: '', rule: null, basis: null }),
  });

  const fields = reg.fields;
  const summary = (f: RegisterField) => {
    if (f.type === 'calc') return describeRule(reg, f);
    if (f.type === 'file') return 'Файлы по правилам хранения портала · sha256 и дата загрузки в карточке';
    if (f.type === 'link') return `Записи реестра «${regName(f.linkRegisterId)}»`;
    if (f.type === 'user') return 'Справочник сотрудников';
    if (f.type === 'catalog') return `Справочник «${catalogName(f.catalogCode)}» · значения правятся в настройках`;
    if (f.type === 'select' || f.type === 'decision') {
      const live = f.options.filter((o) => !o.archived);
      const text = live.map((o) => (o.isClosed ? `${o.label} (закрывает)` : o.label)).join(', ') || 'нет значений';
      return f.type === 'decision' ? `${text} · сохраняется только с документом-основанием` : text;
    }
    return '—';
  };
  const submitAdd = (e: FormEvent) => { e.preventDefault(); create.mutate(undefined); };

  return (
    <>
      <div className="tbl-wrap">
        <table className="cat-tbl fields-tbl">
          <colgroup>
            <col className="c-label" /><col className="c-type" /><col className="c-values" /><col className="c-role" />{canManage && <col className="c-order" />}
          </colgroup>
          <thead><tr><th>Поле</th><th>Тип</th><th>Значения / правило</th><th>Для аналитики</th>{canManage && <th aria-label="Порядок" />}</tr></thead>
          <tbody>
            {fields.map((f, i) => {
              const roles = ALLOWED_ROLES[f.type];
              return (
                <tr key={f.id} className={`field-row${f.archived ? ' archived' : ''}`} tabIndex={canManage ? 0 : undefined}
                  title={canManage ? 'Открыть настройки поля' : undefined}
                  onClick={canManage ? () => setOpenId(f.id) : undefined}
                  onKeyDown={canManage ? (e) => { if (e.key === 'Enter') setOpenId(f.id); } : undefined}>
                  <td>
                    <div className="cv">
                      <b>{f.label}</b>
                      {f.isTitle && <span className="chip acc">Заголовок</span>}
                      {f.isStatus && <span className="chip info">Статус</span>}
                      {f.archived && <span className="chip">В архиве</span>}
                      {f.systemKey && <span className="chip" title="Системное поле: переименовать можно, удалить и сменить тип — нет">Системное</span>}
                    </div>
                  </td>
                  <td>
                    <span className="type">{TYPE_NAMES[f.type]}</span>
                    {(f.type === 'calc' || f.type === 'decision') && <span className="lock" title="Только для чтения в форме и при импорте"> <LockIcon /></span>}
                    {f.settings.lock && <span className="chip" title={f.settings.lock.mode === 'reason' ? 'При фиксирующих статусах меняется только с причиной' : 'При фиксирующих статусах не меняется'}>{f.settings.lock.mode === 'reason' ? 'с причиной' : 'фиксируется'}</span>}
                  </td>
                  <td className="hint values-cell">{summary(f)}</td>
                  <td onClick={stop}>
                    {/* Список есть в каждой строке; если ролей для типа нет — неактивный «Не используется». */}
                    <select className="inp role-select" value={f.analyticsRole ?? ''} aria-label={`Аналитика для поля ${f.label}`}
                      disabled={!canManage || roles.length === 0 || f.archived || setRole.isPending}
                      onChange={(e) => setRole.mutate({ f, role: e.target.value })}>
                      {['', ...roles].map((r) => <option key={r} value={r}>{ROLE_NAMES[r]}</option>)}
                    </select>
                  </td>
                  {canManage && (
                    <td onClick={stop}>
                      <div className="row nowrap order-btns">
                        <button className="btn ghost sm" type="button" aria-label={`Поле «${f.label}» выше`} disabled={i === 0 || move.isPending} onClick={() => move.mutate({ f, dir: 'up' })}>↑</button>
                        <button className="btn ghost sm" type="button" aria-label={`Поле «${f.label}» ниже`} disabled={i === fields.length - 1 || move.isPending} onClick={() => move.mutate({ f, dir: 'down' })}>↓</button>
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {canManage && (
        <form className="field-form add-field" onSubmit={submitAdd}>
          <label>Название поля<input className="inp" required placeholder="Например: Источник выявления" value={add.label} onChange={(e) => setAdd({ ...add, label: e.target.value })} /></label>
          <label>Тип
            <select className="inp" value={add.type} onChange={(e) => {
              const type = e.target.value as FieldType;
              setAdd({ ...add, type, role: '', rule: null, catalogCode: type === 'catalog' ? (add.catalogCode || fieldCatalogs.find((c) => c.code === 'systems')?.code || '') : '' });
            }}>
              {ALL_TYPES.map((t) => <option key={t} value={t}>{TYPE_NAMES[t]}</option>)}
            </select>
          </label>
          {add.type === 'link' ? (
            <label>Ссылается на реестр
              <select className="inp" required value={add.linkRegisterId} onChange={(e) => setAdd({ ...add, linkRegisterId: e.target.value })}>
                <option value="">— выберите</option>
                {regs.data?.items.filter((r) => r.id !== reg.id).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </label>
          ) : add.type === 'calc' ? (
            <label>Что считать
              <select className="inp" value={add.calcKind} onChange={(e) => setAdd({ ...add, calcKind: e.target.value as 'due' | 'basis', role: '' })}>
                <option value="due">Срок (дата + дни)</option>
                <option value="basis">Статус основания (сверка с разрешениями)</option>
              </select>
            </label>
          ) : add.type === 'catalog' ? (
            <label>Справочник
              <select className="inp" required value={add.catalogCode} onChange={(e) => setAdd({ ...add, catalogCode: e.target.value })}>
                <option value="">— выберите</option>
                {fieldCatalogs.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
              </select>
            </label>
          ) : (
          <label>Значения списка (через запятую)
            <input className="inp" placeholder={add.type === 'decision' ? 'Ожидает решения, Принят, Отклонён' : 'Сканер, Пентест, Аудит, ДИКТ'}
              disabled={add.type !== 'select' && add.type !== 'decision'} required={add.type === 'select' || add.type === 'decision'}
              value={add.options} onChange={(e) => setAdd({ ...add, options: e.target.value })} />
          </label>
          )}
          <label>Для аналитики
            <select className="inp" value={add.role} disabled={ALLOWED_ROLES[add.type].length === 0 || (add.type === 'calc' && add.calcKind === 'basis')} onChange={(e) => setAdd({ ...add, role: e.target.value })}>
              {['', ...ALLOWED_ROLES[add.type]].map((r) => <option key={r} value={r}>{ROLE_NAMES[r]}</option>)}
            </select>
          </label>
          <button className="btn primary" type="submit" disabled={create.isPending}>Добавить поле</button>
          {add.type === 'calc' && add.calcKind === 'due' && <div className="span-all"><CalcRuleEditor reg={reg} value={add.rule} onChange={(rule) => setAdd({ ...add, rule })} /></div>}
          {add.type === 'calc' && add.calcKind === 'basis' && <div className="span-all"><BasisRuleEditor reg={reg} value={add.basis} onChange={(basis) => setAdd({ ...add, basis })} /></div>}
        </form>
      )}
      {canManage && (
        <div className="panel-b">
          <div className="hint">Щелчок по полю открывает его настройки: название, тип, значения списка, заголовок и статус, архив и удаление. Значения записей хранятся по полю, а не по названию: переименование ничего не ломает.</div>
        </div>
      )}
      {openId && <FieldDrawer key={openId} reg={reg} fieldId={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}
