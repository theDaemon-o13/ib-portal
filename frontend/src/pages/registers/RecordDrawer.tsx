import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AutoTextarea } from '../../components/AutoTextarea';
import { Overlay } from '../../components/Overlay';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError } from '../../api/client';
import { registersApi, VULN_REGISTER_KEY, type RegisterDetail, type RegisterField, type RegisterRecord } from '../../api/registers';
import { settingsApi } from '../../api/settings';
import { useToast } from '../../components/Toast';
import { formatDateTime } from '../settings/logic';
import { changedValues, deadlineChip, describeRule, draftOf, EVENT_TYPE_NAMES, formatCalc, formatDate, isBasisRule, reasonFields, type Draft } from './logic';
import { Backlinks, BasisField, FileField, LinkField } from './RecordLinks';
import { EventTasks } from './AutomationTab';
import { DecisionBlock } from './DecisionBlock';
import { rkeys } from './keys';
import { useMe } from '../../auth/useMe';

const LONG = /описан|коммент|мер|примечан/i;
// Лимиты — как на backend (lib/field-settings.ts).
const TEXT_MAX = 4000;
const TEXT_MAX_MULTILINE = 20_000;

const VIA: Record<string, string> = {
  import: ' · импорт Excel', type_change: ' · смена типа поля', scan_import: ' · отчёт сканера', auto: ' · пересчёт', automation: ' · автоматизация',
  files: ' · файлы', compare: ' · сравнение с файлом (статус по отчёту)',
};

/** Критичность уязвимости: считается по Оценке, пока её не исправили вручную. */
const isDerived = (reg: RegisterDetail, f: RegisterField) => reg.systemKey === VULN_REGISTER_KEY && f.systemKey === 'crit';

