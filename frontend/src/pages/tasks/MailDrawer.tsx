import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { settingsApi } from '../../api/settings';
import { tasksApi, tkeys, type MailDraft } from '../../api/tasks';
import { DetailPanel } from '../../components/DetailPanel';
import { useToast } from '../../components/Toast';
import { ChainSuggest, chainParam, type ChainChoice } from './ChainSuggest';
import { Select } from '../../components/Select';

const EXAMPLE = 'От: Отдел кадров <hr@example.tj>\nОтправлено: 23.10.2026 10:15\nТема: Блокировка учётных записей\n\nПросим до 27.10 заблокировать…';

/**
 * «Почта → задача» (правило 9): вставить письмо целиком → разобрать → проверить черновик → создать.
 * Пока черновик не проверен, ничего не сохраняется.
 */
/** canAssign — право «Задачи: постановка другим» (релиз 1.2.0): без него ответственный — только «я» или «не назначен». */
export function MailDrawer({ meId, canAssign, onClose, onCreated }: { meId: string; canAssign: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const people = useQuery({ queryKey: ['settings', 'userOptions'], queryFn: settingsApi.userOptions });
  const priorities = useQuery({ queryKey: tkeys.priorities, queryFn: () => settingsApi.items('task_priorities', false) });
  const [raw, setRaw] = useState('');
  const [parsed, setParsed] = useState<MailDraft | null>(null);
  const [form, setForm] = useState({ title: '', assigneeId: '', dueDate: '', priorityId: '', description: '' });
  /** Цепочка из подсказки по теме письма (1.7.0). */
  const [chain, setChain] = useState<ChainChoice | null>(null);


  const parse = useMutation({
    mutationFn: () => tasksApi.mailDraft(raw),
    onSuccess: (d) => {
      setParsed(d);
      setForm({ title: d.title, assigneeId: !d.assignee ? meId : canAssign || d.assignee.id === meId ? d.assignee.id : '', dueDate: d.dueDate, priorityId: d.priorityId, description: d.body });
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Не удалось разобрать письмо', 'error'),
  });
  const create = useMutation({
    mutationFn: () => tasksApi.create({
      title: form.title, description: form.description, assigneeId: form.assigneeId || null, dueDate: form.dueDate || null,
      priorityId: form.priorityId, mail: { raw }, chain: chainParam(chain),
    }),
    onSuccess: async (t) => {
      await qc.invalidateQueries({ queryKey: tkeys.all });
      toast(`Задача #${t.number} создана из письма`);
      onCreated(t.id);
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Не удалось создать задачу', 'error'),
  });

  const submitParse = (e: FormEvent) => { e.preventDefault(); parse.mutate(); };
  const submitCreate = (e: FormEvent) => { e.preventDefault(); create.mutate(); };

  return (
    <DetailPanel label="Задача из письма" onClose={onClose} eyebrow="Портал разберёт отправителя, тему и срок" title="Задача из письма">
          <form className="grid-gap" onSubmit={submitParse}>
            <label className="fd-label">Текст письма. Скопируйте письмо целиком вместе со строками «От», «Тема», «Отправлено»
              <textarea className="inp mail-raw" required placeholder={EXAMPLE} value={raw} onChange={(e) => setRaw(e.target.value)} aria-label="Текст письма" />
            </label>
            <div><button className="btn" type="submit" disabled={parse.isPending || !raw.trim()}>Разобрать письмо</button></div>
          </form>
          {parsed && (
            <form className="task-form mail-draft" onSubmit={submitCreate} aria-label="Черновик задачи">
              <div className="eyebrow">Черновик задачи: проверьте перед созданием</div>
              <label>Название<input className="inp" required maxLength={300} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
              {/* Подсказка — по теме письма; без темы — по названию. */}
              <ChainSuggest title={parsed.subject || form.title} choice={chain} onPick={setChain} />
              <div className="fgrid">
                <label>Ответственный
                  <Select className="inp" value={form.assigneeId} onChange={(e) => setForm({ ...form, assigneeId: e.target.value })}>
                    <option value="">— не назначен</option>
                    {canAssign
                      ? people.data?.items.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)
                      : <option value={meId}>Я</option>}
                  </Select>
                  <span className="why">{parsed.rule ? `Категория письма «${parsed.rule.label}» · ` : ''}{parsed.assigneeReason}</span>
                  {!canAssign && parsed.assignee && parsed.assignee.id !== meId && (
                    <span className="why">Поставить задачу «{parsed.assignee.fullName}» может пользователь с правом «Задачи: постановка другим»</span>
                  )}
                </label>
                <label>Срок
                  <input className="inp" type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
                  <span className="why">{parsed.dueReason}</span>
                </label>
                <label>Приоритет
                  <Select className="inp" value={form.priorityId} onChange={(e) => setForm({ ...form, priorityId: e.target.value })}>
                    {priorities.data?.items.map((p) => <option key={p.id} value={p.id}>{p.value}</option>)}
                  </Select>
                  {parsed.urgent && <span className="why">в письме «срочно»</span>}
                </label>
                <label>Отправитель<input className="inp" readOnly value={parsed.from || '—'} /></label>
              </div>
              <label>Описание (текст письма)<textarea className="inp" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
              <div className="row">
                <button className="btn primary" type="submit" disabled={create.isPending}>Создать задачу</button>
                <span className="hint">Категория — «Почта». Письмо сохранится в карточке задачи.</span>
              </div>
            </form>
          )}
    </DetailPanel>
  );
}
