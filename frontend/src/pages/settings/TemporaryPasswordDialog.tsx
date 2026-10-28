import { Overlay } from '../../components/Overlay';
import { EyeIcon } from '../../components/PasswordInput';
import { useEffect, useRef, useState } from 'react';
import type { WithTemporaryPassword } from '../../api/settings';

/**
 * Временный пароль показывается один раз: после закрытия окна его не восстановить,
 * только сбросить заново. В хранилище браузера он не попадает, а при закрытии окна
 * удаляется и из памяти страницы (результаты мутаций сбрасываются).
 * По умолчанию пароль скрыт — чтобы его не увидели через плечо; скопировать можно и скрытым.
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
  const [shown, setShown] = useState(false);
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
    <Overlay>
    <div className="backdrop" role="presentation">
      <div className="modal panel" role="dialog" aria-modal="true" aria-labelledby="tp-title">
        <h2 id="tp-title">{title}</h2>
        <p>
          {result.user.fullName} <span className="hint mono">({result.user.login})</span>
        </p>
        <div className="temp-pass" aria-label="Временный пароль">
          {shown ? <code>{result.temporaryPassword}</code> : <code className="masked" aria-label="Пароль скрыт">{'•'.repeat(12)}</code>}
          <span className="row">
            <button className="btn sm" type="button" aria-pressed={shown} onClick={() => setShown((v) => !v)}>
              <EyeIcon crossed={shown} />
              {shown ? 'Скрыть' : 'Показать'}
            </button>
            <button className="btn sm" type="button" onClick={() => void copy()}>
              {copied === 'ok' ? 'Скопировано' : 'Скопировать'}
            </button>
          </span>
        </div>
        {copied === 'fail' && <p className="form-error">Не удалось скопировать — нажмите «Показать», выделите пароль и скопируйте вручную.</p>}
        <div className="note">
          Пароль показывается один раз. Передайте его пользователю лично, не по почте и не в мессенджере.
          При первом входе он задаст собственный пароль.
        </div>
        <div className="row end">
          <button ref={closeRef} className="btn primary" type="button" onClick={onClose}>Готово</button>
        </div>
      </div>
    </div>
    </Overlay>
  );
}
