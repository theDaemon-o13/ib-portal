import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { settingsApi, type FormTemplate, type TemplateField } from '../../api/settings';
import { ReadOnlyNote } from '../../components/LockIcon';
import { CHECK_KINDS, checkKindLabel, needsThreshold, requirementText, type CheckKindKey } from './logic';
import { keys, useAction } from './useAction';
import { Select } from '../../components/Select';

interface FieldDraft {
  label: string;
  checkKind: CheckKindKey;
  threshold: string;
}
const emptyField: FieldDraft = { label: '', checkKind: 'min', threshold: '' };

function fieldBody(d: FieldDraft) {
  return {
    label: d.label,
    checkKind: d.checkKind,
    threshold: needsThreshold(d.checkKind) && d.threshold !== '' ? Number(d.threshold.replace(',', '.')) : null,
  };
}

function KindSelect({ value, onChange, form }: { value: CheckKindKey; onChange: (k: CheckKindKey) => void; form?: string }) {
  return (
    <Select form={form} className="inp" value={value} onChange={(e) => onChange(e.target.value as CheckKindKey)} aria-label="Тип проверки">
      {CHECK_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
    </Select>
  );
}

export function FormTemplatesEditor({ canEdit }: { canEdit: boolean }) {
  const list = useQuery({ queryKey: keys.templates, queryFn: () => settingsApi.templates(true) });
  const [selId, setSelId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newT, setNewT] = useState({ name: '', basis: '', validMonths: '12' });
  const [editId, setEditId] = useState<string | null>(null);
  const [edit, setEdit] = useState<FieldDraft>(emptyField);
  const [add, setAdd] = useState<FieldDraft>(emptyField);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const templates = list.data?.items ?? [];
  const t: FormTemplate | undefined = templates.find((x) => x.id === selId) ?? templates.find((x) => !x.archived) ?? templates[0];

  const invalidate = [keys.templates, keys.journal];
  const create = useAction(() => settingsApi.createTemplate({ name: newT.name, basis: newT.basis, validMonths: Number(newT.validMonths) }), {
    invalidate,
    success: (r) => `Шаблон «${r.name}» создан`,
    onDone: (r) => { setSelId(r.id); setCreating(false); setNewT({ name: '', basis: '', validMonths: '12' }); },
  });
  const archive = useAction((tpl: FormTemplate) => (tpl.archived ? settingsApi.restoreTemplate(tpl.id, tpl.version) : settingsApi.archiveTemplate(tpl.id, tpl.version)), {
    invalidate,
    success: (r) => (r.archived ? `Шаблон «${r.name}» в архиве: новые формы по нему не загружаются` : `Шаблон «${r.name}» снова доступен`),
  });
  const removeTpl = useAction((tpl: FormTemplate) => settingsApi.deleteTemplate(tpl.id, tpl.version), {
    invalidate,
    success: (_r, tpl) => `Шаблон «${tpl.name}» удалён`,
    onDone: () => { setSelId(null); setConfirmDelete(false); },
  });
  const addField = useAction((tpl: FormTemplate) => settingsApi.addField(tpl.id, fieldBody(add)), {
    invalidate, success: () => 'Поле добавлено', onDone: () => setAdd(emptyField),
  });
  const saveField = useAction((f: TemplateField) => settingsApi.updateField(f.id, { version: f.version, ...fieldBody(edit) }), {
    invalidate, success: () => 'Поле сохранено', onDone: () => setEditId(null),
  });
  const deleteField = useAction((f: TemplateField) => settingsApi.deleteField(f.id, f.version), {
    invalidate, success: () => 'Поле удалено. Уже загруженные формы его сохраняют',
  });
  const move = useAction(({ f, dir }: { f: TemplateField; dir: 'up' | 'down' }) => settingsApi.moveField(f.id, dir), { invalidate });

  const submitNew = (e: FormEvent) => { e.preventDefault(); create.mutate(undefined); };

  return (
    <section className="panel">
      <div className="panel-h">
        <div>
          <h3>Шаблоны форм подтверждения</h3>
          <span className="sub">Где используется: доказательная база — формы, которые заполняет ДИКТ, и поля в них</span>
        </div>
      </div>
      <div className="panel-b grid-gap">
        {!canEdit && <ReadOnlyNote who="роль с правом «Настройки: справочники и шаблоны форм»" />}
        <div className="filters">
          {templates.map((x) => (
            <button key={x.id} type="button" aria-pressed={x.id === t?.id} onClick={() => { setSelId(x.id); setEditId(null); setConfirmDelete(false); }}>
              {x.name}{x.archived ? ' (архив)' : ''}
            </button>
          ))}
          {canEdit && <button type="button" aria-pressed={creating} onClick={() => setCreating(!creating)}>+ Новый шаблон</button>}
        </div>
        {canEdit && creating && (
          <form className="field-form tpl-form rounded" onSubmit={submitNew}>
            <label>Название шаблона<input className="inp" required autoFocus placeholder="Например: Подтверждение резервного копирования" value={newT.name} onChange={(e) => setNewT({ ...newT, name: e.target.value })} /></label>
            <label>Основание (документ)<input className="inp" placeholder="Название документа" value={newT.basis} onChange={(e) => setNewT({ ...newT, basis: e.target.value })} /></label>
            <label>Действует, мес.<input className="inp" type="number" min={1} max={120} required value={newT.validMonths} onChange={(e) => setNewT({ ...newT, validMonths: e.target.value })} /></label>
            <button className="btn primary" type="submit" disabled={create.isPending}>Создать</button>
          </form>
        )}
        {t && (canEdit ? (
          // key: форма заново заполняется при смене шаблона или его версии.
          <TemplateProps key={`${t.id}:${t.version}`} t={t} />
        ) : (
          <div className="row gap-lg">
            <div><div className="eyebrow">Основание</div><div>{t.basis || '—'}</div></div>
            <div><div className="eyebrow">Действует</div><div>{t.validMonths} мес.</div></div>
          </div>
        ))}
        {t && (
          <div className="row">
            <span className="hint">
              По шаблону загружено форм: {t.usage}. Изменения полей касаются новых форм; уже загруженные сохраняют свои поля и значения.
            </span>
            {canEdit && (
              <>
                <button className="btn ghost sm" type="button" onClick={() => archive.mutate(t)} disabled={archive.isPending}>{t.archived ? 'Вернуть из архива' : 'В архив'}</button>
                {t.usage === 0 && (confirmDelete ? (
                  <>
                    <span className="hint">Удалить шаблон «{t.name}»?</span>
                    <button className="btn sm danger" type="button" onClick={() => removeTpl.mutate(t)} disabled={removeTpl.isPending}>Удалить</button>
                    <button className="btn sm" type="button" onClick={() => setConfirmDelete(false)}>Отмена</button>
                  </>
                ) : (
                  <button className="btn ghost sm danger-t" type="button" onClick={() => setConfirmDelete(true)}>Удалить шаблон</button>
                ))}
              </>
            )}
          </div>
        )}
      </div>
      {t && (
        <div className="tbl-wrap">
          <table className="cat-tbl">
            <thead><tr><th>Поле формы</th><th>Тип проверки</th><th>Требование</th><th /></tr></thead>
            <tbody>
              {t.fields.length === 0 && <tr><td colSpan={4} className="hint">В шаблоне пока нет полей</td></tr>}
              {t.fields.map((f, i) =>
                canEdit && editId === f.id ? (
                  // key отличается от строки просмотра: иначе React переиспользует нажатую «Изменить» как «Сохранить» (submit) и щелчок сразу отправит форму.
                  <tr key={`${f.id}:edit`} className="editing">
                    <td>
                      <form id={`fe-${f.id}`} onSubmit={(e) => {
                        e.preventDefault();
                        const same = edit.label.trim() === f.label && edit.checkKind === f.checkKind &&
                          fieldBody(edit).threshold === (needsThreshold(f.checkKind) ? f.threshold : null);
                        if (same) setEditId(null);
                        else saveField.mutate(f);
                      }} />
                      <input form={`fe-${f.id}`} className="inp" required autoFocus value={edit.label} onChange={(e) => setEdit({ ...edit, label: e.target.value })} aria-label="Поле формы" />
                    </td>
                    <td><KindSelect form={`fe-${f.id}`} value={edit.checkKind} onChange={(checkKind) => setEdit({ ...edit, checkKind })} /></td>
                    <td>
                      <input form={`fe-${f.id}`} className="inp" type="number" step="any" placeholder="для чисел"
                        disabled={!needsThreshold(edit.checkKind)} required={needsThreshold(edit.checkKind)}
                        value={needsThreshold(edit.checkKind) ? edit.threshold : ''} onChange={(e) => setEdit({ ...edit, threshold: e.target.value })} aria-label="Значение" />
                    </td>
                    <td>
                      <div className="row act">
                        <button className="btn primary sm" type="submit" form={`fe-${f.id}`} disabled={saveField.isPending}>Сохранить</button>
                        <button className="btn sm" type="button" onClick={() => setEditId(null)}>Отмена</button>
                      </div>
                    </td>
                  </tr>
                ) : (
                  <tr key={`${f.id}:view`}>
                    <td><b className="w500">{f.label}</b></td>
                    <td className="hint">{checkKindLabel(f.checkKind)}</td>
                    <td>{requirementText(f.checkKind, f.threshold)}</td>
                    <td>
                      {canEdit && (
                        <div className="row act">
                          <button className="btn ghost sm" type="button" aria-label="Выше" disabled={i === 0 || move.isPending} onClick={() => move.mutate({ f, dir: 'up' })}>↑</button>
                          <button className="btn ghost sm" type="button" aria-label="Ниже" disabled={i === t.fields.length - 1 || move.isPending} onClick={() => move.mutate({ f, dir: 'down' })}>↓</button>
                          <button className="btn ghost sm" type="button" onClick={() => { setEditId(f.id); setEdit({ label: f.label, checkKind: f.checkKind, threshold: f.threshold === null ? '' : String(f.threshold) }); }}>Изменить</button>
                          <button className="btn ghost sm danger-t" type="button" onClick={() => deleteField.mutate(f)} disabled={deleteField.isPending}>Удалить</button>
                        </div>
                      )}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
      {canEdit && t && (
        <form className="field-form cat-add with-field" onSubmit={(e) => { e.preventDefault(); addField.mutate(t); }}>
          <label>Новое поле<input className="inp" required placeholder="Например: Шифрование резервных копий" value={add.label} onChange={(e) => setAdd({ ...add, label: e.target.value })} /></label>
          <label>Тип проверки<KindSelect value={add.checkKind} onChange={(checkKind) => setAdd({ ...add, checkKind })} /></label>
          <label>
            Значение
            <input className="inp" type="number" step="any" placeholder="для чисел" disabled={!needsThreshold(add.checkKind)}
              required={needsThreshold(add.checkKind)} value={needsThreshold(add.checkKind) ? add.threshold : ''}
              onChange={(e) => setAdd({ ...add, threshold: e.target.value })} />
          </label>
          <button className="btn primary" type="submit" disabled={addField.isPending}>Добавить поле</button>
        </form>
      )}
    </section>
  );
}

function TemplateProps({ t }: { t: FormTemplate }) {
  const [props, setProps] = useState({ name: t.name, basis: t.basis, validMonths: String(t.validMonths) });
  const save = useAction(
    () => settingsApi.updateTemplate(t.id, { version: t.version, name: props.name, basis: props.basis, validMonths: Number(props.validMonths) }),
    { invalidate: [keys.templates, keys.journal], success: () => 'Шаблон сохранён' },
  );
  return (
    <form className="field-form tpl-form rounded" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined); }}>
      <label>Название шаблона<input className="inp" required value={props.name} onChange={(e) => setProps({ ...props, name: e.target.value })} /></label>
      <label>Основание (документ)<input className="inp" value={props.basis} onChange={(e) => setProps({ ...props, basis: e.target.value })} /></label>
      <label>Действует, мес.<input className="inp" type="number" min={1} max={120} required value={props.validMonths} onChange={(e) => setProps({ ...props, validMonths: e.target.value })} /></label>
      <button className="btn" type="submit" disabled={save.isPending}>Сохранить шаблон</button>
    </form>
  );
}
