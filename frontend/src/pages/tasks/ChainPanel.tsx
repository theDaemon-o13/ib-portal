import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { settingsApi } from '../../api/settings';
import { chainsApi, tkeys, type ChainDetail } from '../../api/tasks';
import { DetailPanel } from '../../components/DetailPanel';
import { useToast } from '../../components/Toast';
import { formatDateTime } from '../settings/logic';
import { chainCounts } from './logic';
import { Select } from '../../components/Select';

interface Draft { title: string; ownerId: string; dueDate: string; summary: string }
const draftOf = (c: ChainDetail): Draft => ({ title: c.title, ownerId: c.owner?.id ?? '', dueDate: c.dueDate ?? '', summary: c.summary });

/**
 * Панель цепочки (1.7.0, ADR-0035): название, ответственный, срок, статус, сводка, задачи по дате.
 * Править, закрывать, открывать и удалять — создатель, ответственный или «Задачи: постановка другим» (canManage).
 * Когда все задачи выполнены — предложение «Закрыть цепочку»; сама цепочка не закрывается.
 */
export function ChainPanel({ id, onClose, onOpenTask }: { id: string; onClose: () => void; onOpenTask: (taskId: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const chain = useQuery({ queryKey: tkeys.chain(id), queryFn: () => chainsApi.get(id) });
  const people = useQuery({ queryKey: ['settings', 'userOptions'], queryFn: settingsApi.userOptions });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [conflict, setConflict] = useState(false);
  const [confirm, setConfirm] = useState<'close' | 'delete' | null>(null);
  const c = chain.data;
  const formId = useId();

  useEffect(() => {
    if (c && draft === null) setDraft(draftOf(c));
  }, [c, draft]);

  const done = async (text: string) => {
    setConfirm(null);
    setDraft(null);
    await qc.invalidateQueries({ queryKey: tkeys.all });
    toast(text);
  };
  const onError = (e: unknown) => {
    if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') setConflict(true);
    else toast(e instanceof Error ? e.message : 'Не удалось изменить цепочку', 'error');
  };
  const save = useMutation({
    mutationFn: (d: Draft) => chainsApi.update(id, { version: c?.version ?? 0, title: d.title, ownerId: d.ownerId || null, dueDate: d.dueDate || null, summary: d.summary }),
    onSuccess: (r) => done(`Цепочка «${r.title}» сохранена`),
    onError,
  });
  const close = useMutation({ mutationFn: () => chainsApi.close(id, c?.version ?? 0), onSuccess: (r) => done(`Цепочка «${r.title}» закрыта`), onError });
  const reopen = useMutation({ mutationFn: () => chainsApi.reopen(id, c?.version ?? 0), onSuccess: (r) => done(`Цепочка «${r.title}» открыта заново`), onError });
  const remove = useMutation({
    mutationFn: () => chainsApi.remove(id, c?.version ?? 0),
    onSuccess: async () => {
      onClose();
      qc.removeQueries({ queryKey: tkeys.chain(id) });
      await qc.invalidateQueries({ queryKey: tkeys.all });
      toast(`Цепочка «${c?.title ?? ''}» удалена, задачи отвязаны`);
    },
    onError,
  });
  const busy = save.isPending || close.isPending || reopen.isPending || remove.isPending;
  const ro = !c?.canManage;
  const open = (c?.counts.total ?? 0) - (c?.counts.done ?? 0);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (draft) save.mutate(draft);
  };
  const reload = async () => {
    setConflict(false);
    setDraft(null);
    await qc.invalidateQueries({ queryKey: tkeys.chain(id) });
  };
  const owners = people.data?.items ?? [];

  const footer = c && c.canManage && !confirm ? (
    <div className="row dp-f-save">
      <button className="btn" form={formId} type="submit" disabled={busy || conflict}>Сохранить</button>
      {c.status === 'open'
        ? <button className="btn" type="button" disabled={busy || conflict} onClick={() => (open > 0 ? setConfirm('close') : close.mutate())}>Закрыть цепочку</button>
        : <button className="btn" type="button" disabled={busy || conflict} onClick={() => reopen.mutate()}>Открыть заново</button>}
      <button className="btn danger-t" type="button" disabled={busy || conflict} onClick={() => setConfirm('delete')}>Удалить</button>
    </div>
  ) : undefined;

  return (
    <DetailPanel label="Цепочка" onClose={onClose} scrollKey={id} testId="chain-panel"
      eyebrow={c ? <>Цепочка #{c.number}. {chainCounts(c.counts)}</> : 'Цепочка'}
      title={c?.title ?? 'Загрузка…'}
      badges={c?.status === 'closed' ? <span className="chip">закрыта{c.closedAt ? ` ${formatDateTime(c.closedAt).slice(0, 10)}` : ''}</span> : undefined}
      footer={footer}>
      {chain.isError && <div className="form-error">{chain.error.message}</div>}
      {conflict && (
        <div className="note conflict" role="alert">
          Цепочку изменил другой пользователь — ваши изменения не сохранены.
          <div className="row mt6"><button className="btn sm primary" type="button" onClick={() => void reload()}>Перечитать цепочку</button></div>
        </div>
      )}
      {c && c.status === 'open' && c.allDone && c.canManage && !confirm && (
        <div className="note" role="status" data-testid="chain-all-done">
          Все задачи цепочки выполнены.{' '}
          <button className="btn sm primary" type="button" disabled={busy} onClick={() => close.mutate()}>Закрыть цепочку</button>
        </div>
      )}
      {confirm === 'close' && (
        <div className="danger-zone">
          <div>В цепочке {open} {open === 1 ? 'незавершённая задача' : 'незавершённые задачи'}. Закрыть цепочку? Задачи останутся на доске.</div>
          <div className="row">
            <button className="btn sm primary" type="button" disabled={busy} onClick={() => close.mutate()}>Закрыть</button>
            <button className="btn sm" type="button" onClick={() => setConfirm(null)}>Отмена</button>
          </div>
        </div>
      )}
      {confirm === 'delete' && c && (
        <div className="danger-zone">
          <div>Удалить цепочку «{c.title}»? Задачи ({c.counts.total}) будут отвязаны от цепочки, сами задачи останутся. Чтобы просто завершить работу, нажмите «Закрыть цепочку».</div>
          <div className="row">
            <button className="btn sm danger" type="button" disabled={busy} onClick={() => remove.mutate()}>Удалить</button>
            <button className="btn sm" type="button" onClick={() => setConfirm(null)}>Отмена</button>
          </div>
        </div>
      )}
      {c && draft && (
        <form className="task-form" id={formId} onSubmit={submit} aria-label="Цепочка">
          <label>Название<input className="inp" required maxLength={300} value={draft.title} disabled={ro} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>
          <div className="fgrid">
            <label>Ответственный
              <Select className="inp" value={draft.ownerId} disabled={ro} onChange={(e) => setDraft({ ...draft, ownerId: e.target.value })}>
                <option value="">— не назначен</option>
                {c.owner && !owners.some((p) => p.id === c.owner?.id) && <option value={c.owner.id}>{c.owner.fullName}</option>}
                {owners.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
              </Select>
            </label>
            <label>Срок<input className="inp" type="date" value={draft.dueDate} disabled={ro} onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })} /></label>
            <div className="field-ro"><span>Статус</span><b>{c.status === 'open' ? 'Открыта' : 'Закрыта'}</b></div>
            <div className="field-ro"><span>Создал(а)</span><b>{c.createdBy.fullName}</b></div>
          </div>
          <label>Сводка<textarea className="inp" maxLength={20000} placeholder="К чему пришли, что осталось" value={draft.summary} disabled={ro} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} /></label>
          {ro && <div className="hint">Цепочку меняют её создатель, ответственный или пользователь с правом «Задачи: постановка другим». Добавить или отвязать задачу может любой сотрудник ИБ — в карточке задачи.</div>}
        </form>
      )}
      {c && (
        <div>
          <div className="eyebrow">Задачи по дате <span className="count">{c.counts.total}</span></div>
          <ol className="chain-timeline" aria-label="Задачи цепочки">
            {c.tasks.map((m) => (
              <li key={m.id} data-task={m.number}>
                <time>{formatDateTime(m.createdAt)}</time>
                <button type="button" className="btn ghost sm ct-title" onClick={() => onOpenTask(m.id)}><b>#{m.number}</b> {m.title}</button>
                <span className={`chip${m.completedAt ? ' low' : ''}`}>{m.status.value}</span>
                {m.archived && <span className="chip">в архиве</span>}
                {m.assignee && <span className="hint">{m.assignee.fullName}</span>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </DetailPanel>
  );
}
