import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiError, authApi } from '../api/client';
import { markExpired, onSessionDeadline, sessionDeadline, sessionPhase, WARN_BEFORE_MS } from '../auth/session';
import { ME_KEY } from '../auth/useMe';
import { Overlay } from './Overlay';

const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Предупреждение о завершении сессии по бездействию (релиз 1.2.0, ADR-0023): за 2 минуты — окно
 * «Сессия завершится через 2 минуты» с кнопкой «Продолжить работу» (действие пользователя продлевает сессию).
 * Перед показом и в конце срока остаток сверяется с сервером фоновым запросом: в другой вкладке могли продолжить работу.
 */
export function SessionWatch() {
  const qc = useQueryClient();
  const [deadline, setDeadline] = useState(sessionDeadline);
  const [now, setNow] = useState(Date.now);
  const [busy, setBusy] = useState(false);
  useEffect(() => onSessionDeadline(() => { setDeadline(sessionDeadline()); setNow(Date.now()); }), []);
  const phase = sessionPhase(deadline, now);

  useEffect(() => {
    if (deadline === null || phase === 'over') return;
    const wait = phase === 'ok' ? Math.max(1000, deadline - Date.now() - WARN_BEFORE_MS) : 1000;
    const t = setTimeout(() => setNow(Date.now()), wait);
    return () => clearTimeout(t);
  }, [deadline, now, phase]);

  // Сверка с сервером при входе в предупреждение и в конце срока. Фоновый запрос сессию не продлевает.
  useEffect(() => {
    if (phase === 'ok') return;
    authApi.me().catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 401) {
        markExpired();
        qc.setQueryData(ME_KEY, null);
      }
    });
  }, [phase, qc]);

  if (phase !== 'warn' || deadline === null) return null;
  const extend = async () => {
    setBusy(true);
    try {
      await authApi.me();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Overlay>
      <div className="backdrop" role="presentation">
        <div className="modal panel" role="alertdialog" aria-modal="true" aria-labelledby="sw-title" aria-describedby="sw-text">
          <h2 id="sw-title">Сессия завершится через 2 минуты</h2>
          <p id="sw-text" className="hint">Вы давно ничего не делали в портале. Осталось {mmss(deadline - now)} — потом понадобится войти снова.</p>
          <div className="row end">
            <button className="btn primary" type="button" autoFocus disabled={busy} onClick={() => void extend()}>Продолжить работу</button>
          </div>
        </div>
      </div>
    </Overlay>
  );
}
