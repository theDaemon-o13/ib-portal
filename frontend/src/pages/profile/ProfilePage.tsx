import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { sessionsApi } from '../../api/client';
import { useMe } from '../../auth/useMe';
import { SessionsList } from '../../components/SessionsList';
import { useToast } from '../../components/Toast';

const KEY = ['my-sessions'];

/** «Профиль» (1.10.0): учётная запись и «Мои сессии» — где открыт портал, «Завершить», «Завершить все, кроме текущей». */
export function ProfilePage() {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const sessions = useQuery({ queryKey: KEY, queryFn: sessionsApi.mine });
  const done = (text: string) => {
    toast(text);
    void qc.invalidateQueries({ queryKey: KEY });
  };
  const fail = (e: Error) => toast(e.message);
  const revoke = useMutation({ mutationFn: (id: string) => sessionsApi.revokeMine(id), onSuccess: () => done('Сессия завершена'), onError: fail });
  const others = useMutation({
    mutationFn: sessionsApi.revokeOthers,
    onSuccess: (r) => done(r.revoked ? `Завершено сессий: ${r.revoked}` : 'Других сессий нет'),
    onError: fail,
  });
  const data = sessions.data;
  const otherCount = data ? data.items.filter((s) => !s.current).length : 0;

  return (
    <>
      <div className="head">
        <div>
          <h1>Профиль</h1>
          <p>{me ? `${me.fullName} · ${me.login}` : ''}</p>
        </div>
        <div className="row">
          <Link className="btn" to="/change-password">Сменить пароль</Link>
        </div>
      </div>
      <section className="panel" aria-labelledby="my-sessions-h">
        <div className="panel-h row">
          <h2 id="my-sessions-h" className="grow">Мои сессии</h2>
          <button className="btn sm" type="button" disabled={others.isPending || otherCount === 0} onClick={() => others.mutate()}>
            Завершить все, кроме текущей
          </button>
        </div>
        <div className="panel-b">
          <p className="hint">
            {data?.admin
              ? `У администраторов портала сессия длится до ${data.adminMaxHours} ч от входа, «Запомнить меня» не действует.`
              : 'Сессия не завершается сама по бездействию. Не узнаёте устройство — завершите сессию и смените пароль.'}
          </p>
          {sessions.isPending && <p className="hint">Загрузка…</p>}
          {sessions.isError && <p className="form-error">{sessions.error.message}</p>}
          {data && <SessionsList items={data.items} busy={revoke.isPending} onRevoke={(s) => revoke.mutate(s.id)} />}
        </div>
      </section>
    </>
  );
}
