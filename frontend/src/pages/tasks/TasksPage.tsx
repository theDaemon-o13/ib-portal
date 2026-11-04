import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import { ApiError, type Me } from '../../api/client';
import { settingsApi } from '../../api/settings';
import { tasksApi, tkeys, type Task } from '../../api/tasks';
import { ChipScroller } from '../../components/ChipScroller';
import { Overlay } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { actionNeedsComment, candidatesChip, candidatesLabel, cardStep, categoryTone, dueLabel, initials, needsComment, sortColumn, todayLocal, type ProcessAction, workload, WORKLOAD_KEY, workloadOpen } from './logic';
import { MailDrawer } from './MailDrawer';
import { TaskDrawer } from './TaskDrawer';
import { TaskBulkDialog } from './TaskBulkDialog';

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
  /** Где была карточка при нажатии: копия под указателем рисуется поверх страницы, колонка с прокруткой её не обрезает. */
  rect: { left: number; top: number; width: number };
}

/** Ширина полосы у края доски, в которой перетаскивание прокручивает доску (колонки за краем окна). */
const EDGE_PX = 56;

function plusDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return todayLocal(d);
}

function loadWorkloadOpen(): boolean {
  try {
    return workloadOpen(window.localStorage.getItem(WORKLOAD_KEY), window.innerWidth);
  } catch {
    return workloadOpen(null, window.innerWidth);
  }
}
function saveWorkloadOpen(open: boolean) {
  try {
    window.localStorage.setItem(WORKLOAD_KEY, open ? '1' : '0');
  } catch {
    // хранилище недоступно — выбор просто не запомнится
  }
}

