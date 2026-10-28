import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, authApi } from '../../api/client';
import { useMe, useSetMe } from '../../auth/useMe';
import { Brand } from '../../components/Brand';
import { ThemeSwitch } from '../../components/ThemeSwitch';
import { homePath, safeReturnPath } from '../../nav';

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
  const from = (location.state as { from?: string } | null)?.from;
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');

  const mutation = useMutation({
    mutationFn: authApi.login,
    onSuccess: ({ user }) => {
      setMe(user);
      if (user.mustChangePassword) navigate('/change-password', { replace: true });
      else navigate(safeReturnPath(from) ?? homePath(user.permissions), { replace: true });
    },
    onError: () => setPassword(''),
  });

  if (me && !mutation.isPending) {
    return <Navigate to={me.mustChangePassword ? '/change-password' : homePath(me.permissions)} replace />;
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
          <label>
            Логин
            <input className="inp" name="username" autoComplete="username" autoFocus required
              value={login} onChange={(e) => setLogin(e.target.value)} />
          </label>
          <label>
            Пароль
            <input className="inp" type="password" name="password" autoComplete="current-password" required
              value={password} onChange={(e) => setPassword(e.target.value)} />
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
      </div>
    </div>
  );
}
