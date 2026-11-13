import { useState, type ReactNode } from 'react';
import type { Task } from '../../api/tasks';
import { byDueDate, DUE_HEADERS_FROM, systemChainStats, tasksWord } from './logic';

const ru = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

/**
 * Карточка системной цепочки в колонке доски (1.14.0, ADR-0053): автозадачи реестра одной группы «Уязвимостей» или
 * одного реестра свёрнуты в одну карточку — сколько задач в колонке, не назначено, ближайший срок, просрочено.
 * Раскрытая — задачи колонки по сроку (от DUE_HEADERS_FROM — с подзаголовками дат). «Взять себе все» — с подтверждением.
 */
export function SystemChainCard({ chain, tasks, open, onToggle, onOpenChain, renderTask, onTakeAll, taking }: {
  chain: { id: string; title: string };
  tasks: Task[];
  open: boolean;
  onToggle: () => void;
  onOpenChain: () => void;
  renderTask: (t: Task) => ReactNode;
  onTakeAll: (tasks: Task[]) => void;
  taking: boolean;
}) {
  const st = systemChainStats(tasks);
  const [confirm, setConfirm] = useState(false);
  const n = st.takeable.length;
  return (
    <div className={`chain-group sys${open ? ' open' : ''}`} data-chain={chain.title} data-system-chain={chain.id}>
      <div className="chain-card sys-card">
        <button type="button" className="cc-toggle" aria-expanded={open}
          aria-label={`Цепочка «${chain.title}»: ${open ? 'свернуть' : 'показать задачи'} (${tasksWord(st.count)} в колонке)`} onClick={onToggle}>
          <span className="cc-t">{chain.title}</span>
        </button>
        <div className="meta sys-stats">
          <span className="sys-n" data-testid="sys-count">{tasksWord(st.count)}</span>
          {st.unassigned > 0 && <span className="chip high" data-testid="sys-unassigned">не назначено: {st.unassigned}</span>}
          {st.overdue > 0 && <span className="chip crit" data-testid="sys-overdue">просрочено: {st.overdue}</span>}
        </div>
        <div className="meta sys-stats">
          <span className="mono cc-m">{st.nearestDue ? `ближайший срок ${ru(st.nearestDue)}` : 'без срока'}</span>
          <span className="row nowrap gap6">
            <span className="tag src-reg"><span className="tag-t">Реестр</span></span>
            <span className="chip src">авто</span>
          </span>
        </div>
        {confirm ? (
          <div className="cc-row sys-confirm" role="group" aria-label="Подтверждение">
            <span className="cc-m">Взять {tasksWord(n)}?</span>
            <span className="row nowrap gap6">
              <button type="button" className="btn primary sm" disabled={taking} onClick={() => { setConfirm(false); onTakeAll(st.takeable); }}>Взять</button>
              <button type="button" className="btn ghost sm" onClick={() => setConfirm(false)}>Отмена</button>
            </span>
          </div>
        ) : (
          <div className="cc-row">
            {n > 0 ? <button type="button" className="btn sm" disabled={taking} onClick={() => setConfirm(true)}>Взять себе все ({n})</button> : <span />}
            <button type="button" className="btn ghost sm" onClick={onOpenChain}>Цепочка</button>
          </div>
        )}
      </div>
      {open && (tasks.length >= DUE_HEADERS_FROM
        ? byDueDate(tasks).map((g) => (
          <div key={g.due ?? 'none'} className="sys-day">
            <div className="sys-day-h mono">{g.due ? `срок ${ru(g.due)}` : 'без срока'} · {g.tasks.length}</div>
            {g.tasks.map(renderTask)}
          </div>
        ))
        : byDueDate(tasks).flatMap((g) => g.tasks).map(renderTask))}
    </div>
  );
}
