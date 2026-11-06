import { useEffect, useRef, useState } from 'react';
import { BUILD } from '../build-info';
import { Overlay } from './Overlay';
import { Signature } from './Signature';

/**
 * Подпись внизу меню (1.13.0): «designed by» и подпись автора (пишется от руки при первой загрузке), справа — версия;
 * щелчок по версии — окно «О портале» с полной подписью. variant="full" — страница входа: полная подпись.
 */
export function PortalCredit({ variant = 'menu' }: { variant?: 'menu' | 'full' }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`credit${variant === 'full' ? ' credit-full' : ''}`}>
      <div className="credit-sig">
        <span className="credit-by">designed by</span>
        <Signature variant={variant === 'full' ? 'full' : 'autograph'} animate />
      </div>
      <button type="button" className="credit-v" onClick={() => setOpen(true)} aria-haspopup="dialog" title="О портале">
        <span className="visually-hidden">{BUILD.name} </span>Версия {BUILD.version}{variant === 'menu' && <><br />Закрытый контур</>}
      </button>
      <span className="credit-a visually-hidden">Разработал: {BUILD.author}</span>
      {open && <AboutDialog onClose={() => setOpen(false)} />}
    </div>
  );
}

function AboutDialog({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <Overlay>
      <div className="backdrop" role="presentation" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <div className="modal panel about" role="dialog" aria-modal="true" aria-labelledby="about-title">
          <h2 id="about-title">{BUILD.name}</h2>
          <Signature variant="full" className="about-sig" />
          <dl className="about-kv">
            <dt>Версия</dt><dd className="mono">{BUILD.version}</dd>
            <dt>Разработал</dt><dd>{BUILD.author}</dd>
          </dl>
          <div className="row end">
            <button ref={closeRef} className="btn primary" type="button" onClick={onClose}>Закрыть</button>
          </div>
        </div>
      </div>
    </Overlay>
  );
}
