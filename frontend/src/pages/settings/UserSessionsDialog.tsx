import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { sessionsApi } from '../../api/client';
import { Overlay } from '../../components/Overlay';
import { SessionsList } from '../../components/SessionsList';
import { useToast } from '../../components/Toast';

/** «Сессии» пользователя в «Пользователях и ролях» (1.10.0, users.manage): открытые сессии, «Завершить», «Завершить все». */
export function UserSessionsDialog({ user, onClose }: { user: { id: string; fullName: string }; onClose: () => void }) {
  const key = ['user-sessions', user.id];
  const qc = useQueryClient();
  const toast = useToast();
  const sessions = useQuery({ queryKey: key, queryFn: () => sessionsApi.ofUser(user.id) });
  const after = (r: { revoked: number }) => {
    toast(r.revoked ? `${user.fullName}: завершено сессий — ${r.revoked}` : 'Открытых сессий нет');
    void qc.invalidateQueries({ queryKey: key });
  };
  const fail = (e: Error) => toast(e.message);
  const one = useMutation({ mutationFn: (id: string) => sessionsApi.revokeOfUser(user.id, id), onSuccess: after, onError: fail });
  const all = useMutation({ mutationFn: () => sessionsApi.revokeAllOfUser(user.id), onSuccess: after, onError: fail });
  const busy = one.isPending || all.isPending;
  const count = sessions.data?.items.length ?? 0;
  return (
    <Overlay>
      <div className="backdrop" role="presentation" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
        <div className="modal panel wide" role="dialog" aria-modal="true" aria-labelledby="us-title">
          <h2 id="us-title">Сессии: {user.fullName}</h2>
          {sessions.isPending && <p className="hint">Загрузка…</p>}
          {sessions.isError && <p className="form-error">{sessions.error.message}</p>}
          {sessions.data && <SessionsList items={sessions.data.items} busy={busy} onRevoke={(s) => one.mutate(s.id)} />}
          <div className="row end">
            <button className="btn" type="button" onClick={onClose} disabled={busy}>Закрыть</button>
            <button className="btn primary" type="button" onClick={() => all.mutate()} disabled={busy || count === 0}>Завершить все</button>
          </div>
        </div>
      </div>
    </Overlay>
  );
}
