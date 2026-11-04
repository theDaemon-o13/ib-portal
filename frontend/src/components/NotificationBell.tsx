import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { badge, nkeys, notificationsApi, NOTIFY_POLL_MS, tabTitle, whenLabel, type PortalNotification } from '../api/notifications';

/** «Ждёт вашего действия» — один запрос на меню и колокольчик (одинаковый ключ). Монитору и до входа не вызывается. */
export function useAttention(enabled = true) {
  return useQuery({ queryKey: nkeys.attention, queryFn: notificationsApi.attention, refetchInterval: NOTIFY_POLL_MS, enabled });
}
import { Overlay } from './Overlay';
import { useToast } from './Toast';

/**
 * Значок уведомлений в меню (релиз 1.2.0, ADR-0023). С 1.4.0 число на значке и в заголовке вкладки «(3) Портал ИБ» —
 * сколько ждёт вашего действия: задачи на вашей проверке + документы «ждут вас» (GET /me/attention, решение владельца).
 * Непрочитанные уведомления на значке не показываются — только выделением в открытом списке.
 * Опрос раз в 45 с фоновым запросом (сессию не продлевает); в скрытой вкладке — пауза, при возвращении — сразу.
 * Всплывающих сообщений нет (решение владельца В-6).
 */
export function NotificationBell() {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLElement>(null);
  const attention = useAttention();
  const waiting = attention.data?.total ?? 0;
  // Непрочитанные — только для открытого списка («Непрочитанные · N», «Прочитать все»).
  const count = useQuery({ queryKey: nkeys.count, queryFn: notificationsApi.count, enabled: open });
  const unread = count.data?.unread ?? 0;
  const list = useInfiniteQuery({
    queryKey: nkeys.list(unreadOnly),
    queryFn: ({ pageParam }) => notificationsApi.list(unreadOnly, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    enabled: open,
  });

  useEffect(() => {
    document.title = tabTitle(waiting);
    return () => { document.title = tabTitle(0); };
  }, [waiting]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!box.current?.contains(target) && !popRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onDown); };
  }, [open]);

  const refresh = () => qc.invalidateQueries({ queryKey: nkeys.all });
  const readAll = useMutation({
    mutationFn: notificationsApi.readAll,
    onSuccess: async (r) => { await refresh(); toast(r.marked ? `Прочитано: ${r.marked}` : 'Непрочитанных нет'); },
    onError: (e) => toast(e instanceof Error ? e.message : 'Не удалось отметить', 'error'),
  });
  const openItem = async (n: PortalNotification) => {
    if (!n.read) {
      await notificationsApi.read(n.id).catch(() => undefined);
      void refresh();
    }
    // Задача или, у сводного «У вас N просроченных задач», доска с фильтром «просрочено».
    if (n.link) {
      setOpen(false);
      navigate(n.link);
    }
  };
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="bell-wrap" ref={box}>
      <button type="button" className={`bell${waiting ? ' has' : ''}`} aria-haspopup="dialog" aria-expanded={open}
        aria-label={waiting ? `Уведомления; ждут вашего действия: ${waiting}` : 'Уведомления'}
        title={attention.data && waiting ? `Ждут вашего действия: задачи на проверке — ${attention.data.tasks}, документы — ${attention.data.documents}${attention.data.audit ? `, действия служебного администратора — ${attention.data.audit}` : ''}` : undefined}
        onClick={() => setOpen((v) => !v)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z" /><path d="M10 20a2 2 0 0 0 4 0" />
        </svg>
        {waiting > 0 && <span className="bell-n" data-testid="bell-count">{badge(waiting)}</span>}
      </button>
      {/* Панель — в <body>: внутри стеклянного меню position: fixed и размытие отсчитываются от меню. */}
      {open && (
        <Overlay>
        <section className="notif-pop" role="dialog" aria-label="Уведомления" ref={popRef}>
          <div className="notif-h">
            <h3>Уведомления</h3>
            <button className="btn ghost sm" type="button" disabled={!unread || readAll.isPending} onClick={() => readAll.mutate()}>Прочитать все</button>
          </div>
          <div className="seg notif-tabs" role="group" aria-label="Какие показать">
            <button type="button" aria-pressed={unreadOnly} onClick={() => setUnreadOnly(true)}>Непрочитанные{unread ? ` · ${unread}` : ''}</button>
            <button type="button" aria-pressed={!unreadOnly} onClick={() => setUnreadOnly(false)}>Все</button>
          </div>
          <div className="notif-list">
            {list.isPending && <div className="hint notif-empty">Загрузка…</div>}
            {list.isSuccess && items.length === 0 && <div className="hint notif-empty">{unreadOnly ? 'Новых уведомлений нет' : 'Уведомлений нет'}</div>}
            {items.map((n) => (
              <button key={n.id} type="button" className={`notif${n.read ? '' : ' unread'}`} data-notification={n.id} onClick={() => void openItem(n)}>
                <span className="notif-t">{n.title}</span>
                {n.body && <span className="notif-b">{n.body}</span>}
                <span className="notif-m">
                  {whenLabel(n.createdAt)}
                  {n.task?.deleted && <span className="chip">задача удалена</span>}
                </span>
              </button>
            ))}
            {list.hasNextPage && (
              <button className="btn ghost sm notif-more" type="button" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>Показать ещё</button>
            )}
          </div>
        </section>
        </Overlay>
      )}
    </div>
  );
}
