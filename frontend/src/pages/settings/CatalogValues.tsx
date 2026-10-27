import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { settingsApi, type Catalog, type CatalogItem } from '../../api/settings';
import { LockIcon, ReadOnlyNote } from '../../components/LockIcon';
import { parseKeywords, type ToneKey } from './logic';
import { ToneDot, ToneSelect } from './ToneSelect';
import { keys, useAction } from './useAction';

interface Draft {
  value: string;
  color: ToneKey;
  keywords: string;
  ownerUserId: string;
  /** «Получатели уведомлений»: участники и e-mail. */
  members: { id: string; fullName: string }[];
  emails: string;
}

const sameDraft = (a: Draft, b: Draft) =>
  a.value.trim() === b.value.trim() && a.color === b.color && a.ownerUserId === b.ownerUserId &&
  parseKeywords(a.keywords).join('|') === parseKeywords(b.keywords).join('|') &&
  a.members.map((m) => m.id).sort().join('|') === b.members.map((m) => m.id).sort().join('|') &&
  parseKeywords(a.emails).join('|') === parseKeywords(b.emails).join('|');

const draftOf = (i?: CatalogItem): Draft => ({
  value: i?.value ?? '',
  color: (i?.color ?? 'muted') as ToneKey,
  keywords: i?.keywords.join(', ') ?? '',
  ownerUserId: i?.owner?.id ?? '',
  members: i?.members.map((m) => ({ id: m.id, fullName: m.fullName })) ?? [],
  emails: i?.emails.join(', ') ?? '',
});

const SYSTEM_OWNER = 'system_owner';

/**
 * Участники метки: только сотрудники с доступом к разделам ИБ — им ставятся задачи.
 * Остальных указывают e-mail; письма придут, когда в портале появится почта (этап 9).
 */
function MembersEditor({ draft, setDraft, people }: {
  draft: Draft; setDraft: (d: Draft) => void; people: { id: string; fullName: string; ibWork: boolean }[];
}) {
  const [refused, setRefused] = useState<string | null>(null);
  return (
    <div className="grid-gap">
      <div className="cover">
        {draft.members.map((m) => (
          <span key={m.id} className="chip acc">
            {m.fullName}
            <button type="button" className="chip-x" aria-label={`Убрать ${m.fullName}`}
              onClick={() => setDraft({ ...draft, members: draft.members.filter((x) => x.id !== m.id) })}>×</button>
          </span>
        ))}
        {draft.members.length === 0 && <span className="hint">участников нет</span>}
      </div>
      <select className="inp" value="" aria-label="Добавить участника" onChange={(e) => {
        const u = people.find((x) => x.id === e.target.value);
        if (!u) return;
        if (!u.ibWork) {
          setRefused(`У «${u.fullName}» нет доступа к разделам ИБ — задачу ему не назначить. Укажите его e-mail: письма придут, когда в портале появится почта`);
          return;
        }
        setRefused(null);
        if (!draft.members.some((m) => m.id === u.id)) setDraft({ ...draft, members: [...draft.members, { id: u.id, fullName: u.fullName }] });
      }}>
        <option value="">+ участник…</option>
        {people.map((u) => <option key={u.id} value={u.id}>{u.fullName}{u.ibWork ? '' : ' — нет доступа к ИБ'}</option>)}
      </select>
      {refused && <div className="form-error" role="alert">{refused}</div>}
    </div>
  );
}

