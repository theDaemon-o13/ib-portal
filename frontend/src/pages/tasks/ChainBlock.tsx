import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '../../api/client';
import { chainsApi, tkeys, type TaskDetail } from '../../api/tasks';
import { useToast } from '../../components/Toast';
import { formatDateTime } from '../settings/logic';
import { ChainSuggest, type ChainChoice } from './ChainSuggest';
import { chainCounts } from './logic';

/**
 * Блок «Цепочка» в карточке задачи (1.7.0, ADR-0035): хронология задач цепочки с переходом к каждой, отвязать,
 * перенести. Без цепочки — подсказка по названию и «Добавить в цепочку». Цепочка — только группировка: статус,
 * исполнитель и архив задачи не меняются. Привязывать можно и выполненные, и архивные задачи.
 */
export function ChainBlock({ task, title, onOpenTask, onChanged }: {
  task: TaskDetail;
  /** Текущее название в форме: подсказка следует за правкой. */
  title: string;
  onOpenTask: (id: string) => void;
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [moving, setMoving] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const chainId = task.chain?.id ?? null;
  const chain = useQuery({ queryKey: tkeys.chain(chainId ?? ''), queryFn: () => chainsApi.get(chainId as string), enabled: !!chainId });
  const needOpen = moving !== null || adding !== null;
  const open = useQuery({ queryKey: tkeys.chainList({ status: 'open' }), queryFn: () => chainsApi.list({ status: 'open' }), enabled: needOpen });

  const done = async (text: string) => {
    setMoving(null);
    setAdding(null);
    await qc.invalidateQueries({ queryKey: tkeys.all });
    onChanged();
    toast(text);
  };
  const onError = (e: unknown) => toast(e instanceof ApiError || e instanceof Error ? e.message : 'Не удалось изменить цепочку', 'error');
  const me = { id: task.id, version: task.version };

  const pick = useMutation({
    mutationFn: (c: ChainChoice) => (c.kind === 'chain'
      ? chainsApi.attach(c.id, [me], c.reopen)
      : chainsApi.create({ title: c.title, tasks: [me, ...c.withTasks] })),
    onSuccess: (r) => done(`Задача #${task.number} в цепочке «${r.title}»`),
    onError,
  });
  const detach = useMutation({
    mutationFn: () => chainsApi.detach(chainId as string, task.id, task.version),
    onSuccess: () => done(`Задача #${task.number} отвязана от цепочки`),
    onError,
  });
  const move = useMutation({
    mutationFn: (to: string) => chainsApi.move(task.id, task.version, to),
    onSuccess: (r) => done(`Задача #${task.number} перенесена в цепочку «${r.title}»`),
    onError,
  });
  const busy = pick.isPending || detach.isPending || move.isPending;
  const choices = (open.data?.items ?? []).filter((c) => c.id !== chainId);

  if (!task.chain) {
    return (
      <div className="chain-block" aria-label="Цепочка">
        <div className="eyebrow">Цепочка</div>
        <ChainSuggest title={title} taskId={task.id} busy={busy} onPick={(c) => c && pick.mutate(c)} />
        {adding === null
          ? <div><button type="button" className="btn ghost sm" disabled={busy} onClick={() => setAdding('')}>Добавить в цепочку…</button></div>
          : (
            <form className="row" onSubmit={(e) => { e.preventDefault(); if (adding) pick.mutate({ kind: 'chain', id: adding, title: '', reopen: false }); }}>
              <select className="inp grow" aria-label="Открытая цепочка" value={adding} onChange={(e) => setAdding(e.target.value)}>
                <option value="">— выберите открытую цепочку</option>
                {choices.map((c) => <option key={c.id} value={c.id}>{c.title} · {chainCounts(c.counts)}</option>)}
              </select>
              <button className="btn sm primary" type="submit" disabled={busy || !adding}>Добавить</button>
              <button className="btn sm" type="button" onClick={() => setAdding(null)}>Отмена</button>
            </form>
          )}
      </div>
    );
  }

  const c = chain.data;
  return (
    <div className="chain-block" aria-label="Цепочка" data-testid="chain-block">
      <div className="eyebrow">Цепочка</div>
      <div className="row">
        <b>{task.chain.title}</b>
        {c && <span className="hint">{chainCounts(c.counts)}</span>}
        {task.chain.status === 'closed' && <span className="chip">закрыта</span>}
      </div>
      {chain.isError && <div className="form-error">{chain.error.message}</div>}
      {c && (
        <ol className="chain-timeline" aria-label="Задачи цепочки">
          {c.tasks.map((m) => (
            <li key={m.id} className={m.id === task.id ? 'cur' : undefined} data-task={m.number}>
              <time>{formatDateTime(m.createdAt)}</time>
              {m.id === task.id
                ? <span className="ct-title"><b>#{m.number}</b> {m.title} <span className="hint">(эта задача)</span></span>
                : <button type="button" className="btn ghost sm ct-title" onClick={() => onOpenTask(m.id)}><b>#{m.number}</b> {m.title}</button>}
              <span className={`chip${m.completedAt ? ' low' : ''}`}>{m.status.value}</span>
              {m.archived && <span className="chip">в архиве</span>}
              {m.assignee && <span className="hint">{m.assignee.fullName}</span>}
            </li>
          ))}
        </ol>
      )}
      {moving === null && (
        <div className="row">
          <button type="button" className="btn ghost sm" disabled={busy} onClick={() => detach.mutate()}>Отвязать</button>
          <button type="button" className="btn ghost sm" disabled={busy} onClick={() => setMoving('')}>Перенести в другую цепочку…</button>
        </div>
      )}
      {moving !== null && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (moving) move.mutate(moving); }}>
          <select className="inp grow" aria-label="Цепочка для переноса" value={moving} onChange={(e) => setMoving(e.target.value)}>
            <option value="">— выберите открытую цепочку</option>
            {choices.map((x) => <option key={x.id} value={x.id}>{x.title} · {chainCounts(x.counts)}</option>)}
          </select>
          <button className="btn sm primary" type="submit" disabled={busy || !moving}>Перенести</button>
          <button className="btn sm" type="button" onClick={() => setMoving(null)}>Отмена</button>
        </form>
      )}
    </div>
  );
}
