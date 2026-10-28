import { useEffect, useRef, useState } from 'react';
import { BUILD, buildDateText } from '../build-info';
import { Overlay } from './Overlay';

/** Подпись внизу меню и страницы входа: «Портал ИБ 1.0.1 · Разработал: …»; щелчок по версии — окно «О портале». */
export function PortalCredit() {
  const [open, setOpen] = useState(false);
  return (
    <p className="credit">
      <button type="button" className="credit-v" onClick={() => setOpen(true)} aria-haspopup="dialog" title="О портале">
        {BUILD.name} {BUILD.version}
      </button>
      <span className="credit-a"> · Разработал: {BUILD.author}</span>
      {open && <AboutDialog onClose={() => setOpen(false)} />}
    </p>
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
          <h2 id="about-title">О портале</h2>
          <dl className="about-kv">
            <dt>Название</dt><dd>{BUILD.name}</dd>
            <dt>Версия</dt><dd className="mono">{BUILD.version}</dd>
            <dt>Коммит сборки</dt><dd className="mono">{BUILD.commit}</dd>
            <dt>Дата сборки</dt><dd className="mono">{buildDateText(BUILD.date)}</dd>
            <dt>Автор</dt><dd>{BUILD.author}</dd>
          </dl>
          <div className="row end">
            <button ref={closeRef} className="btn primary" type="button" onClick={onClose}>Закрыть</button>
          </div>
        </div>
      </div>
    </Overlay>
  );
}
