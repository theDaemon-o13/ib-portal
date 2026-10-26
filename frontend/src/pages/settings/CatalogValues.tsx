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
}

const sameDraft = (a: Draft, b: Draft) =>
  a.value.trim() === b.value.trim() && a.color === b.color && a.ownerUserId === b.ownerUserId &&
  parseKeywords(a.keywords).join('|') === parseKeywords(b.keywords).join('|');

const draftOf = (i?: CatalogItem): Draft => ({
  value: i?.value ?? '',
  color: (i?.color ?? 'muted') as ToneKey,
  keywords: i?.keywords.join(', ') ?? '',
  ownerUserId: i?.owner?.id ?? '',
});

export function CatalogValues({ catalog, canEdit }: { catalog: Catalog; canEdit: boolean }) {
  const isMail = catalog.kind === 'mail_rules';
  const isStatuses = catalog.kind === 'statuses';
  const items = useQuery({ queryKey: keys.items(catalog.code), queryFn: () => settingsApi.items(catalog.code, true) });
  const owners = useQuery({ queryKey: keys.userOptions, queryFn: settingsApi.userOptions, enabled: isMail });
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
      }),
    { invalidate, success: (r) => `Сохранено: «${r.value}»`, onDone: () => setEditId(null) },
  );
  const create = useAction(
    (d: Draft) =>
      settingsApi.createItem(catalog.code, {
        value: d.value,
        ...(catalog.hasColor ? { color: d.color } : {}),
        ...(isMail ? { keywords: parseKeywords(d.keywords), ownerUserId: d.ownerUserId || null } : {}),
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

  const rows = items.data?.items ?? [];
  const colCount = 3 + (isMail ? 2 : 1);

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
              <th>{isMail ? 'Категория письма' : 'Значение'}</th>
              {isMail && <th>Ключевые слова</th>}
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
        <form className={`field-form cat-add${catalog.hasColor ? ' with-color' : ''}${isMail ? ' with-mail' : ''}`} onSubmit={submitAdd}>
          <label>
            {isMail ? 'Новая категория письма' : 'Новое значение'}
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
          <button className="btn primary" type="submit" disabled={create.isPending}>Добавить</button>
        </form>
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
