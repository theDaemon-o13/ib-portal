import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import { ApiError, type Me } from '../../api/client';
import { settingsApi } from '../../api/settings';
import { tasksApi, tkeys, type Task } from '../../api/tasks';
import { useToast } from '../../components/Toast';
import { categoryTone, dueLabel, initials, sortColumn, todayLocal, workload } from './logic';
import { MailDrawer } from './MailDrawer';
import { TaskDrawer } from './TaskDrawer';

/** Сдвиг указателя, после которого нажатие на карточку — перетаскивание, а не щелчок. */
const DRAG_PX = 5;

interface Drag {
  task: Task;
  x0: number;
  y0: number;
  dx: number;
  dy: number;
  moving: boolean;
  over: string | null;
}

function plusDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return todayLocal(d);
}

function Card({ t, today, archived, drag, onPointerDown, onOpen }: {
  t: Task; today: string; archived: boolean; drag: Drag | null;
  onPointerDown: (e: ReactPointerEvent<HTMLElement>, t: Task) => void; onOpen: (id: string) => void;
}) {
  const due = dueLabel(t, today);
  const dragging = drag?.moving && drag.task.id === t.id;
  return (
    <article className={`card${archived ? ' arch' : ''}${dragging ? ' dragging' : ''}${t.overdue ? ' late' : ''}`} tabIndex={0}
      aria-label={`Открыть задачу ${t.title}`} data-task={t.id}
      style={dragging ? { transform: `translate(${drag.dx}px, ${drag.dy}px)` } : undefined}
      onPointerDown={archived ? undefined : (e) => onPointerDown(e, t)}
      onClick={archived ? () => onOpen(t.id) : undefined}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(t.id); }}>
      <div className="card-t">{t.urgent && <span className="chip crit">срочно</span>}{t.title}</div>
      <div className="meta">
        <span className={categoryTone(t.category)}>● {t.category.value}</span>
        <span className={`mono${due.late ? ' late-t' : ''}`}>{due.text}</span>
      </div>
      <div className="meta">
        {t.assignee
          ? <span className="row nowrap gap6"><span className="av">{initials(t.assignee.fullName)}</span>{t.assignee.fullName}</span>
          : <span className="chip high" title={t.recipientLabel ? `Получатели: ${t.recipientLabel}` : undefined}>не назначен</span>}
        <span className="row nowrap gap6">
          {t.commentCount > 0 && (
            <span className="clip" title="Комментарии">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" /></svg>{t.commentCount}
            </span>
          )}
          {t.source === 'automation' && <span className="chip crit" title="Задача из автоматизации реестра">авто</span>}
          {t.source === 'mail' && <span className="chip info" title="Задача из письма">письмо</span>}
        </span>
      </div>
    </article>
  );
}

