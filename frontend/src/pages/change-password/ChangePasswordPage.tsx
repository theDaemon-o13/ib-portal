import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { authApi, type Me } from '../../api/client';
import { useSetMe } from '../../auth/useMe';
import { Brand } from '../../components/Brand';
import { homePath } from '../../nav';

// Подсказки повторяют политику backend; окончательно проверяет сервер (включая повтор последних 5 паролей).
function rules(pw: string, login: string) {
  const classes = [/\p{Ll}/u, /\p{Lu}/u, /\p{Nd}/u, /[^\p{L}\p{Nd}]/u].filter((r) => r.test(pw)).length;
  return [
    { ok: [...pw].length >= 12, text: 'Не короче 12 символов' },
    { ok: classes >= 3, text: 'Три вида символов из четырёх: строчные, прописные, цифры, другие' },
    { ok: pw.length > 0 && !pw.toLowerCase().includes(login.toLowerCase()), text: 'Не содержит логин' },
    { ok: false, text: 'Не совпадает с последними пятью паролями', server: true },
  ];
}

export function ChangePasswordPage({ me }: { me: Me }) {
  const setMe = useSetMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');

  const mutation = useMutation({
    mutationFn: authApi.changePassword,
    onSuccess: ({ user }) => {
      setMe(user);
      navigate(homePath(user.permissions), { replace: true });
    },
  });
  const logout = useMutation({
    mutationFn: authApi.logout,
    onSettled: () => {
      qc.clear();
      navigate('/login', { replace: true });
    },
  });

  const checks = rules(next, me.login);
  const clientOk = checks.every((c) => c.server || c.ok);
  const mismatch = repeat.length > 0 && repeat !== next;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!clientOk || mismatch) return;
    mutation.mutate({ currentPassword: current, newPassword: next });
  };

  return (
    <div className="auth-wrap">
      <form className="panel auth-card form" onSubmit={submit} noValidate>
        <Brand />
        <div>
          <h1>Смена пароля</h1>
          {me.passwordExpired ? (
            <p className="hint">Срок действия пароля — 90 дней, он истёк. Задайте новый пароль, чтобы продолжить работу.</p>
          ) : (
            me.mustChangePassword && <p className="hint">Перед началом работы задайте собственный пароль.</p>
          )}
        </div>
        <label>
          Текущий пароль
          <input className="inp" type="password" autoComplete="current-password" autoFocus
            value={current} onChange={(e) => setCurrent(e.target.value)} />
        </label>
        <label>
          Новый пароль
          <input className="inp" type="password" autoComplete="new-password"
            value={next} onChange={(e) => setNext(e.target.value)} />
        </label>
        <ul className="rules">
          {checks.map((c) => (
            <li key={c.text} className={c.ok ? 'ok' : undefined}>{c.text}</li>
          ))}
        </ul>
        <label>
          Повторите новый пароль
          <input className="inp" type="password" autoComplete="new-password"
            value={repeat} onChange={(e) => setRepeat(e.target.value)} />
        </label>
        {mismatch && <p className="form-error">Пароли не совпадают</p>}
        {mutation.isError && <p className="form-error" role="alert">{mutation.error.message}</p>}
        <button className="btn primary" type="submit"
          disabled={mutation.isPending || !current || !clientOk || repeat !== next}>
          {mutation.isPending ? 'Сохраняем…' : 'Сменить пароль'}
        </button>
        <button className="btn ghost" type="button" onClick={() => logout.mutate()}>Выйти</button>
      </form>
    </div>
  );
}
