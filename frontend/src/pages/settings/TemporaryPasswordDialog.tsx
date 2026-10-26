import { useEffect, useRef, useState } from 'react';
import type { WithTemporaryPassword } from '../../api/settings';

/**
 * Временный пароль показывается один раз: после закрытия окна его не восстановить,
 * только сбросить заново. В хранилище браузера он не попадает, а при закрытии окна
 * удаляется и из памяти страницы (результаты мутаций сбрасываются).
 */
export function TemporaryPasswordDialog({
  title,
  result,
  onClose,
}: {
  title: string;
  result: WithTemporaryPassword;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(result.temporaryPassword);
      setCopied('ok');
    } catch {
      setCopied('fail');
    }
  };

  return (
    <div className="backdrop" role="presentation">
      <div className="modal panel" role="dialog" aria-modal="true" aria-labelledby="tp-title">
        <h2 id="tp-title">{title}</h2>
        <p>
          {result.user.fullName} <span className="hint mono">({result.user.login})</span>
        </p>
        <div className="temp-pass" aria-label="Временный пароль">
          <code>{result.temporaryPassword}</code>
          <button className="btn sm" type="button" onClick={() => void copy()}>
            {copied === 'ok' ? 'Скопировано' : 'Скопировать'}
          </button>
        </div>
        {copied === 'fail' && <p className="form-error">Не удалось скопировать — выделите пароль и скопируйте вручную.</p>}
        <div className="note">
          Пароль показывается один раз. Передайте его пользователю лично, не по почте и не в мессенджере.
          При первом входе он задаст собственный пароль.
        </div>
        <div className="row end">
          <button ref={closeRef} className="btn primary" type="button" onClick={onClose}>Готово</button>
        </div>
      </div>
    </div>
  );
}
