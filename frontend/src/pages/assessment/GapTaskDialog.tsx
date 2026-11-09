// Задача по разрыву раздела (Д3, ADR-0026): на общей доске «Задачи», без следа самооценки в самой задаче.
// Право даёт раздел; исполнитель — сотрудник с ib.work; категория — из справочника «Категории задач».
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { akeys, assessmentsApi, type Assessment } from '../../api/assessments';
import { settingsApi } from '../../api/settings';
import { Overlay } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { defaultTaskTitle, type Section } from './logic';
import { Select } from '../../components/Select';

export function GapTaskDialog({ a, s, onClose }: { a: Assessment; s: Section; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const assignees = useQuery({ queryKey: akeys.assignees, queryFn: assessmentsApi.assignees, staleTime: 60_000 });
  const categories = useQuery({ queryKey: ['assessments', 'task-categories'], queryFn: () => settingsApi.items('task_categories', false), staleTime: 60_000 });
  const [title, setTitle] = useState(defaultTaskTitle(s.name));
  const [categoryId, setCategory] = useState('');
  const [assigneeId, setAssignee] = useState('');
  const [dueDate, setDue] = useState('');
  const create = useMutation({
    mutationFn: () => assessmentsApi.createTask(a.id, s.code, { title: title.trim(), categoryId, assigneeId, dueDate: dueDate || null }),
    onSuccess: async (t) => {
      await qc.invalidateQueries({ queryKey: akeys.all });
      toast(`Задача #${t.number} поставлена на доску`);
      onClose();
    },
    onError: (err) => toast(err instanceof Error ? err.message : 'Не удалось поставить задачу', 'error'),
  });
  const send = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  const busy = create.isPending;
  return (
    <Overlay>
      <div className="backdrop" role="presentation" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
        <form className="modal panel" role="dialog" aria-modal="true" aria-label="Задача по разделу" onSubmit={send}>
          <h2>Задача по разделу {s.code}</h2>
          <div className="note">Задача будет видна всем на доске «Задачи»: название, исполнитель, срок. Баллы и ссылка на самооценку туда не попадают.</div>
          <label className="fd-label">Название<input className="inp" required maxLength={300} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          <label className="fd-label">Категория
            <Select className="inp" required value={categoryId} onChange={(e) => setCategory(e.target.value)}>
              <option value="">{categories.isPending ? 'Загрузка…' : 'Выберите'}</option>
              {categories.data?.items.map((c) => <option key={c.id} value={c.id}>{c.value}</option>)}
            </Select>
          </label>
          <label className="fd-label">Исполнитель
            <Select className="inp" required value={assigneeId} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">{assignees.isPending ? 'Загрузка…' : 'Выберите'}</option>
              {assignees.data?.items.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
            </Select>
          </label>
          <label className="fd-label">Срок<input className="inp" type="date" value={dueDate} onChange={(e) => setDue(e.target.value)} /></label>
          <div className="row end">
            <button className="btn" type="button" onClick={onClose} disabled={busy}>Отмена</button>
            <button className="btn primary" type="submit" disabled={busy}>Поставить задачу</button>
          </div>
        </form>
      </div>
    </Overlay>
  );
}
