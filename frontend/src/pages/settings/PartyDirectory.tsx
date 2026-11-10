import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import { settingsApi, type DirectoryPerson } from '../../api/settings';
import { CopyButton } from '../../components/CopyButton';
import { emailOk } from '../documents/party-batch';
import { byPersonName, matchPerson, sameNamePeople } from '../documents/logic';
import { keys, useAction } from './useAction';

const NAME_MAX = 300;
const POSITION_MAX = 300;
const EMAIL_MAX = 254;

/** Та же почта у другого (1.13.6) — предупреждение, не запрет. */
function SameEmail({ people, email }: { people: DirectoryPerson[]; email: string }) {
  const e = email.trim().toLowerCase();
  const same = e ? people.filter((p) => p.email === e) : [];
  if (!same.length) return null;
  return (
    <div className="note conflict span-all" role="status" data-testid="same-email">
      Почта {e} уже есть у: {same.map((p) => `${p.fullName}${p.position ? `, ${p.position}` : ''}${p.active ? '' : ' (отключён)'}`).join('; ')}. Если так и задумано (общий ящик) — сохраните.
    </div>
  );
}
const BadEmail = ({ email }: { email: string }) => (emailOk(email) ? null : <div className="form-error span-all" role="alert">Почта — в виде ivanov@example.com</div>);

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
  const [add, setAdd] = useState({ fullName: '', position: '', email: '' });
  const [edit, setEdit] = useState<{ id: string; version: number; fullName: string; position: string; email: string } | null>(null);
  const invalidate = [keys.partyDirectory, keys.journal];

  const create = useAction((b: { fullName: string; position: string; email: string }) => settingsApi.addDirectoryPerson(b), {
    invalidate,
    success: (r) => `Добавлено: ${r.item.fullName}${r.sameName.length ? ' (есть однофамилец)' : ''}${r.sameEmail.length ? ' (такая почта уже есть)' : ''}`,
    onDone: () => setAdd({ fullName: '', position: '', email: '' }),
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
  const others = (id?: string) => items.filter((p) => p.id !== id);
  const busy = create.isPending || update.isPending;

  const submitAdd = (e: FormEvent) => {
    e.preventDefault();
    create.mutate({ fullName: add.fullName, position: add.position, email: add.email.trim() });
  };
  const submitEdit = (e: FormEvent) => {
    e.preventDefault();
    if (edit) update.mutate({ id: edit.id, body: { version: edit.version, fullName: edit.fullName, position: edit.position, email: edit.email.trim() } });
  };

  return (
    <section className="panel" aria-label="Ответственные лица">
      <div className="panel-h">
        <div>
          <h3>Ответственные лица</h3>
          <span className="sub">Из этого списка выбирают ответственных лиц на этапе согласования документа. В документ ФИО, должность и почта копируются текстом: правка здесь уже добавленных не меняет. Кнопка рядом с полем копирует его для титульного листа.</span>
        </div>
      </div>
      <div className="trash-filters">
        <input className="inp grow" type="search" placeholder="Поиск по ФИО, должности и почте" aria-label="Поиск по ФИО, должности и почте" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="check"><input type="checkbox" checked={showOff} onChange={(e) => setShowOff(e.target.checked)} /> Показывать отключённых{offCount ? ` (${offCount})` : ''}</label>
      </div>
      <div className="tbl-wrap">
        <table className="cat-tbl party-dir">
          <thead><tr><th>ФИО</th><th>Подразделение или должность</th><th>Почта</th><th>Активно</th><th aria-label="Действия" /></tr></thead>
          <tbody>
            {list.isPending && <tr><td colSpan={5} className="hint">Загрузка…</td></tr>}
            {list.isError && <tr><td colSpan={5} className="form-error">{list.error.message}</td></tr>}
            {list.isSuccess && shown.length === 0 && (
              <tr><td colSpan={5} className="hint">{items.length ? 'Ничего не найдено' : 'Список пуст. Добавьте первого человека в форме ниже: ФИО и подразделение или должность.'}</td></tr>
            )}
            {shown.map((p) => (edit?.id === p.id ? (
              <tr key={p.id} className="editing" data-person={p.fullName}>
                <td colSpan={5}>
                  <form className="field-form rounded cat-add with-desc" onSubmit={submitEdit} aria-label={`Изменить: ${p.fullName}`}>
                    <label>ФИО<input className="inp" required maxLength={NAME_MAX} autoFocus value={edit.fullName} onChange={(e) => setEdit({ ...edit, fullName: e.target.value })} /></label>
                    <label>Подразделение или должность<input className="inp" maxLength={POSITION_MAX} value={edit.position} onChange={(e) => setEdit({ ...edit, position: e.target.value })} /></label>
                    <label>Почта<input className="inp" type="email" inputMode="email" autoComplete="off" maxLength={EMAIL_MAX} placeholder="необязательно" value={edit.email}
                      aria-invalid={!emailOk(edit.email) || undefined} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></label>
                    <div className="row nowrap">
                      <button className="btn primary sm" type="submit" disabled={busy || !edit.fullName.trim() || !emailOk(edit.email)}>Сохранить</button>
                      <button className="btn sm" type="button" onClick={() => setEdit(null)}>Отмена</button>
                    </div>
                    <SameName people={editSame} />
                    <BadEmail email={edit.email} />
                    <SameEmail people={others(edit.id)} email={edit.email} />
                  </form>
                </td>
              </tr>
            ) : (
              <tr key={p.id} className={p.active ? undefined : 'archived'} data-person={p.fullName}>
                <td><span className="pf"><b className="pf-v">{p.fullName}</b><CopyButton what="ФИО" value={p.fullName} /></span></td>
                <td>{p.position ? <span className="pf"><span className="pf-v">{p.position}</span><CopyButton what="должность" value={p.position} /></span> : <span className="hint">—</span>}</td>
                <td>{p.email ? <span className="pf"><span className="pf-v pf-mail">{p.email}</span><CopyButton what="почту" value={p.email} /></span> : <span className="hint">—</span>}</td>
                <td>{p.active ? 'да' : <span className="chip">отключено</span>}</td>
                <td>
                  <div className="row act">
                    <button className="btn ghost sm" type="button" disabled={busy} onClick={() => setEdit({ id: p.id, version: p.version, fullName: p.fullName, position: p.position, email: p.email })}>Изменить</button>
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
        <label>Почта<input className="inp" type="email" inputMode="email" autoComplete="off" maxLength={EMAIL_MAX} placeholder="ivanov@example.com" value={add.email}
          aria-invalid={!emailOk(add.email) || undefined} onChange={(e) => setAdd({ ...add, email: e.target.value })} /></label>
        <button className="btn primary" type="submit" disabled={busy || !add.fullName.trim() || !emailOk(add.email)}>Добавить</button>
        <SameName people={addSame} />
        <BadEmail email={add.email} />
        <SameEmail people={items} email={add.email} />
      </form>
    </section>
  );
}