function Card({ t, today, archived, drag, canDrag, onPointerDown, onOpen, onStep, picking, picked, onPick, selected = false, ghost = false }: {
  t: Task; today: string; archived: boolean; drag: Drag | null;
  /** Карточка открыта справа — подсвечена на доске. */
  selected?: boolean;
  /** Копия под указателем при перетаскивании: без обработчиков и data-task. */
  ghost?: boolean;
  /** Перетаскивание — только с правом «Задачи: свободная смена статуса» (релиз 1.2.0); без него щелчок открывает карточку. */
  canDrag: boolean;
  onPointerDown: (e: ReactPointerEvent<HTMLElement>, t: Task) => void; onOpen: (id: string) => void;
  /** Кнопка следующего шага на карточке: своя работа или «Проверить». */
  onStep: (t: Task, a: ProcessAction | 'review') => void;
  /** Режим «Выбрать»: щелчок отмечает карточку, не открывает и не перетаскивает. */
  picking: boolean; picked: boolean; onPick: (id: string) => void;
}) {
  const due = dueLabel(t, today);
  const dragging = !ghost && drag?.moving && drag.task.id === t.id;
  const draggable = canDrag && !archived && !picking && !ghost;
  const step = archived || picking || ghost ? null : cardStep(t);
  const cand = candidatesChip(t.candidates);
  if (ghost) {
    return (
      <article className="card ghost" aria-hidden="true">
        <div className="card-t">{t.urgent && <span className="chip crit">срочно</span>}{t.title}</div>
        <div className="meta"><span className={`tag ${categoryTone(t.category)}`}>{t.category.value}</span></div>
      </article>
    );
  }
  return (
    <article className={`card${archived ? ' arch' : ''}${draggable ? '' : ' static'}${dragging ? ' dragging' : ''}${t.overdue ? ' late' : ''}${picked ? ' picked' : ''}${selected ? ' sel' : ''}`} tabIndex={0}
      aria-label={picking ? `Выбрать задачу ${t.title}` : `Открыть задачу ${t.title}`} aria-pressed={picking ? picked : undefined} aria-current={selected || undefined} data-task={t.id}
      onPointerDown={draggable ? (e) => onPointerDown(e, t) : undefined}
      onClick={picking ? () => onPick(t.id) : draggable ? undefined : () => onOpen(t.id)}
      onKeyDown={(e) => { if (e.key === 'Enter') (picking ? onPick : onOpen)(t.id); }}>
      <div className="card-t">
        {picking && <input type="checkbox" className="card-pick" checked={picked} readOnly tabIndex={-1} aria-hidden="true" />}
        {t.urgent && <span className="chip crit">срочно</span>}{t.title}
      </div>
      <div className="meta">
        <span className={`tag ${categoryTone(t.category)}`}>{t.category.value}</span>
        <span className={`mono${due.late ? ' late-t' : ''}`}>{due.text}</span>
      </div>
      <div className="meta">
        {t.assignee
          ? <span className="row nowrap gap6"><span className="av">{initials(t.assignee.fullName)}</span>{t.assignee.fullName}</span>
          : t.candidates.length
            ? (
              <span className="chip acc cand" data-testid="task-candidates" title={`Могут взять: ${candidatesLabel(t.candidates, t.candidates.length)}`}
                aria-label={`Могут взять: ${candidatesLabel(t.candidates, t.candidates.length)}`}>
                <span className="cand-k">Могут взять</span><span className="cand-n">{cand.first}</span>{cand.more > 0 && <span className="cand-more">+{cand.more}</span>}
              </span>
            )
            : <span className="chip high" title={t.recipientLabel ? `Получатели: ${t.recipientLabel}` : undefined}>не назначен</span>}
        <span className="row nowrap gap6">
          {t.commentCount > 0 && (
            <span className="clip" title="Комментарии">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" /></svg>{t.commentCount}
            </span>
          )}
          {t.source === 'automation' && <span className="chip src" title="Задача из автоматизации реестра">авто</span>}
          {t.source === 'mail' && <span className="chip src" title="Задача из письма">письмо</span>}
          {t.source === 'document' && <span className="chip src" title="Задача по документу">документ</span>}
          {t.source === 'evidence' && <span className="chip src" title="Задача по доказательству">доказательство</span>}
        </span>
      </div>
      {t.reviewer && <div className="meta reviewer" data-testid="card-reviewer">Проверяет: {t.reviewer.fullName}</div>}
      {step && (
        <div className="card-step">
          <button className="btn sm" type="button" onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onStep(t, step.action); }}>{step.label}</button>
        </div>
      )}
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
  // ?automation=<id> — задачи, созданные правилом автоматизации (релиз 1.1.0).
  const automationId = params.get('automation') ?? '';
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [bulk, setBulk] = useState<{ action: 'archive' | 'delete'; ids: string[] } | null>(null);
  // Сменился фильтр — выбор сбрасывается: действие не должно задеть невидимые задачи.
  useEffect(() => setPicked(new Set()), [archived, categoryId, automationId]);
  const togglePick = useCallback((id: string) => setPicked((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  }), []);
  // ?overdue=1 — ссылка с дашборда «Просроченные задачи».
  const overdue = params.get('overdue') === '1' && !archived;
  const [mailOpen, setMailOpen] = useState(false);
  // «Загрузка сотрудников» сворачивается, чтобы пять колонок помещались на 1366–1440 px без прокрутки.
  const [showWorkload, setShowWorkload] = useState(loadWorkloadOpen);
  const toggleWorkload = () => setShowWorkload((v) => { saveWorkloadOpen(!v); return !v; });
  const [drag, setDrag] = useState<Drag | null>(null);
  // Перетаскивание в колонку, где нужен комментарий: окно «Комментарий к переходу».
  const [pendingMove, setPendingMove] = useState<{ t: Task; statusId: string; comment: string } | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const today = todayLocal();

  const statuses = useQuery({ queryKey: tkeys.statuses, queryFn: () => settingsApi.items('task_statuses', false) });
  const cols = statuses.data?.items ?? [];
  const categories = useQuery({ queryKey: tkeys.categories, queryFn: () => settingsApi.items('task_categories', false) });
  const people = useQuery({ queryKey: ['settings', 'userOptions'], queryFn: settingsApi.userOptions });
  const tasks = useQuery({
    queryKey: tkeys.list(archived, categoryId, overdue, automationId),
    queryFn: () => tasksApi.list({ archived, categoryId: categoryId || undefined, automationId: automationId || undefined, overdue }),
  });
  const all = useQuery({ queryKey: tkeys.list(archived, ''), queryFn: () => tasksApi.list({ archived }), enabled: !!categoryId || !!automationId });

  const setParam = useCallback((patch: Record<string, string | null>) => {
    setParams((p) => {
      const n = new URLSearchParams(p);
      for (const [k, v] of Object.entries(patch)) if (v === null) n.delete(k); else n.set(k, v);
      return n;
    });
  }, [setParams]);
  const openTask = useCallback((id: string) => setParam({ task: id }), [setParam]);

  const canOverride = me.permissions.includes('tasks.status.override');
  const canAssign = me.permissions.includes('tasks.assign');
  const [quick, setQuick] = useState({ title: '', categoryId: '', assigneeId: me.id, dueDate: plusDays(5) });
  const quickCategories = (categories.data?.items ?? []).filter((c) => c.systemKey !== 'register' && c.systemKey !== 'mail' && c.systemKey !== 'documents' && c.systemKey !== 'evidence');
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
  const moved = async (t: Task) => {
    setPendingMove(null);
    await qc.invalidateQueries({ queryKey: tkeys.all });
    toast(`«${t.title}» → ${t.status.value}`);
  };
  const moveFailed = async (e: unknown) => {
    await qc.invalidateQueries({ queryKey: tkeys.all });
    toast(e instanceof ApiError && e.code === 'VERSION_CONFLICT' ? 'Задачу успели изменить — доска обновлена, повторите' : e instanceof Error ? e.message : 'Не удалось сменить статус', 'error');
  };
  const move = useMutation({
    mutationFn: ({ t, statusId, comment }: { t: Task; statusId: string; comment?: string; inDialog?: boolean }) =>
      tasksApi.update(t.id, { version: t.version, statusId, ...(comment ? { comment } : {}) }),
    onSuccess: moved,
    // Из окна «Комментарий к переходу» ошибка показывается в самом окне (move.error), без всплывающего сообщения.
    onError: (e, v) => (v.inDialog ? qc.invalidateQueries({ queryKey: tkeys.all }) : moveFailed(e)),
  });
  const moveError = move.error
    ? move.error instanceof ApiError && move.error.code === 'VERSION_CONFLICT' ? 'Задачу успели изменить — доска обновлена. Закройте окно и перенесите снова' : move.error.message
    : null;
  const step = useMutation({
    mutationFn: ({ t, action }: { t: Task; action: ProcessAction }) => tasksApi.action(t.id, action, t.version),
    onSuccess: moved,
    onError: moveFailed,
  });
  // Шаг с карточки: без комментария — сразу; с обязательным комментарием и «Проверить» — открыть карточку.
  const onStep = (t: Task, a: ProcessAction | 'review') => {
    if (a === 'review' || actionNeedsComment(cols, t, a)) openTask(t.id);
    else step.mutate({ t, action: a });
  };

  // Перетаскивание: нажатие → сдвиг больше DRAG_PX → карточка едет за указателем; отпускание над колонкой меняет статус.
  // Без сдвига это щелчок — открывается карточка.
  const onPointerDown = (e: ReactPointerEvent<HTMLElement>, t: Task) => {
    if (e.button !== 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    const d: Drag = { task: t, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, moving: false, over: null, rect: { left: r.left, top: r.top, width: r.width } };
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
      // У края доски — прокрутить её: колонки за краем окна тоже принимают карточку.
      const board = boardRef.current;
      if (moving && board) {
        const b = board.getBoundingClientRect();
        if (e.clientX < b.left + EDGE_PX) board.scrollLeft -= 14;
        else if (e.clientX > b.right - EDGE_PX) board.scrollLeft += 14;
      }
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
      if (!d.over || d.over === d.task.status.id) return;
      if (needsComment(cols, d.task.status.id, d.over)) {
        move.reset();
        setPendingMove({ t: d.task, statusId: d.over, comment: '' });
      }
      else move.mutate({ t: d.task, statusId: d.over });
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
  const submitQuick = (e: FormEvent) => { e.preventDefault(); create.mutate(); };
  const filterCats = (categories.data?.items ?? []).filter((c) => counts.some((x) => x.categoryId === c.id) || c.id === categoryId || !c.archived);
  const automations = (automationId ? all.data ?? tasks.data : tasks.data)?.automations ?? [];
  const visibleIds = list.map((t) => t.id);
  const stopPicking = () => { setPicking(false); setPicked(new Set()); };
  const canDelete = me.permissions.includes('tasks.delete');

  return (
    <>
      <div className="head">
        <div>
          <h1>Задачи</h1>
          <p>
            Почта, проекты, оперплан и автоматизации реестров — на одной доске. Нажмите карточку, чтобы открыть её.
            {canOverride ? ' Перетащите карточку в другую колонку, чтобы сменить статус.' : ' Статус меняется кнопками в карточке.'}
          </p>
        </div>
        <div className="row">
          {me.permissions.includes('tasks.report') && <Link className="btn" to="/tasks/report">Отчёт</Link>}
          <button className="btn primary" type="button" onClick={() => setMailOpen(true)}>Задача из письма</button>
        </div>
      </div>
      <div className="toolbar" aria-label="Фильтры доски">
        <ChipScroller label="Фильтр по категории" className="toolbar-grow">
          <button type="button" aria-pressed={!categoryId} onClick={() => setParam({ category: null })}>Все <span className="mono">{totalCount}</span></button>
          {filterCats.map((c) => (
            <button key={c.id} type="button" aria-pressed={categoryId === c.id} onClick={() => setParam({ category: c.id })}>
              {c.value} <span className="mono">{counts.find((x) => x.categoryId === c.id)?.count ?? 0}</span>
            </button>
          ))}
          <button type="button" className="arch-btn" aria-pressed={archived} onClick={() => setParam({ archive: archived ? null : '1', category: null })}>
            Архив <span className="mono">{tasks.data?.archivedTotal ?? 0}</span>
          </button>
        </ChipScroller>
        {(automations.length > 0 || automationId) && (
          <select className="inp auto-filter" value={automationId} aria-label="Создано автоматизацией" onChange={(e) => setParam({ automation: e.target.value || null })}>
            <option value="">Все источники</option>
            {automations.map((a) => <option key={a.automationId} value={a.automationId}>Автоматизация «{a.label}»: {a.count}</option>)}
          </select>
        )}
        <button type="button" className="btn" aria-pressed={picking} onClick={() => (picking ? stopPicking() : setPicking(true))}>{picking ? 'Отменить выбор' : 'Выбрать'}</button>
        {!showWorkload && <button type="button" className="btn" aria-expanded={false} onClick={toggleWorkload}>Загрузка сотрудников</button>}
      </div>
      {picking && (
        <div className="bulk-bar tasks-bulk" role="toolbar" aria-label="Действия с выбранными задачами">
          <b>Выбрано: {picked.size}</b>
          <button className="btn ghost sm" type="button" onClick={() => setPicked(new Set(visibleIds))} disabled={!visibleIds.length}>Выбрать все на доске ({visibleIds.length})</button>
          {!archived && <button className="btn sm" type="button" disabled={!picked.size} onClick={() => setBulk({ action: 'archive', ids: [...picked] })}>Архивировать выбранные</button>}
          {canDelete && <button className="btn sm danger-t" type="button" disabled={!picked.size} onClick={() => setBulk({ action: 'delete', ids: [...picked] })}>Удалить выбранные</button>}
          <span className="hint">Щелчок по карточке отмечает её.</span>
        </div>
      )}
      {archived && (
        <div className="note arch-note">
          Показаны задачи в архиве: {tasks.data?.total ?? 0}. Откройте карточку, чтобы вернуть задачу на доску. Чтобы выйти из архива, нажмите «Архив» ещё раз.
        </div>
      )}
      {overdue && (
        <div className="note arch-note" data-testid="overdue-filter">
          Показаны только просроченные задачи: {tasks.data?.total ?? 0}.{' '}
          <button type="button" className="btn ghost sm" onClick={() => setParam({ overdue: null })}>Показать все</button>
        </div>
      )}
      {!archived && (
        <form className="quick" onSubmit={submitQuick} aria-label="Быстрая задача">
          <input className="inp" required maxLength={300} placeholder="Новая задача, например: Проверить права в АБС после увольнения" value={quick.title}
            onChange={(e) => setQuick({ ...quick, title: e.target.value })} aria-label="Новая задача" />
          <select className="inp" value={quickCategory} onChange={(e) => setQuick({ ...quick, categoryId: e.target.value })} aria-label="Категория">
            {quickCategories.map((c) => <option key={c.id} value={c.id}>{c.value}</option>)}
          </select>
          <select className="inp" value={quick.assigneeId} onChange={(e) => setQuick({ ...quick, assigneeId: e.target.value })} aria-label="Ответственный"
            title={canAssign ? undefined : 'Поставить задачу другому может пользователь с правом «Задачи: постановка другим»'}>
            <option value="">— не назначен</option>
            {canAssign
              ? people.data?.items.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)
              : <option value={me.id}>{me.fullName} (я)</option>}
          </select>
          <input className="inp" type="date" value={quick.dueDate} onChange={(e) => setQuick({ ...quick, dueDate: e.target.value })} aria-label="Срок" />
          <button className="btn primary" type="submit" disabled={create.isPending || !quickCategory}>Назначить</button>
        </form>
      )}
      {tasks.isError && <div className="form-error">{tasks.error.message}</div>}
      <div className={`tasks-grid${showWorkload ? '' : ' wide'}`}>
        <div ref={boardRef} className={`board${drag?.moving ? ' is-dragging' : ''}`}>
          {cols.map((c) => {
            const items = sortColumn(list.filter((t) => t.status.id === c.id));
            return (
              <div key={c.id} className={`col${drag?.moving && drag.over === c.id && drag.task.status.id !== c.id ? ' over' : ''}`} data-status={c.id} aria-label={`Колонка «${c.value}»`}>
                <div className="col-h"><span>{c.value}</span><span className="mono">{items.length}</span></div>
                {items.map((t) => (
                  <Card key={t.id} t={t} today={today} archived={archived} drag={drag} canDrag={canOverride} onPointerDown={onPointerDown} onOpen={openTask}
                    onStep={onStep} picking={picking} picked={picked.has(t.id)} onPick={togglePick} selected={openId === t.id} />
                ))}
                {tasks.isSuccess && items.length === 0 && (
                  <div className="col-empty">{archived ? 'В архиве таких задач нет' : canOverride ? 'Перетащите сюда карточку' : 'Задач в этой колонке нет'}</div>
                )}
              </div>
            );
          })}
        </div>
        {showWorkload && <div className="grid-gap">
          <section className="panel">
            <div className="panel-h">
              <h3>Загрузка сотрудников</h3>
              <button type="button" className="btn ghost sm" aria-expanded onClick={toggleWorkload} title="Скрыть панель: колонкам доски станет шире">Скрыть</button>
            </div>
            <div className="panel-b hint wl-sub">открытые задачи</div>
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
        </div>}
      </div>
      {drag?.moving && (
        <Overlay>
          <div className="drag-ghost" style={{ left: drag.rect.left, top: drag.rect.top, width: drag.rect.width, transform: `translate(${drag.dx}px, ${drag.dy}px) rotate(1.5deg)` }}>
            <Card t={drag.task} today={today} archived={false} drag={null} canDrag={false} onPointerDown={() => undefined} onOpen={() => undefined}
              onStep={() => undefined} picking={false} picked={false} onPick={() => undefined} ghost />
          </div>
        </Overlay>
      )}
      {openId && <TaskDrawer key={openId} id={openId} canDelete={me.permissions.includes('tasks.delete')} onClose={() => setParam({ task: null })} />}
      {bulk && <TaskBulkDialog action={bulk.action} ids={bulk.ids} onClose={() => setBulk(null)} onDone={() => { setBulk(null); stopPicking(); }} />}
      {mailOpen && <MailDrawer meId={me.id} canAssign={canAssign} onClose={() => setMailOpen(false)} onCreated={(id) => { setMailOpen(false); openTask(id); }} />}
      {pendingMove && (
        <Overlay>
          <div className="backdrop" role="presentation">
            <form className="modal panel" role="dialog" aria-modal="true" aria-labelledby="mv-title"
              onSubmit={(e) => { e.preventDefault(); move.mutate({ t: pendingMove.t, statusId: pendingMove.statusId, comment: pendingMove.comment, inDialog: true }); }}>
              <h2 id="mv-title">Комментарий к переходу</h2>
              <p className="hint">
                «{pendingMove.t.title}»: {pendingMove.t.status.value} → {cols.find((c) => c.id === pendingMove.statusId)?.value}. Для этой колонки комментарий обязателен.
              </p>
              <textarea className="inp" required maxLength={4000} autoFocus aria-label="Комментарий к переходу" value={pendingMove.comment}
                onChange={(e) => setPendingMove({ ...pendingMove, comment: e.target.value })} />
              {moveError && <div className="form-error mt12" role="alert" data-testid="move-error">{moveError}</div>}
              <div className="row end mt12">
                <button className="btn" type="button" onClick={() => setPendingMove(null)} disabled={move.isPending}>Отмена</button>
                <button className="btn primary" type="submit" disabled={move.isPending || !pendingMove.comment.trim()}>Перенести</button>
              </div>
            </form>
          </div>
        </Overlay>
      )}
    </>
  );
}
