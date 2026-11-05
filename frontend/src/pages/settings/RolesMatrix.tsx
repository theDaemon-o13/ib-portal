import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { settingsApi, type Role } from '../../api/settings';
import { LockIcon, ReadOnlyNote } from '../../components/LockIcon';
import { useToast } from '../../components/Toast';
import { keys, useAction } from './useAction';

export function RolesMatrix({ canEdit }: { canEdit: boolean }) {
  const perms = useQuery({ queryKey: keys.permissions, queryFn: settingsApi.permissions });
  const roles = useQuery({ queryKey: keys.roles, queryFn: settingsApi.roles });
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [add, setAdd] = useState({ name: '', description: '' });
  const toast = useToast();

  const invalidate = [keys.roles, keys.users, keys.journal, ['auth', 'me']];
  const toggle = useAction(({ role, code, granted }: { role: Role; code: string; granted: boolean }) =>
    settingsApi.setPermission(role.id, code, granted), {
    invalidate,
    // Снят ib.work с роли-исполнителя правил рассылок (1.9.0): изменение прошло, но задачи правил пойдут без кандидатов.
    success: (r, a) => (r.warnings.length ? null : `${a.granted ? 'Право выдано' : 'Право снято'}: ${r.name}`),
    onDone: (r) => { if (r.warnings.length) toast(r.warnings.join(' '), 'warn'); },
  });
  const rename = useAction((role: Role) => settingsApi.updateRole(role.id, { version: role.version, name: editName }), {
    invalidate, success: (r) => `Роль переименована: «${r.name}»`, onDone: () => setEditId(null),
  });
  const remove = useAction((role: Role) => settingsApi.deleteRole(role.id, role.version), {
    invalidate, success: (_r, role) => `Роль «${role.name}» удалена`,
  });
  const create = useAction(() => settingsApi.createRole(add), {
    invalidate, success: (r) => `Роль «${r.name}» создана`, onDone: () => setAdd({ name: '', description: '' }),
  });

  const list = roles.data?.items ?? [];
  const submitAdd = (e: FormEvent) => { e.preventDefault(); create.mutate(undefined); };

  return (
    <section className="panel">
      <div className="panel-h">
        <div>
          <h3>Роли и права</h3>
          <span className="sub">Модель RBAC: право → роль → пользователь. Пользователь получает сумму прав всех своих ролей.</span>
        </div>
      </div>
      {!canEdit && <div className="panel-b"><ReadOnlyNote who="роль с правом «Настройки: пользователи, роли и права»" /></div>}
      <div className="tbl-wrap">
        <table className="cat-tbl rbac">
          <thead>
            <tr>
              <th>Право</th>
              {list.map((r) => (
                <th key={r.id} className="rc">
                  {canEdit && editId === r.id ? (
                    <form onSubmit={(e) => { e.preventDefault(); rename.mutate(r); }}>
                      <input className="inp" required autoFocus value={editName} onChange={(e) => setEditName(e.target.value)} aria-label="Название роли" />
                      <div className="row center nowrap">
                        <button className="btn primary sm" type="submit" disabled={rename.isPending}>OK</button>
                        <button className="btn sm" type="button" onClick={() => setEditId(null)} aria-label="Отмена">✕</button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <div className="rn">
                        {r.name}
                        {r.isSystem && <span className="lock" title="Системная роль"> <LockIcon /></span>}
                      </div>
                      <div className="hint">{r.activeUserCount} польз.</div>
                      {canEdit && (
                        <div className="row rh-act">
                          <button className="btn ghost sm" type="button" onClick={() => { setEditId(r.id); setEditName(r.name); }}>Изм.</button>
                          {!r.isSystem && r.userCount === 0 && (
                            <button className="btn ghost sm danger-t" type="button" onClick={() => remove.mutate(r)} disabled={remove.isPending}>Удал.</button>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {perms.data?.items.map((p) => (
              <tr key={p.code}>
                <td>
                  <b className="w500">{p.name}</b>
                  {p.description && <div className="hint wrap">{p.description}</div>}
                  <div className="hint mono">{p.code}</div>
                </td>
                {list.map((r) => {
                  const on = r.permissions.includes(p.code as Role['permissions'][number]);
                  const locked = r.lockedPermissions.includes(p.code as Role['permissions'][number]);
                  const forbidden = !on && r.forbiddenPermissions.includes(p.code as Role['permissions'][number]);
                  const title = locked
                    ? 'У системной роли это право не снимается'
                    : forbidden
                      ? 'Права этапов согласования не выдаются супер-администратору: он не согласует за других'
                      : undefined;
                  return (
                    <td key={r.id} className="rc">
                      <input
                        type="checkbox" className="perm" checked={on}
                        disabled={!canEdit || locked || forbidden || toggle.isPending}
                        title={title} aria-label={`${r.name}: ${p.name}`}
                        onChange={(e) => toggle.mutate({ role: r, code: p.code, granted: e.target.checked })}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canEdit && (
        <form className="field-form cat-add with-desc" onSubmit={submitAdd}>
          <label>Новая роль<input className="inp" required placeholder="Например: Аудитор (только просмотр)" value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} /></label>
          <label>Описание<input className="inp" placeholder="Кому выдаётся" value={add.description} onChange={(e) => setAdd({ ...add, description: e.target.value })} /></label>
          <button className="btn primary" type="submit" disabled={create.isPending}>Добавить роль</button>
        </form>
      )}
      <div className="panel-b">
        <div className="hint">
          Нельзя снять право «Настройки: пользователи, роли и права» с себя и с последнего пользователя, у которого оно есть.
          Права этапов согласования не выдаются супер-администратору — так сохраняется разделение полномочий.
        </div>
      </div>
    </section>
  );
}
