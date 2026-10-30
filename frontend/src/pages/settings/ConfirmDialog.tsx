import type { FormEvent, ReactNode } from 'react';
import { Overlay } from '../../components/Overlay';

export interface ConfirmAsk {
  title: string;
  text: ReactNode;
  confirm: string;
  run: () => void;
}

/** Подтверждение действия в настройках: заголовок-вопрос, пояснение, «Отмена» и кнопка действия. */
export function ConfirmDialog({ ask, busy, onClose }: { ask: ConfirmAsk; busy: boolean; onClose: () => void }) {
  const send = (e: FormEvent) => {
    e.preventDefault();
    ask.run();
  };
  return (
    <Overlay>
      <div className="backdrop" role="presentation" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
        <form className="modal panel" role="alertdialog" aria-modal="true" aria-label={ask.title} onSubmit={send}>
          <h2>{ask.title}</h2>
          <p>{ask.text}</p>
          <div className="row end">
            <button className="btn" type="button" onClick={onClose} disabled={busy}>Отмена</button>
            <button className="btn primary" type="submit" autoFocus disabled={busy}>{ask.confirm}</button>
          </div>
        </form>
      </div>
    </Overlay>
  );
}
