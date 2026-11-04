import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, authApi } from '../../api/client';
import { loadRememberedLogin, saveRememberedLogin } from '../../auth/remembered-login';
import { clearExpired } from '../../auth/session';
import { useMe, useSetMe } from '../../auth/useMe';
import { PortalCredit } from '../../components/AboutPortal';
import { Brand } from '../../components/Brand';
import { PasswordInput } from '../../components/PasswordInput';
import { ThemeSwitch } from '../../components/ThemeSwitch';
import { homePath, safeReturnPath } from '../../nav';

const storage = (): Storage | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

function errorText(e: unknown): string {
  if (e instanceof ApiError && e.code === 'ACCOUNT_LOCKED') {
    const until = typeof e.details?.lockedUntil === 'string' ? new Date(e.details.lockedUntil) : null;
    const time = until ? until.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : null;
    return time ? `Слишком много неудачных попыток. Вход заблокирован до ${time}` : e.message;
  }
  return e instanceof Error ? e.message : 'Не удалось войти';
}

export function LoginPage() {
  const { data: me } = useMe();
  const setMe = useSetMe();
  const navigate = useNavigate();
  const location = useLocation();
  const { from, expired } = (location.state as { from?: string; expired?: boolean } | null) ?? {};
  const [remembered] = useState(() => loadRememberedLogin(storage()));
  const [login, setLogin] = useState(remembered);
  const [remember, setRemember] = useState(remembered !== '');
  const [password, setPassword] = useState('');

  const mutation = useMutation({
    mutationFn: authApi.login,
    onSuccess: ({ user }) => {
      clearExpired();
      saveRememberedLogin(storage(), user.login, remember);
      setMe(user);
      if (user.mustChangePassword) navigate('/change-password', { replace: true });
      else navigate(safeReturnPath(from) ?? homePath(user.permissions, user.service), { replace: true });
    },
    onError: () => setPassword(''),
  });

  if (me && !mutation.isPending) {
    return <Navigate to={me.mustChangePassword ? '/change-password' : safeReturnPath(from) ?? homePath(me.permissions, me.service)} replace />;
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    mutation.mutate({ login, password });
  };

  return (
    <div className="auth-wrap">
      <div>
        <form className="panel auth-card form" onSubmit={submit} noValidate>
          <Brand />
          <h1>Вход</h1>
          {expired && (
            <div className="note" role="status">
              Сессия завершилась: 30 минут без действий. Войдите снова — откроем ту же страницу.
            </div>
          )}
          <label>
            Логин
            <input className="inp" name="username" autoComplete="username" autoFocus={!remembered} required
              value={login} onChange={(e) => setLogin(e.target.value)} />
          </label>
          <PasswordInput label="Пароль" name="password" autoComplete="current-password" autoFocus={!!remembered} required
            value={password} onChange={(e) => setPassword(e.target.value)} />
          <label className="check">
            <input type="checkbox" name="remember-login" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            Запомнить логин
          </label>
          {mutation.isError && <p className="form-error" role="alert">{errorText(mutation.error)}</p>}
          <button className="btn primary" type="submit" disabled={mutation.isPending || !login || !password}>
            {mutation.isPending ? 'Входим…' : 'Войти'}
          </button>
          <p className="hint">Забыли пароль? Обратитесь к администратору портала.</p>
        </form>
        <div className="auth-foot">
          <ThemeSwitch />
        </div>
        <PortalCredit />
      </div>
    </div>
  );
}