function FieldControl({ reg, f, rec, draft, setDraft, disabled, onResetAuto, resetting, canDecide, onDecided }: {
  reg: RegisterDetail; f: RegisterField; rec: RegisterRecord | null; draft: Draft; setDraft: (d: Draft) => void; disabled: boolean;
  onResetAuto: (fieldId: string) => void; resetting: boolean;
  /** Внести решение другого отдела (records.edit). */
  canDecide: boolean;
  onDecided: (r: RegisterRecord) => Promise<void>;
}) {
  const users = useQuery({ queryKey: rkeys.userOptions, queryFn: settingsApi.userOptions, enabled: f.type === 'user' });
  const v = draft[f.id] ?? '';
  const set = (value: string) => setDraft({ ...draft, [f.id]: value });
  const id = `rf-${f.id}`;
  // Фиксация статусом (этап 8б): заполненное зафиксированное поле — только чтение.
  const lockedNow = rec?.locked[f.id] === 'locked' && (rec.values[f.id] ?? '') !== '';
  disabled = disabled || lockedNow;
  let control: ReactNode;
  switch (f.type) {
    case 'file':
      control = <FileField f={f} rec={rec} canEdit={canDecide} onChanged={onDecided} />;
      break;
    case 'link':
      control = <LinkField f={f} rec={rec} value={v} onChange={set} disabled={disabled} />;
      break;
    case 'calc':
      if (isBasisRule(f.calcRule)) {
        control = <BasisField f={f} rec={rec} />;
        break;
      }
      control = (
        <div className="ro">
          <b className="mono">{formatCalc(rec?.calc[f.id]) || '—'}</b>
          <small>Считается: {describeRule(reg, f)}. Только чтение.</small>
        </div>
      );
      break;
    case 'decision':
      control = rec
        ? <DecisionBlock reg={reg} f={f} rec={rec} canEdit={canDecide} onSaved={onDecided} />
        : (
          <div className="ro">
            <span className="chip info">{f.options.find((o) => !o.archived)?.label ?? '—'}</span>
            <small>Решение вносится после сохранения записи, с документом-основанием</small>
          </div>
        );
      break;
    case 'catalog': {
      // Значения — из справочника (правятся в настройках).
      const opts = f.options.filter((o) => !o.archived || o.id === v);
      control = (
        <select id={id} className="inp" value={v} disabled={disabled} onChange={(e) => set(e.target.value)}>
          <option value="">—</option>
          {opts.map((o) => <option key={o.id} value={o.id}>{o.label}{o.archived ? ' (архив)' : ''}</option>)}
        </select>
      );
      break;
    }
    case 'select': {
      const opts = f.options.filter((o) => !o.archived || o.id === v);
      const select = (
        <select id={id} className="inp" value={v} disabled={disabled} onChange={(e) => set(e.target.value)}>
          <option value="">{isDerived(reg, f) ? '— считать автоматически' : '—'}</option>
          {opts.map((o) => <option key={o.id} value={o.id}>{o.label}{o.archived ? ' (архив)' : ''}</option>)}
        </select>
      );
      if (!isDerived(reg, f)) {
        control = select;
        break;
      }
      const manual = !!rec?.manualFieldIds.includes(f.id);
      control = (
        <>
          {select}
          {manual ? (
            <small className="row nowrap">
              <span className="chip high">вручную</span> Пересчёт по Оценке её не меняет.
              {!disabled && rec && (
                <button className="btn ghost sm" type="button" disabled={resetting} onClick={() => onResetAuto(f.id)}>Считать автоматически</button>
              )}
            </small>
          ) : (
            <small>Считается по Оценке: ≥ 9,0 — критическая, ≥ 7,0 — высокая, ≥ 4,0 — средняя; нет CVSS — высокая. Выберите значение, чтобы поправить вручную.</small>
          )}
        </>
      );
      break;
    }
    case 'user': {
      const list = users.data?.items ?? [];
      const current = v && !list.some((u) => u.id === v) ? [{ id: v, fullName: rec?.display[f.id] || 'Сотрудник', login: '' }] : [];
      control = (
        <select id={id} className="inp" value={v} disabled={disabled} onChange={(e) => set(e.target.value)}>
          <option value="">—</option>
          {[...list, ...current].map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
        </select>
      );
      break;
    }
    case 'number':
      control = <input id={id} className="inp" inputMode="decimal" value={v} disabled={disabled} onChange={(e) => set(e.target.value)} />;
      break;
    case 'date':
      control = <input id={id} className="inp" type="date" value={v} disabled={disabled} onChange={(e) => set(e.target.value)} />;
      break;
    default:
      control = f.settings.text?.multiline
        ? <AutoTextarea id={id} value={v} disabled={disabled} maxLength={TEXT_MAX_MULTILINE} onChange={(e) => set(e.target.value)} />
        : LONG.test(f.label)
          ? <textarea id={id} className="inp" value={v} disabled={disabled} maxLength={TEXT_MAX} onChange={(e) => set(e.target.value)} />
          : <input id={id} className="inp" value={v} disabled={disabled} maxLength={TEXT_MAX} required={f.isTitle} onChange={(e) => set(e.target.value)} />;
  }
  const wide = f.isTitle || f.type === 'decision' || f.type === 'calc' || f.type === 'file' || f.type === 'link'
    || (f.type === 'text' && (!!f.settings.text?.multiline || LONG.test(f.label)));
  const lockNote = lockedNow
    ? <small className="row nowrap"><span className="chip">зафиксировано</span> Статус «{rec ? rec.display[reg.fields.find((x) => x.isStatus)?.id ?? ''] : ''}» — изменить можно только новой записью</small>
    : rec?.locked[f.id] === 'reason' && f.type !== 'file' ? <small>При этом статусе меняется только с причиной — её спросят при сохранении.</small> : null;
  // Решение, файлы и связь — с кнопками: не <label>, иначе щелчок по подписи нажимал бы кнопку.
  if (f.type === 'decision' || f.type === 'file' || f.type === 'link') {
    return (
      <div className="wide field-block" role="group" aria-label={f.label}>
        <span className="field-label">{f.label}</span>
        {control}
        {f.type === 'link' && lockNote}
      </div>
    );
  }
  return (
    <label className={wide ? 'wide' : undefined} htmlFor={f.type === 'calc' ? undefined : id}>
      {f.label}
      {control}
      {lockNote}
    </label>
  );
}

/** Карточка записи: форма собирается из описания полей реестра. */
export function RecordDrawer({ reg, recordId, canEdit, canDelete, onClose, onCreated }: {
  reg: RegisterDetail; recordId: string | null; canEdit: boolean; canDelete: boolean; onClose: () => void; onCreated: (id: string) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const isNew = recordId === null;
  const rec = useQuery({ queryKey: rkeys.record(recordId ?? 'new'), queryFn: () => registersApi.record(recordId ?? ''), enabled: !isNew });
  // История — по праву «История в карточках» (ADR-0021).
  const canHistory = !!useMe().data?.permissions.includes('history.view');
  const history = useQuery({ queryKey: rkeys.history(recordId ?? 'new'), queryFn: () => registersApi.history(recordId ?? ''), enabled: !isNew && canHistory });
  const record = rec.data ?? null;
  const events = useQuery({
    queryKey: [...rkeys.events(reg.id), 'record', recordId ?? 'new'],
    queryFn: () => registersApi.events(reg.id, { recordId: recordId ?? '' }),
    enabled: !isNew,
  });
  const [draft, setDraft] = useState<Draft>(() => draftOf(reg, null));
  const [original, setOriginal] = useState<Draft>(() => draftOf(reg, null));
  const [loadedVersion, setLoadedVersion] = useState<number | null>(null);
  const [conflict, setConflict] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reason, setReason] = useState('');

  // Черновик заполняется из записи при открытии и после «Перечитать».
  useEffect(() => {
    if (record && loadedVersion === null) {
      const d = draftOf(reg, record);
      setDraft(d);
      setOriginal(d);
      setLoadedVersion(record.version);
    }
  }, [record, loadedVersion, reg]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: rkeys.records(reg.id) }),
      qc.invalidateQueries({ queryKey: rkeys.list }),
      recordId ? qc.invalidateQueries({ queryKey: rkeys.history(recordId) }) : Promise.resolve(),
      qc.invalidateQueries({ queryKey: rkeys.events(reg.id) }),
    ]);
  };
  const onError = (e: unknown) => {
    if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
      setConflict(true);
      return;
    }
    toast(e instanceof Error ? e.message : 'Не удалось сохранить', 'error');
  };

  const save = useMutation({
    mutationFn: async () => {
      const values = changedValues(reg, original, draft);
      if (isNew) return registersApi.createRecord(reg.id, values);
      if (Object.keys(values).length === 0 || !record) return null;
      if (reasonFields(reg, record, values).length && !reason.trim()) throw new Error('Укажите причину изменения');
      return registersApi.updateRecord(record.id, record.version, values, reason.trim() || undefined);
    },
    onSuccess: async (r) => {
      if (!r) {
        toast('Изменений нет');
        return;
      }
      qc.setQueryData(rkeys.record(r.id), r);
      const d = draftOf(reg, r);
      setDraft(d);
      setOriginal(d);
      setLoadedVersion(r.version);
      setReason('');
      await refresh();
      toast(isNew ? `Запись #${r.number} создана` : `Запись #${r.number} сохранена`);
      if (isNew) onCreated(r.id);
    },
    onError,
  });
  const archive = useMutation({
    mutationFn: () => (record?.archived ? registersApi.restoreRecord(record.id, record.version) : registersApi.archiveRecord(record?.id ?? '', record?.version ?? 0)),
    onSuccess: async (r) => {
      qc.setQueryData(rkeys.record(r.id), r);
      setLoadedVersion(null);
      await refresh();
      toast(r.archived ? `Запись #${r.number} в архиве` : `Запись #${r.number} возвращена`);
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: () => registersApi.deleteRecord(record?.id ?? '', record?.version ?? 0),
    onSuccess: async () => {
      // Сначала закрыть и забыть удалённую запись: иначе история перечитывалась бы (404) с повторами.
      onClose();
      if (recordId) for (const key of [rkeys.record(recordId), rkeys.history(recordId)]) qc.removeQueries({ queryKey: key });
      toast(`Запись #${record?.number ?? ''} удалена`);
      await Promise.all([qc.invalidateQueries({ queryKey: rkeys.records(reg.id) }), qc.invalidateQueries({ queryKey: rkeys.list })]);
    },
    onError,
  });

  const resetAuto = useMutation({
    mutationFn: (fieldId: string) => registersApi.resetToAuto(record?.id ?? '', fieldId, record?.version ?? 0),
    onSuccess: async (r) => {
      qc.setQueryData(rkeys.record(r.id), r);
      const d = draftOf(reg, r);
      setDraft(d);
      setOriginal(d);
      setLoadedVersion(r.version);
      await refresh();
      toast('Критичность снова считается по Оценке');
    },
    onError,
  });

  /** Решение внесено: запись стала новее (версия, «№ ОУР», «Пересмотр до») — черновик обновляется. */
  const onDecided = async (r: RegisterRecord) => {
    qc.setQueryData(rkeys.record(r.id), r);
    const d = draftOf(reg, r);
    setDraft(d);
    setOriginal(d);
    setLoadedVersion(r.version);
    await refresh();
  };

  /** Перечитать запись после конфликта: свежие данные, черновик заменяется. */
  const reload = async () => {
    setConflict(false);
    setLoadedVersion(null);
    await rec.refetch();
    await refresh();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  const readOnly = !canEdit || !!record?.archived;
  const needReason = reasonFields(reg, record, changedValues(reg, original, draft));
  const fields = reg.fields.filter((f) => !f.archived);
  const titleField = reg.fields.find((f) => f.isTitle);
  const title = isNew ? 'Новая запись' : (record?.display[titleField?.id ?? ''] || 'Без названия');

  return (
    <Overlay>
      <div className="backdrop drawer-backdrop" role="presentation" onClick={onClose} />
      <aside className="drawer wide" role="dialog" aria-modal="true" aria-label="Запись реестра">
        <div className="dr-h">
          <div className="min0">
            <div className="eyebrow">{reg.name} · {isNew ? 'новая запись' : `запись #${record?.number ?? ''}`}</div>
            <b className="dr-title">{title}</b>
            {record?.closed && <div><span className="chip">Закрыта</span></div>}
            {record && !record.closed && deadlineChip(record.deadline) && (
              <div><span className={`chip ${deadlineChip(record.deadline)?.cls ?? ''}`}>{deadlineChip(record.deadline)?.text}</span></div>
            )}
            {record?.archived && <div><span className="chip">В архиве</span></div>}
          </div>
          <button className="btn sm" type="button" onClick={onClose}>Закрыть</button>
        </div>
        <div className="dr-b">
          {conflict && (
            <div className="note conflict" role="alert">
              Запись изменил другой пользователь — ваши изменения не сохранены.
              <div className="row mt6">
                <button className="btn sm primary" type="button" onClick={() => void reload()}>Перечитать запись</button>
                <span className="hint">Ваши значения будут заменены актуальными. Скопируйте их, если нужно.</span>
              </div>
            </div>
          )}
          {!isNew && rec.isPending ? <div className="hint">Загрузка…</div> : (
            <form className="recform" onSubmit={submit}>
              {fields.map((f) => (
                <FieldControl key={f.id} reg={reg} f={f} rec={record} draft={draft} setDraft={setDraft} disabled={readOnly}
                  onResetAuto={(id) => resetAuto.mutate(id)} resetting={resetAuto.isPending}
                  canDecide={canEdit} onDecided={onDecided} />
              ))}
              {needReason.length > 0 && (
                <label className="wide">
                  Причина изменения ({needReason.map((f) => `«${f.label}»`).join(', ')})
                  <textarea className="inp" required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Например: замена ноутбука, заявка №…" />
                  <small>Причина попадёт в историю записи и журнал.</small>
                </label>
              )}
              <div className="wide row">
                {!readOnly && <button className="btn primary" type="submit" disabled={save.isPending || conflict}>{isNew ? 'Создать запись' : 'Сохранить'}</button>}
                <button className="btn" type="button" onClick={onClose}>{readOnly ? 'Закрыть' : 'Отмена'}</button>
                <span className="hint">Поля формы берутся из конструктора: новое поле реестра сразу появляется здесь.</span>
              </div>
            </form>
          )}
          {!isNew && record && (canEdit || canDelete) && (
            <div className="row">
              {canEdit && (
                <button className="btn sm" type="button" onClick={() => archive.mutate()} disabled={archive.isPending}>
                  {record.archived ? 'Вернуть из архива' : 'В архив'}
                </button>
              )}
              {canDelete && !confirmDelete && (
                <button className="btn sm danger-t" type="button" onClick={() => setConfirmDelete(true)}>Удалить запись</button>
              )}
            </div>
          )}
          {confirmDelete && (
            <div className="danger-zone">
              <div>Удалить запись #{record?.number}? Она пропадёт из реестра; в журнале останется снимок значений.</div>
              <div className="row">
                <button className="btn sm danger" type="button" onClick={() => remove.mutate()} disabled={remove.isPending}>Удалить</button>
                <button className="btn sm" type="button" onClick={() => setConfirmDelete(false)}>Отмена</button>
              </div>
            </div>
          )}
          {!isNew && (events.data?.items.length ?? 0) > 0 && (
            <div>
              <div className="eyebrow">События автоматизаций</div>
              <div className="hist">
                {events.data?.items.map((e) => (
                  <div key={e.id} className={`hist-item ev ${e.status}`}>
                    <div className="row nowrap">
                      <span className={`chip ${e.eventType === 'escalate' ? 'crit' : e.eventType === 'notify' ? 'high' : 'info'}`}>{EVENT_TYPE_NAMES[e.eventType]}</span>
                      <span>{formatDate(e.fireAt)}</span>
                      <EventTasks e={e} />
                    </div>
                    <div className="m">{e.when} → кому: {e.recipients.map((r) => (r.kind === 'user' ? r.name : r.label)).join(', ')}</div>
                  </div>
                ))}
              </div>
              <div className="hint">Каждое событие становится задачами получателям; повтор по открытой задаче — комментарий в ней.</div>
            </div>
          )}
          {!isNew && recordId && <Backlinks recordId={recordId} />}
          {!isNew && canHistory && (
            <div>
              <div className="eyebrow">История изменений</div>
              {history.data?.items.length === 0 && <div className="hint">Изменений нет</div>}
              <div className="hist">
                {history.data?.items.map((h) => (
                  <div key={h.id} className="hist-item">
                    <div>{formatDateTime(h.at)} · {h.actor?.fullName ?? 'Система'}{(h.via && VIA[h.via]) ?? ''}</div>
                    {h.changes.length > 0 ? (
                      <ul>{h.changes.map((c, i) => <li key={i}>«{c.label}»: {c.from || '—'} → {c.to || '—'}</li>)}</ul>
                    ) : <div className="m">{h.summary}</div>}
                    {h.reason && <div className="m">Причина: {h.reason}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </aside>
    </Overlay>
  );
}
