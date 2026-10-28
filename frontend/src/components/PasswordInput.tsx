import { useEffect, useId, useRef, useState, type InputHTMLAttributes } from 'react';

/**
 * Поле пароля с кнопкой «показать / скрыть». Перед отправкой формы пароль снова
 * скрывается: менеджер паролей браузера узнаёт поле по type="password".
 * Кнопка стоит вне <label>, чтобы её текст не попадал в название поля.
 */
export function PasswordInput({ label, ...props }: { label: string } & Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'id'>) {
  const id = useId();
  const [shown, setShown] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return;
    const hide = () => setShown(false);
    form.addEventListener('submit', hide);
    return () => form.removeEventListener('submit', hide);
  }, []);

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <span className="pass-field">
        <input {...props} id={id} ref={ref} className={props.className ?? 'inp'} type={shown ? 'text' : 'password'}
          autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        <button className="pass-toggle" type="button" aria-pressed={shown}
          aria-label={shown ? 'Скрыть пароль' : 'Показать пароль'} title={shown ? 'Скрыть пароль' : 'Показать пароль'}
          onClick={() => setShown((v) => !v)}>
          <EyeIcon crossed={shown} />
        </button>
      </span>
    </div>
  );
}

export function EyeIcon({ crossed }: { crossed: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="3" />
      {crossed && <path d="M4 20 20 4" />}
    </svg>
  );
}
