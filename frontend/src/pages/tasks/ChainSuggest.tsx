import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { chainsApi, tkeys, type ChainSuggestion, type TaskRef } from '../../api/tasks';
import { chainCounts, chainTitleOf, SUGGEST_NOTE } from './logic';

/** Выбор из подсказки: в существующую цепочку (reopen — «Вернуть в работу и добавить») или новая цепочка. */
export type ChainChoice =
  | { kind: 'chain'; id: string; title: string; reopen: boolean }
  | { kind: 'new'; title: string; withTasks: TaskRef[] };

/** Параметр chain для POST /tasks. */
export function chainParam(c: ChainChoice | null) {
  if (!c) return undefined;
  return c.kind === 'chain' ? { id: c.id, ...(c.reopen ? { reopen: true } : {}) } : { newTitle: c.title, withTasks: c.withTasks };
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const h = setTimeout(() => setV(value), ms);
    return () => clearTimeout(h);
  }, [value, ms]);
  return v;
}

/**
 * Подсказка цепочки под заголовком задачи (1.7.0, ADR-0035): «Похоже на цепочку „…“». Ничего не блокирует, закрывается.
 * При создании задачи выбор запоминается и уходит вместе с задачей (choice); в карточке — onPick выполняет действие сразу.
 */
export function ChainSuggest({ title, taskId, choice, onPick, busy = false }: {
  title: string;
  taskId?: string;
  choice?: ChainChoice | null;
  onPick: (c: ChainChoice | null) => void;
  busy?: boolean;
}) {
  const q = useDebounced(title.trim(), 400);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const enabled = q.length >= 3 && !choice && dismissed !== q;
  const s = useQuery({ queryKey: tkeys.chainSuggest(q, taskId), queryFn: () => chainsApi.suggest(q, taskId), enabled, staleTime: 15_000 });

  if (choice) {
    return (
      <div className="note chain-choice" role="status" data-testid="chain-choice">
        {choice.kind === 'chain'
          ? <>Задача будет добавлена в цепочку «{choice.title}»{choice.reopen ? ' — цепочка откроется заново' : ''}.</>
          : <>Будет создана цепочка «{choice.title}»{choice.withTasks.length ? ` с задачами: ${choice.withTasks.length + 1}` : ''}.</>}
        {' '}<button type="button" className="btn ghost sm" onClick={() => onPick(null)}>Отменить</button>
      </div>
    );
  }
  const items = enabled ? s.data?.items ?? [] : [];
  if (!items.length) return null;
  const newTitle = chainTitleOf(q);

  const pickChain = (i: Extract<ChainSuggestion, { kind: 'chain' }>) =>
    onPick({ kind: 'chain', id: i.chain.id, title: i.chain.title, reopen: i.chain.status === 'closed' });

  return (
    <section className="chain-suggest" aria-label="Похоже на цепочку" data-testid="chain-suggest">
      <button type="button" className="x" aria-label="Скрыть подсказку" onClick={() => setDismissed(q)}>×</button>
      {items.map((i) => (i.kind === 'chain'
        ? (
          <div key={i.chain.id} className="cs-item" data-chain={i.chain.title}>
            <div className="cs-t">
              Похоже на цепочку «<b>{i.chain.title}</b>» <span className="hint">· {chainCounts(i.chain.counts)}</span>
              {SUGGEST_NOTE[i.group] && <span className={`chip${i.group === 'closed_unfinished' ? ' high' : ''}`}>{SUGGEST_NOTE[i.group]}</span>}
            </div>
            {i.chain.status === 'open' && <button type="button" className="btn sm" disabled={busy} onClick={() => pickChain(i)}>Добавить в цепочку</button>}
            {i.chain.status === 'closed' && (i.chain.canManage
              ? <button type="button" className="btn sm" disabled={busy} onClick={() => pickChain(i)}>Вернуть в работу и добавить</button>
              : <span className="hint">Открыть заново может создатель цепочки, её ответственный или руководитель</span>)}
          </div>
        )
        : (
          <div key="tasks" className="cs-item" data-testid="chain-suggest-tasks">
            <div className="cs-t">
              Та же тема у задач без цепочки: <b>{i.total}</b>
              <span className="hint"> · {i.tasks.slice(0, 3).map((t) => `#${t.number}${t.completed ? ' (выполнена)' : ''}`).join(', ')}{i.total > 3 ? '…' : ''}</span>
            </div>
            <button type="button" className="btn sm" disabled={busy}
              onClick={() => onPick({ kind: 'new', title: newTitle, withTasks: i.tasks.map((t) => ({ id: t.id, version: t.version })) })}>
              Создать цепочку из этих задач
            </button>
          </div>
        )))}
      <div className="cs-foot">
        <button type="button" className="btn ghost sm" disabled={busy} onClick={() => onPick({ kind: 'new', title: newTitle, withTasks: [] })}>Создать новую</button>
        <span className="hint">{taskId ? 'Подсказку можно скрыть — она ничего не меняет' : 'Подсказку можно не использовать — задача создастся и без цепочки'}</span>
      </div>
    </section>
  );
}
