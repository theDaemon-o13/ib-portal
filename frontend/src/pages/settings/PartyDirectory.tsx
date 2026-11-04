import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import { settingsApi, type DirectoryPerson } from '../../api/settings';
import { byPersonName, matchPerson, sameNamePeople } from '../documents/logic';
import { keys, useAction } from './useAction';

const NAME_MAX = 300;
const POSITION_MAX = 300;

/** «Уже есть: …» — однофамилец не запрещён, только предупреждение. */
function SameName({ people }: { people: DirectoryPerson[] }) {
  if (!people.length) return null;
  return (
    <div className="note conflict span-all" role="status" data-testid="same-name">
      Уже есть: {people.map((p) => `${p.fullName}${p.position ? `, ${p.position}` : ''}${p.active ? '' : ' (отключён)'}`).join('; ')}. Если это другой человек — сохраните.
    </div>
  );
}

/**
 * «Настройки → Справочники → Ответственные лица» (1.6.7): из списка выбирают ответственных лиц в карточке документа.
 * Только для settings.manage (пункт без права не показывается). Удаления нет: отключённый не предлагается при выборе.
 */
export function PartyDirectory() {
  const list = useQuery({ queryKey: keys.partyDirectory, queryFn: settingsApi.partyDirectory });
  const items = useMemo(() => [...(list.data?.items ?? [])].sort(byPersonName), [list.data]);
  const [q, setQ] = useState('');
  const [showOff, setShowOff] = useState(false);
  const [add, setAdd] = useState({ fullName: '', position: '' });
  const [edit, setEdit] = useState<{ id: string; version: number; fullName: string; position: string } | null>(null);
  const invalidate = [keys.partyDirectory, keys.journal];

  const create = useAction((b: { fullName: string; position: string }) => settingsApi.addDirectoryPerson(b), {
    invalidate,
    success: (r) => `Добавлено: ${r.item.fullName}${r.sameName.length ? ' (есть однофамилец)' : ''}`,
    onDone: () => setAdd({ fullName: '', position: '' }),
  });
  const update = useAction((a: { id: string; body: Parameters<typeof settingsApi.updateDirectoryPerson>[1] }) => settingsApi.updateDirectoryPerson(a.id, a.body), {
    invalidate,
    success: (r, a) => (a.body.active === undefined ? `Сохранено: ${r.item.fullName}` : `${r.item.fullName}: ${r.item.active ? 'включено' : 'отключено'}`),
    onDone: () => setEdit(null),
  });

  const shown = items.filter((p) => (showOff || p.active) && matchPerson(p, q));
  const offCount = items.filter((p) => !p.active).length;
  const addSame = sameNamePeople(items, add.fullName);
  const editSame = edit ? sameNamePeople(items, edit.fullName, edit.id) : [];
  const busy = create.isPending || update.isPending;

  const submitAdd = (e: FormEvent) => {
    e.preventDefault();
    create.mutate({ fullName: add.fullName, position: add.position });
  };
  const submitEdit = (e: FormEvent) => {
    e.preventDefault();
    if (edit) update.mutate({ id: edit.id, body: { version: edit.version, fullName: edit.fullName, position: edit.position } });
  };

  return (
    <section className="panel" aria-label="Ответственные лица">
      <div className="panel-h">
        <div>
          <h3>Ответственные лица</h3>
          <span className="sub">Из этого списка выбирают ответственных лиц на этапе согласования документа. В документ ФИО и должность копируются текстом: правка здесь уже добавленных не меняет.</span>
        </div>
      </div>
      <div className="trash-filters">
        <input className="inp grow" type="search" placeholder="Поиск по ФИО и должности" aria-label="Поиск по ФИО и должности" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="check"><input type="checkbox" checked={showOff} onChange={(e) => setShowOff(e.target.checked)} /> Показывать отключённых{offCount ? ` (${offCount})` : ''}</label>
      </div>
      <div className="tbl-wrap">
        <table className="cat-tbl party-dir">
          <thead><tr><th>ФИО</th><th>Подразделение или должность</th><th>Активно</th><th aria-label="Действия" /></tr></thead>
          <tbody>
            {list.isPending && <tr><td colSpan={4} className="hint">Загрузка…</td></tr>}
            {list.isError && <tr><td colSpan={4} className="form-error">{list.error.message}</td></tr>}
            {list.isSuccess && shown.length === 0 && (
              <tr><td colSpan={4} className="hint">{items.length ? 'Ничего не найдено' : 'Список пуст. Добавьте первого человека в форме ниже: ФИО и подразделение или должность.'}</td></tr>
            )}
            {shown.map((p) => (edit?.id === p.id ? (
              <tr key={p.id} className="editing" data-person={p.fullName}>
                <td colSpan={4}>
                  <form className="field-form rounded cat-add with-desc" onSubmit={submitEdit} aria-label={`Изменить: ${p.fullName}`}>
                    <label>ФИО<input className="inp" required maxLength={NAME_MAX} autoFocus value={edit.fullName} onChange={(e) => setEdit({ ...edit, fullName: e.target.value })} /></label>
                    <label>Подразделение или должность<input className="inp" maxLength={POSITION_MAX} value={edit.position} onChange={(e) => setEdit({ ...edit, position: e.target.value })} /></label>
                    <div className="row nowrap">
                      <button className="btn primary sm" type="submit" disabled={busy || !edit.fullName.trim()}>Сохранить</button>
                      <button className="btn sm" type="button" onClick={() => setEdit(null)}>Отмена</button>
                    </div>
                    <SameName people={editSame} />
                  </form>
                </td>
              </tr>
            ) : (
              <tr key={p.id} className={p.active ? undefined : 'archived'} data-person={p.fullName}>
                <td><div className="cv"><b>{p.fullName}</b></div></td>
                <td>{p.position || <span className="hint">—</span>}</td>
                <td>{p.active ? 'да' : <span className="chip">отключено</span>}</td>
                <td>
                  <div className="row act">
                    <button className="btn ghost sm" type="button" disabled={busy} onClick={() => setEdit({ id: p.id, version: p.version, fullName: p.fullName, position: p.position })}>Изменить</button>
                    <button className={`btn sm${p.active ? ' danger-t' : ''}`} type="button" disabled={busy}
                      onClick={() => update.mutate({ id: p.id, body: { version: p.version, active: !p.active } })}>
                      {p.active ? 'Отключить' : 'Включить'}
                    </button>
                  </div>
                </td>
              </tr>
            )))}
          </tbody>
        </table>
      </div>
      <form className="field-form cat-add with-desc" onSubmit={submitAdd} aria-label="Добавить ответственное лицо в справочник">
        <label>ФИО<input className="inp" required maxLength={NAME_MAX} placeholder="Иванов И.И." value={add.fullName} onChange={(e) => setAdd({ ...add, fullName: e.target.value })} /></label>
        <label>Подразделение или должность<input className="inp" maxLength={POSITION_MAX} placeholder="Технический директор" value={add.position} onChange={(e) => setAdd({ ...add, position: e.target.value })} /></label>
        <button className="btn primary" type="submit" disabled={busy || !add.fullName.trim()}>Добавить</button>
        <SameName people={addSame} />
      </form>
    </section>
  );
}
