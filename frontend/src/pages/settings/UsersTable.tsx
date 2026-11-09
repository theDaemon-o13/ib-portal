import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useOutletContext } from 'react-router-dom';
import { ApiError, type Me } from '../../api/client';
import { settingsApi, type AdminUser, type WithTemporaryPassword } from '../../api/settings';
import { ReadOnlyNote } from '../../components/LockIcon';
import { ConfirmDialog, type ConfirmAsk } from './ConfirmDialog';
import { formatDateTime, initials } from './logic';
import { TemporaryPasswordDialog } from './TemporaryPasswordDialog';
import { UserSessionsDialog } from './UserSessionsDialog';
import { keys, useAction } from './useAction';
import { Select } from '../../components/Select';

interface Draft {
  fullName: string;
  login: string;
  position: string;
  department: string;
  roleIds: string[];
  /** '' — руководитель не назначен. */
  managerId: string;
}
const empty: Draft = { fullName: '', login: '', position: '', department: '', roleIds: [], managerId: '' };

/**
 * Роли пользователя. Служебная роль «Администратор портала» (ADR-0036) не совмещается с другими: выбрали её —
 * остальные снимаются и недоступны; выбрана другая роль — служебная недоступна. Backend проверяет то же (409).
 */
function RoleChecks({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const roles = useQuery({ queryKey: keys.roles, queryFn: settingsApi.roles });
  const items = roles.data?.items ?? [];
  const serviceId = items.find((r) => r.service)?.id;
  const serviceOn = !!serviceId && value.includes(serviceId);
  const othersOn = value.some((id) => id !== serviceId);
  return (
    <div className="role-checks">
      {items.map((r) => {
        const blocked = r.service ? othersOn && !serviceOn : serviceOn;
        return (
          <label key={r.id} title={blocked ? 'Служебная учётная запись не получает других ролей. Для работы в портале заведите отдельного пользователя' : undefined}>
            <input type="checkbox" checked={value.includes(r.id)} disabled={blocked}
              onChange={(e) => onChange(e.target.checked ? (r.service ? [r.id] : [...value, r.id]) : value.filter((id) => id !== r.id))} />
            {r.name}{r.service && <span className="hint"> · служебная</span>}
          </label>
        );
      })}
      {(serviceOn || othersOn) && serviceId && <span className="hint role-service-hint">«Администратор портала» — служебная роль: не совмещается с другими и не участвует в работе</span>}
    </div>
  );
}

/** Руководитель (ADR-0020): активные сотрудники ИБ, кроме самого пользователя. */
function ManagerSelect({ value, onChange, exclude, form }: { value: string; onChange: (id: string) => void; exclude?: string; form?: string }) {
  const options = useQuery({ queryKey: keys.userOptions, queryFn: settingsApi.userOptions });
  return (
    <Select className="inp" form={form} value={value} onChange={(e) => onChange(e.target.value)} aria-label="Руководитель">
      <option value="">Руководитель не назначен</option>
      {options.data?.items.filter((o) => o.id !== exclude).map((o) => <option key={o.id} value={o.id}>{o.fullName}</option>)}
    </Select>
  );
}

export function UsersTable({ canEdit }: { canEdit: boolean }) {
  const me = useOutletContext<Me>();
  const users = useInfiniteQuery({
    queryKey: keys.users,
    queryFn: ({ pageParam }) => settingsApi.users(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const [editId, setEditId] = useState<string | null>(null);
  const [edit, setEdit] = useState<Draft>(empty);
  const [add, setAdd] = useState<Draft>(empty);
  const [shown, setShown] = useState<{ title: string; result: WithTemporaryPassword } | null>(null);
  const [ask, setAsk] = useState<ConfirmAsk | null>(null);
  // «Сессии» пользователя (1.10.0): открытые сессии и «Завершить».
  const [sessionsOf, setSessionsOf] = useState<{ id: string; fullName: string } | null>(null);

  const invalidate = [keys.users, keys.roles, keys.userOptions, keys.journal, ['auth', 'me']];
  const create = useAction(() => settingsApi.createUser({ ...add, login: add.login.trim(), managerId: add.managerId || null }), {
    invalidate,
    success: (r) => `Пользователь ${r.user.fullName} создан`,
    onDone: (r) => { setAdd(empty); setShown({ title: 'Пользователь создан', result: r }); },
  });
  const save = useAction((u: AdminUser) => settingsApi.updateUser(u.id, {
    version: u.version, fullName: edit.fullName, position: edit.position, department: edit.department, roleIds: edit.roleIds,
    managerId: edit.managerId || null,
  }), { invalidate, success: (r) => `Сохранено: ${r.fullName}`, onDone: () => setEditId(null) });
  const toggleActive = useAction((u: AdminUser) => (u.isActive ? settingsApi.disableUser(u.id, u.version) : settingsApi.enableUser(u.id, u.version)), {
    invalidate,
    success: (r) => (r.isActive ? `${r.fullName} снова может входить` : `${r.fullName} отключён. Его записи сохранятся`),
  });
  const reset = useAction((u: AdminUser) => settingsApi.resetPassword(u.id, u.version), {
    invalidate,
    success: () => null,
    onDone: (r) => setShown({ title: 'Пароль сброшен', result: r }),
  });
  const unlock = useAction((u: AdminUser) => settingsApi.unlockUser(u.id, u.version), {
    invalidate, success: (r) => `Блокировка входа снята: ${r.fullName}`,
  });
  // Отметка «Начальник ИБ» (1.4.0): одна на портал. Занята — сервер отвечает 409 с ФИО держателя, спрашиваем о передаче.
  const ibHead = useAction(({ u, value, transfer }: { u: AdminUser; value: boolean; transfer?: boolean }) =>
    settingsApi.setIbHead(u.id, { version: u.version, value, ...(transfer ? { transfer } : {}) }), {
    invalidate,
    success: (r) => (r.isIbHead ? `${r.fullName} — начальник ИБ` : `Отметка «Начальник ИБ» снята: ${r.fullName}`),
    onDone: () => setAsk(null),
    handle: (err, { u, value, transfer }) => {
      const holder = err instanceof ApiError && err.code === 'IB_HEAD_TAKEN' ? (err.details?.holder as { fullName: string } | undefined) : undefined;
      if (!holder || !value || transfer) return false;
      setAsk({
        title: `Передать от ${holder.fullName}?`,
        text: <>Отметка «Начальник ИБ» сейчас у {holder.fullName}. После передачи этап «Начальник ИБ» в документах выполняет {u.fullName}.</>,
        confirm: 'Передать',
        run: () => ibHead.mutate({ u, value: true, transfer: true }),
      });
      return true;
    },
  });
  const unmarkHead = (u: AdminUser) => setAsk({
    title: 'Снять отметку «Начальник ИБ»?',
    text: <>У {u.fullName} снимется отметка. Этап «Начальник ИБ» в документах останется без исполнителя, пока отметку не поставят другому.</>,
    confirm: 'Снять отметку',
    run: () => ibHead.mutate({ u, value: false }),
  });
  const disable = (u: AdminUser) => {
    if (!u.isIbHead) { toggleActive.mutate(u); return; }
    setAsk({
      title: `Отключить ${u.fullName}?`,
      text: <>У пользователя отметка «Начальник ИБ», этап останется без исполнителя. Отметка снимется вместе с отключением.</>,
      confirm: 'Отключить',
      run: () => { setAsk(null); toggleActive.mutate(u); },
    });
  };

  const rows = users.data?.pages.flatMap((p) => p.items) ?? [];
  const active = rows.filter((u) => u.isActive).length;
  const submitAdd = (e: FormEvent) => { e.preventDefault(); create.mutate(undefined); };

  return (
    <section className="panel">
      <div className="panel-h">
        <div>
          <h3>Пользователи</h3>
          <span className="sub">{active} активных · учётные записи портала с логином и паролем</span>
        </div>
      </div>
      {!canEdit && <div className="panel-b"><ReadOnlyNote who="роль с правом «Настройки: пользователи, роли и права»" /></div>}
      <div className="tbl-wrap">
        <table className="cat-tbl users-tbl">
          <thead><tr><th>Пользователь</th><th>Должность</th><th>Роли</th><th>Статус</th><th /></tr></thead>
          <tbody>
            {users.isPending && <tr><td colSpan={5} className="hint">Загрузка…</td></tr>}
            {rows.map((u) => {
              const self = u.id === me.id;
              if (canEdit && editId === u.id) {
                return (
                  // key отличается от строки просмотра: иначе React переиспользует нажатую «Изменить» как «Сохранить» (submit) и щелчок сразу отправит форму.
                  <tr key={`${u.id}:edit`} className="editing">
                    <td>
                      <form id={`ue-${u.id}`} onSubmit={(e) => {
                        e.preventDefault();
                        const sameRoles = [...edit.roleIds].sort().join() === u.roles.map((r) => r.id).sort().join();
                        const same = sameRoles && edit.fullName.trim() === u.fullName &&
                          edit.position.trim() === u.position && edit.department.trim() === u.department &&
                          edit.managerId === (u.manager?.id ?? '');
                        if (same) setEditId(null);
                        else save.mutate(u);
                      }} />
                      <input form={`ue-${u.id}`} className="inp" required autoFocus value={edit.fullName} onChange={(e) => setEdit({ ...edit, fullName: e.target.value })} aria-label="ФИО" />
                      <div className="hint mono">{u.login} · логин не меняется</div>
                    </td>
                    <td>
                      <input form={`ue-${u.id}`} className="inp" placeholder="Должность" value={edit.position} onChange={(e) => setEdit({ ...edit, position: e.target.value })} aria-label="Должность" />
                      <input form={`ue-${u.id}`} className="inp mt6" placeholder="Подразделение" value={edit.department} onChange={(e) => setEdit({ ...edit, department: e.target.value })} aria-label="Подразделение" />
                      <div className="mt6"><ManagerSelect form={`ue-${u.id}`} value={edit.managerId} exclude={u.id} onChange={(managerId) => setEdit({ ...edit, managerId })} /></div>
                    </td>
                    <td><RoleChecks value={edit.roleIds} onChange={(roleIds) => setEdit({ ...edit, roleIds })} /></td>
                    <td>
                      {/* Отметка меняется сразу, отдельно от «Сохранить»: передача и снятие — с подтверждением. */}
                      <div className="ib-head" data-testid="ib-head">
                        <span className="eyebrow">Является начальником ИБ</span>
                        {u.isIbHead ? (
                          <>
                            <span className="chip acc">Да</span>
                            <button className="btn ghost sm" type="button" onClick={() => unmarkHead(u)} disabled={ibHead.isPending}>Снять отметку</button>
                          </>
                        ) : (
                          <>
                            <span className="hint">Нет</span>
                            {self
                              ? <span className="hint">себе отметку ставит другой администратор</span>
                              : <button className="btn ghost sm" type="button" onClick={() => ibHead.mutate({ u, value: true })} disabled={ibHead.isPending || !u.isActive}>Отметить</button>}
                          </>
                        )}
                        <div className="hint">Выполняет этап «Начальник ИБ» в документах. Отметка — только у одного пользователя</div>
                      </div>
                    </td>
                    <td>
                      <div className="row act">
                        <button className="btn primary sm" type="submit" form={`ue-${u.id}`} disabled={save.isPending}>Сохранить</button>
                        <button className="btn sm" type="button" onClick={() => setEditId(null)}>Отмена</button>
                      </div>
                    </td>
                  </tr>
                );
              }
              return (
                <tr key={`${u.id}:view`} className={u.isActive ? undefined : 'archived'}>
                  <td>
                    <div className="cv">
                      <span className="av">{initials(u.fullName)}</span>
                      <div>
                        <b>{u.fullName}</b>{self && <> <span className="chip acc">это вы</span></>}
                        {u.isIbHead && <> <span className="chip info" data-testid="ib-head-chip" title="Является начальником ИБ: выполняет этап «Начальник ИБ» в документах">Начальник ИБ</span></>}
                        <div className="hint mono">{u.login}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    {u.position || '—'}<div className="hint">{u.department}</div>
                    {u.manager && (
                      <div className="hint" data-manager={u.manager.id}>
                        Руководитель: {u.manager.fullName}{!u.manager.isActive && ' (отключён)'}
                      </div>
                    )}
                    {u.subordinateCount > 0 && <div className="hint">Подчинённых: {u.subordinateCount}</div>}
                  </td>
                  <td>
                    <div className="cover">
                      {u.roles.length ? u.roles.map((r) => <span key={r.id} className="chip info">{r.name}</span>) : <span className="hint">нет ролей</span>}
                    </div>
                  </td>
                  <td>
                    <div className="cover">
                      {u.isActive ? <span className="chip low">Активен</span> : <span className="chip">Отключён</span>}
                      {u.locked && <span className="chip crit" title={`до ${formatDateTime(u.lockedUntil)}`}>Вход заблокирован</span>}
                      {u.isActive && u.mustChangePassword && <span className="chip high">Сменит пароль при входе</span>}
                    </div>
                    <div className="hint">Последний вход: {formatDateTime(u.lastLoginAt)}</div>
                  </td>
                  <td>
                    {canEdit && (
                      <div className="row act">
                        <button className="btn ghost sm" type="button" onClick={() => {
                          setEditId(u.id);
                          setEdit({
                            fullName: u.fullName, login: u.login, position: u.position, department: u.department,
                            roleIds: u.roles.map((r) => r.id), managerId: u.manager?.id ?? '',
                          });
                        }}>Изменить</button>
                        <button className="btn ghost sm" type="button" onClick={() => setSessionsOf({ id: u.id, fullName: u.fullName })}>Сессии</button>
                        {u.locked && <button className="btn ghost sm" type="button" onClick={() => unlock.mutate(u)} disabled={unlock.isPending}>Разблокировать</button>}
                        {!self && u.isActive && <button className="btn ghost sm" type="button" onClick={() => reset.mutate(u)} disabled={reset.isPending}>Сбросить пароль</button>}
                        {!self && (
                          <button className="btn ghost sm" type="button" onClick={() => (u.isActive ? disable(u) : toggleActive.mutate(u))} disabled={toggleActive.isPending}>
                            {u.isActive ? 'Отключить' : 'Включить'}
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {users.hasNextPage && (
        <div className="panel-b">
          <button className="btn sm" type="button" onClick={() => void users.fetchNextPage()} disabled={users.isFetchingNextPage}>Показать ещё</button>
        </div>
      )}
      {canEdit && (
        <form className="field-form user-add" onSubmit={submitAdd}>
          <label>ФИО<input className="inp" required placeholder="Фамилия И." value={add.fullName} onChange={(e) => setAdd({ ...add, fullName: e.target.value })} /></label>
          <label>Логин<input className="inp" required placeholder="i.ivanov" autoComplete="off" value={add.login} onChange={(e) => setAdd({ ...add, login: e.target.value })} /></label>
          <label>Должность<input className="inp" placeholder="Специалист" value={add.position} onChange={(e) => setAdd({ ...add, position: e.target.value })} /></label>
          <label>Подразделение<input className="inp" placeholder="Отдел ИБ" value={add.department} onChange={(e) => setAdd({ ...add, department: e.target.value })} /></label>
          <label>Руководитель<ManagerSelect value={add.managerId} onChange={(managerId) => setAdd({ ...add, managerId })} /></label>
          <div className="field-roles"><span className="eyebrow">Роли</span><RoleChecks value={add.roleIds} onChange={(roleIds) => setAdd({ ...add, roleIds })} /></div>
          <button className="btn primary" type="submit" disabled={create.isPending}>Добавить</button>
        </form>
      )}
      <div className="panel-b">
        <div className="note">
          Пароль новому пользователю и при сбросе генерирует портал: он показывается один раз, при первом входе пользователь задаёт свой.
          Срок действия пароля — 90 дней. Этап документа согласует только пользователь с правом этого этапа.
          Руководитель — сотрудник ИБ; все, кто выше по цепочке руководителей, — старшие над пользователем.
        </div>
      </div>
      {ask && <ConfirmDialog ask={ask} busy={ibHead.isPending || toggleActive.isPending} onClose={() => setAsk(null)} />}
      {sessionsOf && <UserSessionsDialog user={sessionsOf} onClose={() => setSessionsOf(null)} />}
      {shown && (
        <TemporaryPasswordDialog
          title={shown.title}
          result={shown.result}
          onClose={() => {
            // Пароль удаляется и из результатов мутаций: после закрытия его нет в памяти страницы.
            setShown(null);
            create.reset();
            reset.reset();
          }}
        />
      )}
    </section>
  );
}
