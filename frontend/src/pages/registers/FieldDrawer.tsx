import { Overlay } from '../../components/Overlay';
import { useEffect, useState } from 'react';
import { registersApi, type BasisRule, type DueRule, type FieldType, type RegisterDetail, type RegisterField, type TypePreview } from '../../api/registers';
import { useAction } from '../settings/useAction';
import { BasisRuleEditor, CalcRuleEditor, OptionsEditor, SettingsEditor } from './FieldEditors';
import { ALLOWED_ROLES, describeRule, dueRuleOf, isBasisRule, ROLE_NAMES, TYPE_NAMES, typeTargets } from './logic';
import { rkeys } from './keys';

const KIND_TEXT: Record<TypePreview['kind'], string> = {
  empty: 'В поле нет данных — тип меняется без изменения записей.',
  to_text: 'Значения превратятся в текст как есть на экране. Обратно в прежний тип автоматически не вернуть.',
  from_text: 'Каждое значение должно распознаваться. Если хоть одно не подходит — тип не меняется.',
};

/** Смена типа поля внутри панели: всегда с предпросмотром «изменится N записей». */
function TypeChange({ reg, field, onDone }: { reg: RegisterDetail; field: RegisterField; onDone: () => void }) {
  const targets = typeTargets(field.type);
  const [to, setTo] = useState<FieldType>(targets[0] ?? 'text');
  const [preview, setPreview] = useState<TypePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    registersApi.previewType(field.id, to)
      .then((p) => { if (!cancelled) setPreview(p); })
      .catch((e: unknown) => { if (!cancelled) { setPreview(null); setError(e instanceof Error ? e.message : 'Не удалось'); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [field.id, to]);
  const apply = useAction(() => registersApi.changeType(field.id, field.version, to), {
    invalidate: [rkeys.detail(reg.id), rkeys.records(reg.id), rkeys.analytics(reg.id)],
    success: () => `Тип поля «${field.label}» изменён: ${TYPE_NAMES[field.type]} → ${TYPE_NAMES[to]}`,
    onDone,
  });
  return (
    <div className="type-change grid-gap">
      <label className="fd-label">Новый тип
        <select className="inp" value={to} onChange={(e) => setTo(e.target.value as FieldType)} aria-label="Новый тип">
          {targets.map((t) => <option key={t} value={t}>{TYPE_NAMES[t]}</option>)}
        </select>
      </label>
      {loading && <div className="hint">Считаем…</div>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {preview && !loading && (
        <>
          <div className="note"><b>Изменится записей: {preview.affected}.</b> {KIND_TEXT[preview.kind]}</div>
          {preview.newOptions.length > 0 && <div className="hint">Будут созданы значения списка: {preview.newOptions.join(', ')}</div>}
          {preview.samples.length > 0 && (
            <table className="cat-tbl">
              <thead><tr><th>Запись</th><th>Было</th><th>Станет</th></tr></thead>
              <tbody>{preview.samples.map((s) => <tr key={s.number}><td className="mono">#{s.number}</td><td>{s.from}</td><td>{s.to}</td></tr>)}</tbody>
            </table>
          )}
          {preview.errors.length > 0 && (
            <>
              <p className="form-error">Не распознаны значения в {preview.errors.length} записях — исправьте их и повторите:</p>
              <ul className="err-list">{preview.errors.slice(0, 20).map((e) => <li key={e.number}>#{e.number}: «{e.value}»</li>)}</ul>
            </>
          )}
        </>
      )}
      <div className="row">
        <button className="btn primary sm" type="button" disabled={!preview || preview.errors.length > 0 || loading || apply.isPending} onClick={() => apply.mutate(undefined)}>
          Сменить тип{preview ? ` (${preview.affected})` : ''}
        </button>
        <button className="btn sm" type="button" onClick={onDone}>Отмена</button>
      </div>
    </div>
  );
}

/** Боковая панель «Настройки поля»: всё, что меняет поле, — здесь, а не в строке таблицы. */
export function FieldDrawer({ reg, fieldId, onClose }: { reg: RegisterDetail; fieldId: string; onClose: () => void }) {
  const field = reg.fields.find((f) => f.id === fieldId);
  const [label, setLabel] = useState(field?.label ?? '');
  const [changingType, setChangingType] = useState(false);
  const [rule, setRule] = useState<DueRule | null>(field ? dueRuleOf(field) : null);
  const [basis, setBasis] = useState<BasisRule | null>(field && isBasisRule(field.calcRule) ? field.calcRule : null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const invalidate = [rkeys.detail(reg.id), rkeys.records(reg.id), rkeys.list, rkeys.analytics(reg.id)];
  const patch = useAction(({ body, ok }: { body: Omit<Parameters<typeof registersApi.updateField>[1], 'version'>; ok: string }) =>
    registersApi.updateField(fieldId, { version: field?.version ?? 0, ...body }).then(() => ok), { invalidate, success: (ok) => ok });
  const archive = useAction(() => (field?.archived ? registersApi.restoreField(fieldId, field.version) : registersApi.archiveField(fieldId, field?.version ?? 0)), {
    invalidate, success: () => (field?.archived ? `Поле «${field.label}» возвращено` : `Поле «${field?.label ?? ''}» в архиве: значения сохранены`),
  });
  const remove = useAction(() => registersApi.deleteField(fieldId, field?.version ?? 0), {
    invalidate, success: () => `Поле «${field?.label ?? ''}» удалено`, onDone: onClose,
  });

  if (!field) return null;
  const roles = ALLOWED_ROLES[field.type];
  // Системное поле (реестр уязвимостей): переименовать можно, остальное держит формулы и импорт сканера.
  const system = !!field.systemKey;
  const canDetach = !field.isTitle && !field.isStatus && !field.isImportKey && !system;

  return (
    <Overlay>
      <div className="backdrop drawer-backdrop" role="presentation" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Настройки поля">
        <div className="dr-h">
          <div className="min0">
            <div className="eyebrow">{reg.name} · настройки поля</div>
            <b className="dr-title">{field.label}</b>
            <div className="cover mt6">
              <span className="type">{TYPE_NAMES[field.type]}</span>
              {field.isTitle && <span className="chip acc">Заголовок</span>}
              {field.isStatus && <span className="chip info">Статус</span>}
              {field.isImportKey && <span className="chip acc" title="Импорт Excel без колонки ID сопоставляет строки по этому полю">Ключ импорта</span>}
              {field.archived && <span className="chip">В архиве</span>}
              {system && <span className="chip" title="Не удаляется, не архивируется, тип не меняется">Системное</span>}
            </div>
          </div>
          <button className="btn sm" type="button" onClick={onClose}>Закрыть</button>
        </div>
        <div className="dr-b">
          <form className="fd-section" onSubmit={(e) => {
            e.preventDefault();
            if (label.trim() !== field.label) patch.mutate({ body: { label }, ok: `Поле переименовано: «${label.trim()}». Данные записей не изменились` });
          }}>
            <label className="fd-label">Название
              <div className="row nowrap">
                <input className="inp" required value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Название поля" />
                <button className="btn primary sm" type="submit" disabled={patch.isPending || label.trim() === field.label}>Сохранить</button>
              </div>
            </label>
          </form>

          <section className="fd-section">
            <div className="eyebrow">Тип</div>
            {changingType ? (
              <TypeChange reg={reg} field={field} onDone={() => setChangingType(false)} />
            ) : (
              <div className="row">
                <span>{TYPE_NAMES[field.type]}</span>
                {typeTargets(field.type).length > 0 && canDetach && !field.archived ? (
                  <button className="btn sm" type="button" onClick={() => setChangingType(true)}>Сменить тип</button>
                ) : (
                  <span className="hint">
                    {system ? 'Тип системного поля не меняется' : ['calc', 'decision', 'file', 'link'].includes(field.type) ? 'Тип этого поля не меняется' : field.isTitle ? 'Заголовок всегда текстовый' : field.isStatus ? 'Сначала снимите признак статуса' : ''}
                  </span>
                )}
              </div>
            )}
          </section>

          {field.type === 'catalog' && (
            <section className="fd-section">
              <div className="eyebrow">Значения</div>
              <div className="hint">Значения берутся из справочника и правятся в «Настройки → Справочники». Переименование значения ничего не ломает: записи ссылаются на него по id.</div>
              <div className="cover">{field.options.filter((o) => !o.archived).map((o) => <span key={o.id} className="chip">{o.label}</span>)}</div>
            </section>
          )}

          {(field.type === 'select' || field.type === 'decision') && (
            <section className="fd-section">
              <div className="eyebrow">Значения списка</div>
              <OptionsEditor reg={reg} field={field} canManage />
            </section>
          )}

          {field.type === 'calc' && (
            <section className="fd-section grid-gap">
              <div className="eyebrow">Правило вычисления</div>
              <div className="hint">{describeRule(reg, field)}</div>
              {system ? (
                <div className="hint">Правило задано процедурой управления уязвимостями (п. 7.1–7.3) и меняется только выпуском портала.</div>
              ) : isBasisRule(field.calcRule) ? (
                <>
                  <BasisRuleEditor reg={reg} value={basis} onChange={setBasis} selfId={field.id} />
                  <div className="row">
                    <button className="btn primary sm" type="button" disabled={!basis || patch.isPending}
                      onClick={() => patch.mutate({ body: { calcRule: basis ?? undefined }, ok: 'Правило сохранено' })}>Сохранить правило</button>
                  </div>
                </>
              ) : (
                <>
                  <CalcRuleEditor reg={reg} value={rule} onChange={setRule} selfId={field.id} />
                  <div className="row">
                    <button className="btn primary sm" type="button" disabled={!rule || patch.isPending}
                      onClick={() => patch.mutate({ body: { calcRule: rule ?? undefined }, ok: 'Правило сохранено' })}>Сохранить правило</button>
                  </div>
                </>
              )}
            </section>
          )}

          {field.type !== 'calc' && field.type !== 'decision' && !field.isStatus && (
            <section className="fd-section grid-gap">
              <div className="eyebrow">{field.type === 'text' ? 'Вид и ограничения' : 'Фиксация и ограничения'}</div>
              <SettingsEditor reg={reg} field={field} pending={patch.isPending}
                onSave={(settings) => patch.mutate({ body: { settings }, ok: settings ? 'Настройки поля сохранены' : 'Настройки поля сняты' })} />
            </section>
          )}

          {field.type === 'link' && (
            <section className="fd-section">
              <div className="eyebrow">Связь</div>
              <div className="hint">Реестр связи выбирается при создании поля и не меняется. В карточке связанной записи — обратный список со статусом и сроком. В Excel — заголовки записей (например, имена хостов) через «;».</div>
            </section>
          )}

          <section className="fd-section grid-gap">
            <div className="eyebrow">Роль в реестре</div>
            <div className="row">
              {field.type === 'text' && !field.isTitle && !field.archived && !reg.fields.some((f) => f.isTitle && f.systemKey) && (
                <button className="btn sm" type="button" onClick={() => patch.mutate({ body: { isTitle: true }, ok: `«${field.label}» — заголовок записи` })}>Сделать заголовком</button>
              )}
              {field.type === 'select' && !field.archived && !reg.fields.some((f) => f.isStatus && f.systemKey) && (
                <button className="btn sm" type="button" onClick={() => patch.mutate({ body: { isStatus: !field.isStatus }, ok: field.isStatus ? 'Поле больше не статус' : `«${field.label}» — поле статуса` })}>
                  {field.isStatus ? 'Снять признак статуса' : 'Сделать статусом'}
                </button>
              )}
              {field.type === 'text' && !field.archived && (
                <button className="btn sm" type="button" disabled={patch.isPending}
                  onClick={() => patch.mutate({ body: { isImportKey: !field.isImportKey }, ok: field.isImportKey ? 'Поле больше не ключ импорта' : `«${field.label}» — ключ импорта: файл без колонки ID сопоставляется по нему` })}>
                  {field.isImportKey ? 'Снять ключ импорта' : 'Сделать ключом импорта'}
                </button>
              )}
              {field.isTitle && <span className="hint">Это заголовок записи. Чтобы сменить, назначьте заголовком другое текстовое поле.</span>}
              {field.isImportKey && <span className="hint">Значения уникальны (без учёта регистра и пробелов). Импорт без колонки ID: найдена запись — обновление, нет — новая.</span>}
              {field.type !== 'text' && field.type !== 'select' && <span className="hint">Заголовком бывает текстовое поле, статусом — список.</span>}
            </div>
            <label className="fd-label">Для аналитики
              <select className="inp" value={field.analyticsRole ?? ''} disabled={roles.length === 0 || field.archived || patch.isPending}
                onChange={(e) => patch.mutate({ body: { analyticsRole: (e.target.value || null) as 'dimension' | null }, ok: 'Роль для аналитики сохранена' })}>
                {['', ...roles].map((r) => <option key={r} value={r}>{ROLE_NAMES[r]}</option>)}
              </select>
            </label>
          </section>

          <section className="fd-section grid-gap">
            <div className="eyebrow">Архив и удаление</div>
            {canDetach ? (
              <>
                <div className="row">
                  <button className="btn sm" type="button" onClick={() => archive.mutate(undefined)} disabled={archive.isPending}>
                    {field.archived ? 'Вернуть из архива' : 'В архив'}
                  </button>
                  {!confirmDelete && <button className="btn sm danger-t" type="button" onClick={() => setConfirmDelete(true)}>Удалить поле</button>}
                </div>
                <div className="hint">Архивное поле скрыто из формы, таблицы и выгрузки, значения сохраняются. Удалить можно только поле без данных.</div>
                {confirmDelete && (
                  <div className="danger-zone">
                    <div>Удалить поле «{field.label}»? Если в нём есть данные, портал не даст удалить — отправьте поле в архив.</div>
                    <div className="row">
                      <button className="btn sm danger" type="button" onClick={() => remove.mutate(undefined)} disabled={remove.isPending}>Удалить</button>
                      <button className="btn sm" type="button" onClick={() => setConfirmDelete(false)}>Отмена</button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="hint">{system ? 'Системное поле нельзя отправить в архив или удалить: на нём держатся формулы, импорт сканера и автоматизации.' : 'Поле-заголовок и поле статуса нельзя отправить в архив или удалить.'}</div>
            )}
          </section>
        </div>
      </aside>
    </Overlay>
  );
}
