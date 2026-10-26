import { useInfiniteQuery } from '@tanstack/react-query';
import { settingsApi } from '../../api/settings';
import { formatDateTime } from './logic';
import { keys } from './useAction';

/** Журнал изменений настроек: кто, когда, с какими ролями, что поменял. Строится из журнала аудита. */
export function JournalTab() {
  const q = useInfiniteQuery({
    queryKey: keys.journal,
    queryFn: ({ pageParam }) => settingsApi.journal(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <section className="panel">
      <div className="panel-h">
        <h3>Журнал изменений настроек</h3>
        <span className="sub">{items.length ? `показано ${items.length}` : ''}</span>
      </div>
      <div className="panel-b">
        {q.isPending && <div className="hint">Загрузка…</div>}
        {q.isError && <div className="form-error">{q.error.message}</div>}
        {q.isSuccess && items.length === 0 && (
          <div className="hint">
            Изменений пока нет. Здесь появится каждое изменение справочников, календаря, шаблонов, пользователей и ролей:
            кто, когда и что поменял.
          </div>
        )}
        <div className="list">
          {items.map((e) => (
            <div className="li" key={e.id}>
              <div className="min0">
                <div>{e.summary}</div>
                <div className="m">
                  {e.actor ? `${e.actor.fullName} (${e.actor.login})` : 'Система'}
                  {e.actorRoles.length > 0 && ` · ${e.actorRoles.join(', ')}`}
                </div>
              </div>
              <span className="mono m">{formatDateTime(e.at)}</span>
            </div>
          ))}
        </div>
        {q.hasNextPage && (
          <button className="btn sm mt12" type="button" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
            Показать ещё
          </button>
        )}
      </div>
    </section>
  );
}
