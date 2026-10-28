import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { registersApi, type RegisterDetail, type RegisterListItem } from '../../api/registers';
import { Overlay } from '../../components/Overlay';
import { useAction } from '../settings/useAction';
import { rkeys } from './keys';
import { BulkDialog } from './BulkDialog';

export type RegTab = 'records' | 'fields' | 'automation';

export const REG_TABS: { key: RegTab; title: string; disabled?: string }[] = [
  { key: 'records', title: 'Записи' },
  { key: 'fields', title: 'Поля' },
  { key: 'automation', title: 'Автоматизация' },
];

/** Закрыть выпадающее окно по щелчку снаружи и по Escape. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, close]);
  return ref;
}

/** Выбор реестра: поиск, архивные, создание нового. */
function RegisterPicker({ current, canManage, onPick }: { current: RegisterDetail | undefined; canManage: boolean; onPick: (id: string, tab?: RegTab) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [archived, setArchived] = useState(false);
  const [newName, setNewName] = useState('');
  const ref = useDismiss(open, () => setOpen(false));
  const list = useQuery({ queryKey: rkeys.listWith(archived), queryFn: () => registersApi.list(archived) });
  const create = useAction(() => registersApi.create({ name: newName }), {
    invalidate: [rkeys.list],
    success: (r) => `Реестр «${r.name}» создан`,
    onDone: (r) => { setNewName(''); setOpen(false); onPick(r.id, 'fields'); },
  });
  const items = (list.data?.items ?? []).filter((r) => r.name.toLowerCase().includes(q.trim().toLowerCase()));
  const submit = (e: FormEvent) => { e.preventDefault(); create.mutate(undefined); };
  const pick = (r: RegisterListItem) => { setOpen(false); setQ(''); onPick(r.id); };

  return (
    <div className="picker" ref={ref}>
      <button type="button" className="picker-btn" aria-haspopup="dialog" aria-expanded={open} aria-label="Выбрать реестр" onClick={() => setOpen(!open)}>
        <span className="reg-title">{current?.name ?? 'Выберите реестр'}</span>
        {current?.archived && <span className="chip">архив</span>}
        <span className="chev" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="picker-pop" role="dialog" aria-label="Реестры">
          <input className="inp" type="search" autoFocus placeholder="Найти реестр" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Найти реестр" />
          <div className="reglist picker-list">
            {items.map((r) => (
              <button key={r.id} type="button" aria-pressed={r.id === current?.id} onClick={() => pick(r)}>
                <b>{r.name}{r.archived ? ' (архив)' : ''}</b>
                <small>{r.fieldCount} полей · {r.recordCount} записей</small>
              </button>
            ))}
            {list.isSuccess && items.length === 0 && <div className="hint pad">Ничего не найдено</div>}
          </div>
          <label className="check"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Показать архивные</label>
          {canManage && (
            <form className="row nowrap picker-new" onSubmit={submit}>
              <input className="inp" required placeholder="Новый реестр, например: Реестр доступов" value={newName} onChange={(e) => setNewName(e.target.value)} aria-label="Название нового реестра" />
              <button className="btn sm" type="submit" disabled={create.isPending}>Создать реестр</button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

function RenameDialog({ reg, onClose }: { reg: RegisterDetail; onClose: () => void }) {
  const [name, setName] = useState(reg.name);
  const rename = useAction(() => registersApi.update(reg.id, { version: reg.version, name }), {
    invalidate: [rkeys.list, rkeys.detail(reg.id)], success: (r) => `Реестр переименован: «${r.name}»`, onDone: onClose,
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <Overlay>
      <div className="backdrop" role="presentation">
        <form className="modal panel" role="dialog" aria-modal="true" aria-labelledby="rn-title"
          onSubmit={(e) => { e.preventDefault(); if (name.trim() === reg.name) onClose(); else rename.mutate(undefined); }}>
          <h2 id="rn-title">Переименовать реестр</h2>
          <input className="inp" required autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label="Название реестра" />
          <div className="hint">Записи и поля не меняются: они привязаны к реестру, а не к названию.</div>
          <div className="row end">
            <button className="btn" type="button" onClick={onClose}>Отмена</button>
            <button className="btn primary" type="submit" disabled={rename.isPending}>Сохранить</button>
          </div>
        </form>
      </div>
    </Overlay>
  );
}

/** Меню действий реестра. Кнопка есть всегда (без прав — неактивна), чтобы шапка не меняла раскладку. */
function RegisterMenu({ reg, canManage, canDeleteRecords }: { reg: RegisterDetail | undefined; canManage: boolean; canDeleteRecords: boolean }) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);
  const usable = canManage || canDeleteRecords;
  const ref = useDismiss(open, () => setOpen(false));
  const archive = useAction(() => (reg?.archived ? registersApi.restore(reg.id, reg.version) : registersApi.archive(reg?.id ?? '', reg?.version ?? 0)), {
    invalidate: [rkeys.list, rkeys.detail(reg?.id ?? '')],
    success: (r) => (r.archived ? `«${r.name}» в архиве: изменения недоступны, данные сохранены` : `«${r.name}» снова доступен`),
  });
  const item = (label: string, onClick: () => void): ReactNode => (
    <button type="button" role="menuitem" onClick={() => { setOpen(false); onClick(); }}>{label}</button>
  );
  return (
    <div className="menu" ref={ref}>
      <button type="button" className="btn ghost sm menu-btn" aria-haspopup="menu" aria-expanded={open} aria-label="Действия реестра"
        disabled={!usable || !reg} title={usable ? 'Действия реестра' : 'Нет права «Реестры: создание и настройка полей»'} onClick={() => setOpen(!open)}>⋯</button>
      {open && reg && (
        <div className="menu-pop" role="menu">
          {canManage && item('Переименовать', () => setRenaming(true))}
          {canManage && item(reg.archived ? 'Вернуть из архива' : 'В архив', () => archive.mutate(undefined))}
          {canDeleteRecords && !reg.archived && item('Удалить все записи…', () => setDeletingAll(true))}
        </div>
      )}
      {renaming && reg && <RenameDialog key={reg.version} reg={reg} onClose={() => setRenaming(false)} />}
      {deletingAll && reg && <BulkDialog reg={reg} mode="delete-all" selection={null} onClose={() => setDeletingAll(false)} onDone={() => setDeletingAll(false)} />}
    </div>
  );
}

/**
 * Шапка конструктора: одна строка фиксированной высоты. Переключатель вкладок стоит на одном месте
 * на всех вкладках: колонки шапки фиксированы, имя реестра и владелец сжимаются с многоточием.
 */
export function RegisterBar({ reg, owner, tab, canManage, canDeleteRecords, onPick, onTab }: {
  reg: RegisterDetail | undefined; owner: string | null; tab: RegTab; canManage: boolean; canDeleteRecords: boolean;
  onPick: (id: string, tab?: RegTab) => void; onTab: (t: RegTab) => void;
}) {
  return (
    <div className="panel reg-bar">
      <RegisterPicker current={reg} canManage={canManage} onPick={onPick} />
      <span className="reg-owner" title={owner ?? undefined}>Владелец: {owner ?? 'не назначен'}</span>
      <div className="tabs reg-tabs" role="tablist" aria-label="Разделы реестра">
        {REG_TABS.map((t) => (
          // Неактивная вкладка — aria-disabled, а не disabled: у disabled браузер не показывает подсказку.
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} aria-disabled={t.disabled ? true : undefined}
            disabled={!reg} title={t.disabled} onClick={() => { if (!t.disabled) onTab(t.key); }}>
            <span className="tab-label" data-label={t.title}>{t.title}</span>
          </button>
        ))}
      </div>
      <RegisterMenu reg={reg} canManage={canManage} canDeleteRecords={canDeleteRecords} />
    </div>
  );
}
