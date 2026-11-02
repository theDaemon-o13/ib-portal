import { useEffect, useState, type ReactNode } from 'react';
import { Overlay } from './Overlay';

/**
 * Удаление реестра, группы или типа систем (1.6.1, ADR-0033): что скроется, почему нельзя (если нельзя),
 * обязательная причина, для реестра и группы — ввод названия. Удаление мягкое: всё уходит в корзину.
 */
export function DeleteDialog({ title, lines, blocked, confirmName, busy, error, onConfirm, onClose }: {
  title: string;
  /** Последствия: что пропадёт из списков, сколько записей затронуто. null — ещё считается. */
  lines: string[] | null;
  /** Почему удалить нельзя; кнопки удаления тогда нет. */
  blocked: ReactNode | null;
  /** Название для подтверждения вводом; null — не нужно. */
  confirmName: string | null;
  busy: boolean;
  error: string | null;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);
  const nameOk = confirmName === null || typed.trim().toLowerCase() === confirmName.trim().toLowerCase();
  const ready = !!lines && !blocked && reason.trim() !== '' && nameOk && !busy;
  return (
    <Overlay>
      <div className="backdrop" role="presentation">
        <form className="modal panel delete-dialog" role="dialog" aria-modal="true" aria-labelledby="del-title"
          onSubmit={(e) => { e.preventDefault(); if (ready) onConfirm(reason.trim()); }}>
          <h2 id="del-title">{title}</h2>
          {!lines && !error && <p className="hint">Считаем…</p>}
          {lines && (
            <ul className="bulk-lines" data-testid="delete-preview">
              {lines.map((l) => <li key={l}>{l}</li>)}
            </ul>
          )}
          {blocked ? <div className="note" role="alert" data-testid="delete-blocked">{blocked}</div> : lines && (
            <>
              <div className="hint">Удаление мягкое: всё скрытое попадёт в корзину («Настройки → Корзина»), восстановить может супер-администратор.</div>
              <label>Причина удаления
                <textarea className="inp" required maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Причина удаления" autoFocus />
              </label>
              {confirmName !== null && (
                <label>Чтобы подтвердить, введите название
                  <input className="inp" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={confirmName} aria-label="Название для подтверждения" />
                </label>
              )}
            </>
          )}
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="row end">
            <button className="btn" type="button" onClick={onClose} disabled={busy}>{blocked ? 'Закрыть' : 'Отмена'}</button>
            {!blocked && <button className="btn danger" type="submit" disabled={!ready}>{busy ? 'Удаляем…' : 'Удалить'}</button>}
          </div>
        </form>
      </div>
    </Overlay>
  );
}