export function CatalogValues({ catalog, canEdit }: { catalog: Catalog; canEdit: boolean }) {
  const isMail = catalog.kind === 'mail_rules';
  const isStatuses = catalog.kind === 'statuses';
  const isSystems = catalog.code === 'systems';
  const isRecipients = catalog.code === 'notify_recipients';
  const items = useQuery({ queryKey: keys.items(catalog.code), queryFn: () => settingsApi.items(catalog.code, true) });
  const owners = useQuery({ queryKey: keys.userOptions, queryFn: settingsApi.userOptions, enabled: isMail });
  // Владелец системы — любой активный пользователь; участники меток проверяются по доступу к ИБ.
  const everyone = useQuery({ queryKey: keys.allUserOptions, queryFn: settingsApi.allUserOptions, enabled: isSystems || isRecipients });
  const [editId, setEditId] = useState<string | null>(null);
  const [edit, setEdit] = useState<Draft>(draftOf());
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [add, setAdd] = useState<Draft>(draftOf());

  const invalidate = [keys.items(catalog.code), keys.catalogs, keys.journal];
  const save = useAction(
    ({ item, d }: { item: CatalogItem; d: Draft }) =>
      settingsApi.updateItem(item.id, {
        version: item.version,
        value: d.value,
        ...(catalog.hasColor ? { color: d.color } : {}),
        ...(isMail ? { keywords: parseKeywords(d.keywords), ownerUserId: d.ownerUserId || null } : {}),
        ...(isSystems ? { ownerUserId: d.ownerUserId || null } : {}),
        ...(isRecipients && item.systemKey !== SYSTEM_OWNER ? { memberIds: d.members.map((m) => m.id), emails: parseKeywords(d.emails) } : {}),
      }),
    { invalidate, success: (r) => `Сохранено: «${r.value}»`, onDone: () => setEditId(null) },
  );
  const create = useAction(
    (d: Draft) =>
      settingsApi.createItem(catalog.code, {
        value: d.value,
        ...(catalog.hasColor ? { color: d.color } : {}),
        ...(isMail ? { keywords: parseKeywords(d.keywords), ownerUserId: d.ownerUserId || null } : {}),
        ...(isSystems ? { ownerUserId: d.ownerUserId || null } : {}),
        ...(isRecipients ? { memberIds: d.members.map((m) => m.id), emails: parseKeywords(d.emails) } : {}),
      }),
    { invalidate, success: (r) => `Добавлено: «${r.value}»`, onDone: () => setAdd(draftOf()) },
  );
  const archive = useAction(
    (i: CatalogItem) => (i.archived ? settingsApi.restoreItem(i.id, i.version) : settingsApi.archiveItem(i.id, i.version)),
    {
      invalidate,
      success: (r) => (r.archived ? `«${r.value}» в архиве. Старые записи его сохранят` : `«${r.value}» снова доступно для выбора`),
    },
  );
  const remove = useAction((i: CatalogItem) => settingsApi.deleteItem(i.id, i.version), {
    invalidate,
    success: (_r, i) => `«${i.value}» удалено из справочника`,
    onDone: () => setConfirmId(null),
  });

  const startEdit = (i: CatalogItem) => {
    setEditId(i.id);
    setEdit(draftOf(i));
    setConfirmId(null);
  };
  const submitEdit = (e: FormEvent, item: CatalogItem) => {
    e.preventDefault();
    // Ничего не изменилось — просто закрыть строку, без запроса.
    if (sameDraft(edit, draftOf(item))) {
      setEditId(null);
      return;
    }
    save.mutate({ item, d: edit });
  };
  const submitAdd = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(add);
  };

  const ownerSelect = (d: Draft, set: (d: Draft) => void, id: string) => (
    <select id={id} className="inp" value={d.ownerUserId} onChange={(e) => set({ ...d, ownerUserId: e.target.value })}>
      <option value="">— не назначен</option>
      {owners.data?.items.map((u) => (
        <option key={u.id} value={u.id}>{u.fullName}</option>
      ))}
    </select>
  );

  const systemOwnerSelect = (d: Draft, set: (d: Draft) => void, id: string) => (
    <select id={id} className="inp" value={d.ownerUserId} onChange={(e) => set({ ...d, ownerUserId: e.target.value })} aria-label="Владелец системы">
      <option value="">— не назначен</option>
      {everyone.data?.items.map((u) => <option key={u.id} value={u.id}>{u.fullName}{u.ibWork ? '' : ' — нет доступа к ИБ'}</option>)}
    </select>
  );
  const people = everyone.data?.items ?? [];
  const ownerNote = (i: CatalogItem) =>
    i.owner && !people.find((u) => u.id === i.owner?.id)?.ibWork
      ? <div className="hint">нет доступа к ИБ — задачи «Владельцу системы» будут без ответственного</div>
      : null;

  const rows = items.data?.items ?? [];
  const colCount = 3 + (isMail ? 2 : isRecipients ? 3 : isSystems ? 2 : 1);

  return (
    <section className="panel">
      <div className="panel-h">
        <div>
          <h3>{catalog.name}</h3>
          <span className="sub">Где используется: {catalog.description}</span>
        </div>
      </div>
      {!canEdit && <div className="panel-b"><ReadOnlyNote who="роль с правом «Настройки: справочники и шаблоны форм»" /></div>}
      <div className="tbl-wrap">
        <table className="cat-tbl">
          <thead>
            <tr>
              <th>{isMail ? 'Категория письма' : isRecipients ? 'Метка' : 'Значение'}</th>
              {isMail && <th>Ключевые слова</th>}
              {isSystems && <th>Владелец системы</th>}
              {isRecipients && <th>Участники (задачи)</th>}
              {isRecipients && <th>E-mail (письма — этап 9)</th>}
              {isMail ? <th>Ответственный</th> : <th title="Сколько записей ссылается на значение">Используется</th>}
              <th>Статус</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.isPending && <tr><td colSpan={colCount + 1} className="hint">Загрузка…</td></tr>}
            {items.isError && <tr><td colSpan={colCount + 1} className="form-error">{items.error.message}</td></tr>}
            {rows.map((i) =>
              canEdit && editId === i.id ? (
                // key отличается от строки просмотра: иначе React переиспользует нажатую «Изменить» как «Сохранить» (submit) и щелчок сразу отправит форму.
                <tr key={`${i.id}:edit`} className="editing">
                  <td>
                    <form id={`ce-${i.id}`} onSubmit={(e) => submitEdit(e, i)} />
                    <div className="row nowrap">
                      {catalog.hasColor && (
                        <ToneSelect value={edit.color} onChange={(color) => setEdit({ ...edit, color })} />
                      )}
                      <input
                        form={`ce-${i.id}`} className="inp" value={edit.value} required autoFocus
                        readOnly={i.isSystem && !isStatuses}
                        title={i.isSystem && !isStatuses ? 'Системное значение нельзя переименовать' : undefined}
                        onChange={(e) => setEdit({ ...edit, value: e.target.value })} aria-label="Значение"
                      />
                    </div>
                  </td>
                  {isMail && (
                    <td>
                      <input form={`ce-${i.id}`} className="inp" value={edit.keywords} placeholder="слова через запятую"
                        onChange={(e) => setEdit({ ...edit, keywords: e.target.value })} aria-label="Ключевые слова" />
                    </td>
                  )}
                  {isSystems && <td>{systemOwnerSelect(edit, setEdit, `ce-sowner-${i.id}`)}</td>}
                  {isRecipients && (i.systemKey === SYSTEM_OWNER
                    ? <td colSpan={2} className="hint">Берётся из справочника «Системы» по полю «Система» записи</td>
                    : (
                      <>
                        <td><MembersEditor draft={edit} setDraft={setEdit} people={people} /></td>
                        <td>
                          <input form={`ce-${i.id}`} className="inp" value={edit.emails} placeholder="адреса через запятую"
                            onChange={(e) => setEdit({ ...edit, emails: e.target.value })} aria-label="E-mail метки" />
                        </td>
                      </>
                    ))}
                  {isMail ? <td>{ownerSelect(edit, setEdit, `ce-owner-${i.id}`)}</td> : <td className="mono">{i.usage}</td>}
                  <td />
                  <td>
                    <div className="row act">
                      <button className="btn primary sm" type="submit" form={`ce-${i.id}`} disabled={save.isPending}>Сохранить</button>
                      <button className="btn sm" type="button" onClick={() => setEditId(null)}>Отмена</button>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr key={`${i.id}:view`} className={i.archived ? 'archived' : undefined}>
                  <td>
                    <div className="cv">
                      {catalog.hasColor && <ToneDot tone={i.color} />}
                      <b>{i.value}</b>
                      {i.isSystem && <span className="lock" title={`Системное значение: ${i.systemReason ?? ''}`}><LockIcon /></span>}
                    </div>
                    {i.isSystem && i.systemReason && <div className="hint">Системное: {i.systemReason}</div>}
                  </td>
                  {isMail && <td className="hint">{i.keywords.join(', ')}</td>}
                  {isSystems && (
                    <td>{i.owner ? <>{i.owner.fullName}{ownerNote(i)}</> : <span className="hint">не назначен</span>}</td>
                  )}
                  {isRecipients && (i.systemKey === SYSTEM_OWNER
                    ? <td colSpan={2} className="hint">владелец системы записи</td>
                    : (
                      <>
                        <td>{i.members.length ? i.members.map((m) => m.fullName).join(', ') : <span className="hint">нет — задачи без ответственного</span>}</td>
                        <td className="hint">{i.emails.join(', ') || '—'}</td>
                      </>
                    ))}
                  {isMail ? (
                    <td>{i.owner ? <>{i.owner.fullName}{!i.owner.isActive && <span className="hint"> (отключён)</span>}</> : <span className="hint">не назначен</span>}</td>
                  ) : (
                    <td className="mono">{i.usage}</td>
                  )}
                  <td>{i.archived ? <span className="chip">В архиве</span> : <span className="chip low">Активно</span>}</td>
                  <td>
                    {canEdit && (confirmId === i.id ? (
                      <div className="row act" key="confirm">
                        <span className="hint">Удалить «{i.value}»?</span>
                        <button className="btn sm danger" type="button" onClick={() => remove.mutate(i)} disabled={remove.isPending}>Удалить</button>
                        <button className="btn sm" type="button" onClick={() => setConfirmId(null)}>Отмена</button>
                      </div>
                    ) : (
                      <div className="row act" key="actions">
                        <button className="btn ghost sm" type="button" onClick={() => startEdit(i)}>Изменить</button>
                        {!i.isSystem && (
                          <button className="btn ghost sm" type="button" onClick={() => archive.mutate(i)} disabled={archive.isPending}>
                            {i.archived ? 'Вернуть' : 'В архив'}
                          </button>
                        )}
                        {!i.isSystem && i.usage === 0 && (
                          <button className="btn ghost sm danger-t" type="button" onClick={() => { setConfirmId(i.id); setEditId(null); }}>
                            Удалить
                          </button>
                        )}
                      </div>
                    ))}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
      {canEdit && !isStatuses && (
        <form className={`field-form cat-add${catalog.hasColor ? ' with-color' : ''}${isMail ? ' with-mail' : ''}${isSystems || isRecipients ? ' with-desc' : ''}`} onSubmit={submitAdd}>
          <label>
            {isMail ? 'Новая категория письма' : isRecipients ? 'Новая метка' : 'Новое значение'}
            <input className="inp" required value={add.value} onChange={(e) => setAdd({ ...add, value: e.target.value })} />
          </label>
          {catalog.hasColor && (
            <label>
              Цвет
              <ToneSelect value={add.color} onChange={(color) => setAdd({ ...add, color })} />
            </label>
          )}
          {isMail && (
            <label>
              Ключевые слова
              <input className="inp" required placeholder="через запятую" value={add.keywords}
                onChange={(e) => setAdd({ ...add, keywords: e.target.value })} />
            </label>
          )}
          {isMail && <label>Ответственный{ownerSelect(add, setAdd, 'ca-owner')}</label>}
          {isSystems && <label>Владелец системы{systemOwnerSelect(add, setAdd, 'ca-sowner')}</label>}
          {isRecipients && (
            <label>
              E-mail
              <input className="inp" placeholder="адреса через запятую; участников — после добавления" value={add.emails}
                onChange={(e) => setAdd({ ...add, emails: e.target.value })} />
            </label>
          )}
          <button className="btn primary" type="submit" disabled={create.isPending}>Добавить</button>
        </form>
      )}
      {isRecipients && (
        <div className="panel-b">
          <div className="hint">
            Метка — адресат правил автоматизаций. Участникам (только с доступом к разделам ИБ) событие ставит задачи;
            если участников нет или указаны только e-mail — задача создаётся без ответственного, а в её карточке видны метка и адреса.
            При смене руководителя меняется одна строка здесь, правила остаются как есть.
          </div>
        </div>
      )}
      {isStatuses && (
        <div className="panel-b"><div className="hint">Набор статусов фиксирован: на нём построена доска задач. Названия можно менять.</div></div>
      )}
      {!isStatuses && (
        <div className="panel-b">
          <div className="hint">
            Используемое значение не удаляется, а уходит в архив: пропадает из списков выбора, старые записи его сохраняют.
            Системные значения (замок) не удаляются и не переименовываются.
          </div>
        </div>
      )}
    </section>
  );
}