export function TasksPage() {
  const me = useOutletContext<Me>();
  const qc = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const openId = params.get('task');
  const archived = params.get('archive') === '1';
  const categoryId = params.get('category') ?? '';
  const [mailOpen, setMailOpen] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const today = todayLocal();

  const statuses = useQuery({ queryKey: tkeys.statuses, queryFn: () => settingsApi.items('task_statuses', false) });
  const categories = useQuery({ queryKey: tkeys.categories, queryFn: () => settingsApi.items('task_categories', false) });
  const people = useQuery({ queryKey: ['settings', 'userOptions'], queryFn: settingsApi.userOptions });
  const tasks = useQuery({ queryKey: tkeys.list(archived, categoryId), queryFn: () => tasksApi.list({ archived, categoryId: categoryId || undefined }) });
  const all = useQuery({ queryKey: tkeys.list(archived, ''), queryFn: () => tasksApi.list({ archived }), enabled: !!categoryId });

  const setParam = useCallback((patch: Record<string, string | null>) => {
    setParams((p) => {
      const n = new URLSearchParams(p);
      for (const [k, v] of Object.entries(patch)) if (v === null) n.delete(k); else n.set(k, v);
      return n;
    });
  }, [setParams]);
  const openTask = useCallback((id: string) => setParam({ task: id }), [setParam]);

  const [quick, setQuick] = useState({ title: '', categoryId: '', assigneeId: me.id, dueDate: plusDays(5) });
  const quickCategories = (categories.data?.items ?? []).filter((c) => c.systemKey !== 'register' && c.systemKey !== 'mail');
  const quickCategory = quick.categoryId || quickCategories[0]?.id || '';
  const create = useMutation({
    mutationFn: () => tasksApi.create({ title: quick.title, categoryId: quickCategory, assigneeId: quick.assigneeId || null, dueDate: quick.dueDate || null }),
    onSuccess: async (t) => {
      setQuick({ ...quick, title: '' });
      await qc.invalidateQueries({ queryKey: tkeys.all });
      toast(`Задача #${t.number} назначена${t.assignee ? `: ${t.assignee.fullName}` : ''}`);
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Не удалось поставить задачу', 'error'),
  });
  const move = useMutation({
    mutationFn: ({ t, statusId }: { t: Task; statusId: string }) => tasksApi.update(t.id, { version: t.version, statusId }),
    onSuccess: async (t) => {
      await qc.invalidateQueries({ queryKey: tkeys.all });
      toast(`«${t.title}» → ${t.status.value}`);
    },
    onError: async (e) => {
      await qc.invalidateQueries({ queryKey: tkeys.all });
      toast(e instanceof ApiError && e.code === 'VERSION_CONFLICT' ? 'Задачу успели изменить — доска обновлена, повторите' : e instanceof Error ? e.message : 'Не удалось сменить статус', 'error');
    },
  });

  // Перетаскивание: нажатие → сдвиг больше DRAG_PX → карточка едет за указателем; отпускание над колонкой меняет статус.
  // Без сдвига это щелчок — открывается карточка.
  const onPointerDown = (e: ReactPointerEvent<HTMLElement>, t: Task) => {
    if (e.button !== 0) return;
    const d: Drag = { task: t, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, moving: false, over: null };
    dragRef.current = d;
    setDrag(d);
  };
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.x0;
      const dy = e.clientY - d.y0;
      const moving = d.moving || Math.hypot(dx, dy) > DRAG_PX;
      const col = moving ? (document.elementsFromPoint(e.clientX, e.clientY).find((el) => el.classList.contains('col')) as HTMLElement | undefined) : undefined;
      const next = { ...d, dx, dy, moving, over: col?.dataset.status ?? null };
      dragRef.current = next;
      setDrag(next);
    };
    const onUp = () => {
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!d) return;
      if (!d.moving) {
        openTask(d.task.id);
        return;
      }
      if (d.over && d.over !== d.task.status.id) move.mutate({ t: d.task, statusId: d.over });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    // Подписка живёт, пока идёт нажатие; само состояние — в dragRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag !== null]);

  const list = tasks.data?.items ?? [];
  const counts = (categoryId ? all.data : tasks.data)?.categories ?? [];
  const totalCount = counts.reduce((s, c) => s + c.count, 0);
  const cols = statuses.data?.items ?? [];
  const submitQuick = (e: FormEvent) => { e.preventDefault(); create.mutate(); };
  const filterCats = (categories.data?.items ?? []).filter((c) => counts.some((x) => x.categoryId === c.id) || c.id === categoryId || !c.archived);

  return (
    <>
      <div className="head">
        <div>
          <h1>Задачи</h1>
          <p>Почта, проекты, оперплан и автоматизации реестров попадают на одну доску. Нажмите на карточку, чтобы изменить её или прокомментировать. Перетащите карточку, чтобы сменить статус.</p>
        </div>
        <div className="row">
          <button className="btn primary" type="button" onClick={() => setMailOpen(true)}>Задача из письма</button>
          <div className="filters" role="group" aria-label="Фильтр по категории">
            <button type="button" aria-pressed={!categoryId} onClick={() => setParam({ category: null })}>Все <span className="mono">{totalCount}</span></button>
            {filterCats.map((c) => (
              <button key={c.id} type="button" aria-pressed={categoryId === c.id} onClick={() => setParam({ category: c.id })}>
                {c.value} <span className="mono">{counts.find((x) => x.categoryId === c.id)?.count ?? 0}</span>
              </button>
            ))}
            <button type="button" className="arch-btn" aria-pressed={archived} onClick={() => setParam({ archive: archived ? null : '1', category: null })}>
              Архив <span className="mono">{tasks.data?.archivedTotal ?? 0}</span>
            </button>
          </div>
        </div>
      </div>
      {archived && (
        <div className="note arch-note">
          Показаны задачи в архиве: {tasks.data?.total ?? 0}. Откройте карточку, чтобы вернуть задачу на доску. Чтобы выйти из архива, нажмите «Архив» ещё раз.
        </div>
      )}
      {!archived && (
        <form className="quick" onSubmit={submitQuick} aria-label="Быстрая задача">
          <input className="inp" required maxLength={300} placeholder="Новая задача, например: Проверить права в АБС после увольнения" value={quick.title}
            onChange={(e) => setQuick({ ...quick, title: e.target.value })} aria-label="Новая задача" />
          <select className="inp" value={quickCategory} onChange={(e) => setQuick({ ...quick, categoryId: e.target.value })} aria-label="Категория">
            {quickCategories.map((c) => <option key={c.id} value={c.id}>{c.value}</option>)}
          </select>
          <select className="inp" value={quick.assigneeId} onChange={(e) => setQuick({ ...quick, assigneeId: e.target.value })} aria-label="Ответственный">
            <option value="">— не назначен</option>
            {people.data?.items.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
          </select>
          <input className="inp" type="date" value={quick.dueDate} onChange={(e) => setQuick({ ...quick, dueDate: e.target.value })} aria-label="Срок" />
          <button className="btn primary" type="submit" disabled={create.isPending || !quickCategory}>Назначить</button>
        </form>
      )}
      {tasks.isError && <div className="form-error">{tasks.error.message}</div>}
      <div className="tasks-grid">
        <div className={`board${drag?.moving ? ' is-dragging' : ''}`}>
          {cols.map((c) => {
            const items = sortColumn(list.filter((t) => t.status.id === c.id));
            return (
              <div key={c.id} className={`col${drag?.moving && drag.over === c.id && drag.task.status.id !== c.id ? ' over' : ''}`} data-status={c.id} aria-label={`Колонка «${c.value}»`}>
                <div className="col-h"><span>{c.value}</span><span className="mono">{items.length}</span></div>
                {items.map((t) => <Card key={t.id} t={t} today={today} archived={archived} drag={drag} onPointerDown={onPointerDown} onOpen={openTask} />)}
                {tasks.isSuccess && items.length === 0 && <div className="hint col-empty">{archived ? 'Пусто' : 'Перетащите сюда карточку'}</div>}
              </div>
            );
          })}
        </div>
        <div className="grid-gap">
          <section className="panel">
            <div className="panel-h"><h3>Загрузка сотрудников</h3><span className="sub">открытые задачи</span></div>
            <div className="panel-b">
              <div className="bars">
                {workload(list).map((w) => {
                  const max = Math.max(1, ...workload(list).map((x) => x.count));
                  return (
                    <div key={w.name} className="bar">
                      <span className="t" title={w.name}>{w.name}</span>
                      <span className="track"><span className="fill" style={{ width: `${(w.count / max) * 100}%` }} /></span>
                      <span className="n mono">{w.count}</span>
                    </div>
                  );
                })}
                {tasks.isSuccess && workload(list).length === 0 && <div className="hint">Открытых задач нет</div>}
              </div>
            </div>
          </section>
        </div>
      </div>
      {openId && <TaskDrawer key={openId} id={openId} canDelete={me.permissions.includes('tasks.delete')} onClose={() => setParam({ task: null })} />}
      {mailOpen && <MailDrawer meId={me.id} onClose={() => setMailOpen(false)} onCreated={(id) => { setMailOpen(false); openTask(id); }} />}
    </>
  );
}
