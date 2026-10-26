import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Navigate, NavLink, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import type { Me } from '../../api/client';
import { registersApi, type RegisterDetail } from '../../api/registers';
import { useAction } from '../settings/useAction';
import { FieldsTab } from './FieldsTab';
import { RecordsTab } from './RecordsTab';
import { rkeys } from './keys';

const TABS = [
  { key: 'records', title: 'Записи' },
  { key: 'fields', title: 'Поля' },
] as const;

function RegisterHeader({ reg, canManage }: { reg: RegisterDetail; canManage: boolean }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(reg.name);
  const invalidate = [rkeys.list, rkeys.detail(reg.id)];
  const rename = useAction(() => registersApi.update(reg.id, { version: reg.version, name }), {
    invalidate, success: (r) => `Реестр переименован: «${r.name}»`, onDone: () => setEditing(false),
  });
  const archive = useAction(() => (reg.archived ? registersApi.restore(reg.id, reg.version) : registersApi.archive(reg.id, reg.version)), {
    invalidate,
    success: (r) => (r.archived ? `«${r.name}» в архиве: изменения недоступны, данные сохранены` : `«${r.name}» снова доступен`),
  });
  if (editing) {
    return (
      <form className="row nowrap" onSubmit={(e) => { e.preventDefault(); if (name.trim() === reg.name) setEditing(false); else rename.mutate(undefined); }}>
        <input className="inp" required autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label="Название реестра" />
        <button className="btn primary sm" type="submit" disabled={rename.isPending}>Сохранить</button>
        <button className="btn sm" type="button" onClick={() => { setEditing(false); setName(reg.name); }}>Отмена</button>
      </form>
    );
  }
  return (
    <div className="row">
      <h3 className="reg-title">{reg.name}</h3>
      {reg.archived && <span className="chip">В архиве</span>}
      {canManage && (
        <>
          <button key="rename" className="btn ghost sm" type="button" onClick={() => { setName(reg.name); setEditing(true); }}>Переименовать</button>
          <button key="archive" className="btn ghost sm" type="button" onClick={() => archive.mutate(undefined)} disabled={archive.isPending}>
            {reg.archived ? 'Вернуть из архива' : 'В архив'}
          </button>
        </>
      )}
    </div>
  );
}

export function RegistersPage() {
  const me = useOutletContext<Me>();
  const { registerId, tab } = useParams();
  const navigate = useNavigate();
  const canManage = me.permissions.includes('registers.manage');
  const [showArchived, setShowArchived] = useState(false);
  const [newName, setNewName] = useState('');
  const list = useQuery({ queryKey: rkeys.listWith(showArchived), queryFn: () => registersApi.list(showArchived) });
  const detail = useQuery({ queryKey: rkeys.detail(registerId ?? ''), queryFn: () => registersApi.get(registerId ?? ''), enabled: !!registerId });
  const create = useAction(() => registersApi.create({ name: newName }), {
    invalidate: [rkeys.list],
    success: (r) => `Реестр «${r.name}» создан`,
    onDone: (r) => { setNewName(''); navigate(`/registers/${r.id}/fields`); },
  });

  const items = list.data?.items ?? [];
  if (!registerId && items[0]) return <Navigate to={`/registers/${items[0].id}/records`} replace />;
  if (registerId && !TABS.some((t) => t.key === tab)) return <Navigate to={`/registers/${registerId}/records`} replace />;
  const reg = detail.data;
  const recordsMode = tab === 'records';
  const submitNew = (e: FormEvent) => { e.preventDefault(); create.mutate(undefined); };

  return (
    <>
      <div className="head">
        <div>
          <h1>Конструктор реестров</h1>
          <p>Реестр собирается из полей. Форма карточки записи строится по полям: новое поле сразу появляется в карточке. Выгрузка в Excel и обратная загрузка обновляют записи по колонке ID.</p>
        </div>
      </div>
      <div className={`split reg-split${recordsMode ? ' rec-mode' : ''}`}>
        {!recordsMode && (
          <div className="panel">
            <div className="panel-h"><h3>Реестры</h3></div>
            <div className="reglist">
              {items.map((r) => (
                <button key={r.id} type="button" aria-pressed={r.id === registerId} onClick={() => navigate(`/registers/${r.id}/${tab ?? 'records'}`)}>
                  <b>{r.name}{r.archived ? ' (архив)' : ''}</b>
                  <small>{r.fieldCount} полей · {r.recordCount} записей</small>
                </button>
              ))}
              {list.isSuccess && items.length === 0 && <div className="hint pad">Реестров пока нет</div>}
            </div>
            <div className="panel-b grid-gap">
              <label className="check"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Показать архивные</label>
              {canManage && (
                <form className="grid-gap" onSubmit={submitNew}>
                  <input className="inp" required placeholder="Новый реестр, например: Реестр доступов" value={newName} onChange={(e) => setNewName(e.target.value)} aria-label="Название нового реестра" />
                  <button className="btn sm" type="submit" disabled={create.isPending}>Создать реестр</button>
                </form>
              )}
            </div>
          </div>
        )}
        <div className="panel min0">
          <div className="panel-h">
            {reg ? <RegisterHeader key={`${reg.id}:${reg.version}`} reg={reg} canManage={canManage} /> : <h3>{detail.isError ? 'Реестр не найден' : 'Загрузка…'}</h3>}
            {recordsMode && items.length > 1 && (
              <select className="inp reg-switch" value={registerId} onChange={(e) => navigate(`/registers/${e.target.value}/records`)} aria-label="Другой реестр">
                {items.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            )}
          </div>
          <div className="tabs" role="tablist">
            {TABS.map((t) => (
              <NavLink key={t.key} to={`/registers/${registerId}/${t.key}`} role="tab" aria-selected={t.key === tab}>{t.title}</NavLink>
            ))}
          </div>
          {reg && tab === 'fields' && <FieldsTab reg={reg} canManage={canManage && !reg.archived} />}
          {reg && tab === 'records' && (
            <RecordsTab
              key={reg.id}
              reg={reg}
              canEdit={me.permissions.includes('records.edit') && !reg.archived}
              canDelete={me.permissions.includes('records.delete') && !reg.archived}
            />
          )}
        </div>
      </div>
    </>
  );
}
