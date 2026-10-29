import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { settingsApi } from '../../api/settings';
import { tasksApi, tkeys, type TaskDetail, type TaskPatch } from '../../api/tasks';
import { Overlay } from '../../components/Overlay';
import { useMe } from '../../auth/useMe';
import { useToast } from '../../components/Toast';
import { formatDateTime } from '../settings/logic';
import { initials } from './logic';

interface Draft {
  title: string;
  description: string;
  statusId: string;
  assigneeId: string;
  dueDate: string;
  priorityId: string;
  categoryId: string;
}

const draftOf = (t: TaskDetail): Draft => ({
  title: t.title,
  description: t.description,
  statusId: t.status.id,
  assigneeId: t.assignee?.id ?? '',
  dueDate: t.dueDate ?? '',
  priorityId: t.priority.id,
  categoryId: t.category.id,
});

/** В PATCH уходят только изменённые поля. */
function changes(t: TaskDetail, d: Draft): Omit<TaskPatch, 'version'> {
  const o = draftOf(t);
  const out: Omit<TaskPatch, 'version'> = {};
  if (d.title.trim() !== o.title) out.title = d.title;
  if (d.description !== o.description) out.description = d.description;
  if (d.statusId !== o.statusId) out.statusId = d.statusId;
  if (d.assigneeId !== o.assigneeId) out.assigneeId = d.assigneeId || null;
  if (d.dueDate !== o.dueDate) out.dueDate = d.dueDate || null;
  if (d.priorityId !== o.priorityId) out.priorityId = d.priorityId;
  if (d.categoryId !== o.categoryId) out.categoryId = d.categoryId;
  return out;
}

const SOURCE: Record<TaskDetail['source'], string> = { manual: 'поставлена вручную', mail: 'из письма', automation: 'автоматизация реестра', document: 'по документу', evidence: 'по доказательству' };

export function TaskDrawer({ id, canDelete, onClose }: { id: string; canDelete: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const task = useQuery({ queryKey: tkeys.detail(id), queryFn: () => tasksApi.get(id) });
  const comments = useQuery({ queryKey: tkeys.comments(id), queryFn: () => tasksApi.comments(id) });
  // История — по праву «История в карточках» (ADR-0021); комментарии видят все.
  const canHistory = !!useMe().data?.permissions.includes('history.view');
  const history = useQuery({ queryKey: tkeys.history(id), queryFn: () => tasksApi.history(id), enabled: canHistory });
  const statuses = useQuery({ queryKey: tkeys.statuses, queryFn: () => settingsApi.items('task_statuses', false) });
  const priorities = useQuery({ queryKey: tkeys.priorities, queryFn: () => settingsApi.items('task_priorities', false) });
  const categories = useQuery({ queryKey: tkeys.categories, queryFn: () => settingsApi.items('task_categories', false) });
  const people = useQuery({ queryKey: ['settings', 'userOptions'], queryFn: settingsApi.userOptions });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loaded, setLoaded] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [conflict, setConflict] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const t = task.data;

  // Черновик — из задачи при открытии и после «Перечитать».
  useEffect(() => {
    if (t && loaded === null) {
      setDraft(draftOf(t));
      setLoaded(t.version);
    }
  }, [t, loaded]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: tkeys.all }),
    qc.invalidateQueries({ queryKey: ['registers'] }),
  ]);
  const onError = (e: unknown) => {
    if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
      setConflict(true);
      return;
    }
    toast(e instanceof Error ? e.message : 'Не удалось сохранить', 'error');
  };
  const afterSave = async (text: string) => {
    await refresh();
    setLoaded(null);
    toast(text);
  };
  const save = useMutation({
    mutationFn: (patch: Omit<TaskPatch, 'version'>) => tasksApi.update(id, { version: t?.version ?? 0, ...patch }),
    onSuccess: (r) => afterSave(`Задача #${r.number} сохранена`),
    onError,
  });
  const archive = useMutation({
    mutationFn: () => (t?.archived ? tasksApi.restore(id, t.version) : tasksApi.archive(id, t?.version ?? 0)),
    onSuccess: (r) => afterSave(r.archived ? `Задача #${r.number} в архиве` : `Задача #${r.number} снова на доске`),
    onError,
  });
  const remove = useMutation({
    mutationFn: () => tasksApi.remove(id, t?.version ?? 0),
    onSuccess: async () => {
      // Сначала закрыть и забыть удалённую задачу: иначе карточка перечитала бы её (404) с повторами.
      onClose();
      for (const key of [tkeys.detail(id), tkeys.comments(id), tkeys.history(id)]) qc.removeQueries({ queryKey: key });
      toast(`Задача #${t?.number ?? ''} удалена`);
      await refresh();
    },
    onError,
  });
  const addComment = useMutation({
    mutationFn: () => tasksApi.addComment(id, comment),
    onSuccess: async () => {
      setComment('');
      await Promise.all([qc.invalidateQueries({ queryKey: tkeys.comments(id) }), qc.invalidateQueries({ queryKey: tkeys.history(id) }), qc.invalidateQueries({ queryKey: tkeys.all })]);
      toast('Комментарий добавлен');
    },
    onError,
  });

  const reload = async () => {
    setConflict(false);
    setLoaded(null);
    await qc.invalidateQueries({ queryKey: tkeys.detail(id) });
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!t || !draft) return;
    const patch = changes(t, draft);
    if (Object.keys(patch).length === 0) {
      toast('Изменений нет');
      return;
    }
    save.mutate(patch);
  };
  const doneId = statuses.data?.items.find((s) => s.systemKey === 'done')?.id;
  const readOnly = !!t?.archived;
  const people0 = people.data?.items ?? [];
  const assigneeMissing = t && draft?.assigneeId && !people0.some((p) => p.id === draft.assigneeId);

  return (
    <Overlay>
      <div className="backdrop drawer-backdrop" role="presentation" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Задача">
        <div className="dr-h">
          <div className="min0">
            <div className="eyebrow">Задача #{t?.number ?? ''} · {t ? `${t.category.value}, ${SOURCE[t.source]}` : ''}</div>
            <b className="dr-title">{t?.title ?? 'Загрузка…'}</b>
            <div className="row nowrap mt6">
              {t?.urgent && <span className="chip crit">срочно</span>}
              {t?.overdue && <span className="chip crit">просрочено</span>}
              {t?.archived && <span className="chip">В архиве</span>}
              {t && !t.assignee && <span className="chip high">не назначен</span>}
            </div>
          </div>
          <button className="btn sm" type="button" onClick={onClose}>Закрыть</button>
        </div>
        <div className="dr-b">
          {task.isError && <div className="form-error">{task.error.message}</div>}
          {conflict && (
            <div className="note conflict" role="alert">
              Задачу изменил другой пользователь — ваши изменения не сохранены.
              <div className="row mt6"><button className="btn sm primary" type="button" onClick={() => void reload()}>Перечитать задачу</button></div>
            </div>
          )}
          {t && draft && (
            <form className="task-form" onSubmit={submit}>
              <label>Название<input className="inp" required maxLength={300} value={draft.title} disabled={readOnly} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>
              <label>Описание<textarea className="inp" placeholder="Что нужно сделать, критерий готовности" value={draft.description} disabled={readOnly} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></label>
              <div className="fgrid">
                <label>Статус
                  <select className="inp" value={draft.statusId} disabled={readOnly} onChange={(e) => setDraft({ ...draft, statusId: e.target.value })}>
                    {statuses.data?.items.map((s) => <option key={s.id} value={s.id}>{s.value}</option>)}
                  </select>
                </label>
                <label>Ответственный
                  <select className="inp" value={draft.assigneeId} disabled={readOnly} onChange={(e) => setDraft({ ...draft, assigneeId: e.target.value })}>
                    <option value="">— не назначен</option>
                    {assigneeMissing && t.assignee && <option value={t.assignee.id}>{t.assignee.fullName}</option>}
                    {people0.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
                  </select>
                </label>
                <label>Срок<input className="inp" type="date" value={draft.dueDate} disabled={readOnly} onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })} /></label>
                <label>Приоритет
                  <select className="inp" value={draft.priorityId} disabled={readOnly} onChange={(e) => setDraft({ ...draft, priorityId: e.target.value })}>
                    {priorities.data?.items.map((s) => <option key={s.id} value={s.id}>{s.value}</option>)}
                    {!priorities.data?.items.some((s) => s.id === t.priority.id) && <option value={t.priority.id}>{t.priority.value}</option>}
                  </select>
                </label>
                <label>Категория
                  <select className="inp" value={draft.categoryId} disabled={readOnly} onChange={(e) => setDraft({ ...draft, categoryId: e.target.value })}>
                    {categories.data?.items.map((s) => <option key={s.id} value={s.id}>{s.value}</option>)}
                    {!categories.data?.items.some((s) => s.id === t.category.id) && <option value={t.category.id}>{t.category.value}</option>}
                  </select>
                </label>
              </div>
              {!readOnly && (
                <div className="row">
                  <button className="btn primary" type="submit" disabled={save.isPending || conflict}>Сохранить</button>
                  {doneId && t.status.id !== doneId && (
                    <button className="btn" type="button" disabled={save.isPending || conflict} onClick={() => save.mutate({ statusId: doneId })}>Отметить выполненной</button>
                  )}
                </div>
              )}
            </form>
          )}

          {t?.record && (
            <div className="mailbox">
              <div className="eyebrow">Запись реестра</div>
              <div>
                <Link to={`/registers#${t.record.registerId}/records`}>{t.record.registerName}, запись #{t.record.number}{t.record.title ? ` «${t.record.title}»` : ''}</Link>
              </div>
              {t.recipientLabel && <div className="hint">Получатели по правилу: {t.recipientLabel}</div>}
            </div>
          )}
          {t?.document && (
            <div className="mailbox">
              <div className="eyebrow">Документ</div>
              <div>
                <Link to={`/documents?doc=${t.document.id}`}>Документ #{t.document.number}</Link>
                {' · '}{t.document.reason === 'review' ? 'пересмотр' : 'доработка после возврата'}
              </div>
              <div className="hint">Задача закроется сама, когда {t.document.reason === 'review' ? 'новую версию утвердят' : 'документ снова отправят на согласование'}.</div>
            </div>
          )}
          {t?.evidence && (
            <div className="mailbox">
              <div className="eyebrow">Доказательство</div>
              <div>
                <Link to={`/evidence?ev=${t.evidence.id}`}>Доказательство #{t.evidence.number}</Link>
                {' · '}{t.evidence.reason === 'rejected' ? 'отклонено при проверке' : 'истекает срок действия'}
              </div>
              <div className="hint">Задача закроется сама, когда {t.evidence.reason === 'rejected' ? 'к доказательству приложат исправленный файл или загрузят новую форму' : 'примут новую форму по тому же объекту'}.</div>
            </div>
          )}
          {t && !t.assignee && t.recipients.length > 0 && (
            <div className="note" role="note">
              Ответственный не назначен: у метки нет пользователей портала. Назначьте задачу сотруднику ИБ или свяжитесь с получателями сами — адреса для справки, письма портал не отправляет.
              <ul className="recipients">
                {t.recipients.map((r) => (
                  <li key={r.label}>
                    <b>{r.label}</b>{' — '}
                    {r.emails.length ? r.emails.map((e, i) => <span key={e}>{i > 0 && ', '}<a href={`mailto:${e}`}>{e}</a></span>) : <span className="hint">e-mail не указан</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {t?.mail && (
            <div className="mailbox">
              <div className="eyebrow">Исходное письмо</div>
              <div><b className="w500">{t.mail.subject || '(без темы)'}</b></div>
              <div className="hint">{t.mail.from || 'отправитель не указан'}{t.mail.sent ? ` · ${t.mail.sent}` : ''}</div>
              <div className="why">
                {t.mail.rule ? `Правило «${t.mail.rule.label}»: ${t.mail.ruleHits.join(', ')}` : 'Правило разбора не подошло'} · срок: {t.mail.dueReason}
              </div>
              <pre>{t.mail.body}</pre>
            </div>
          )}

          <div>
            <div className="eyebrow">Комментарии · {comments.data?.items.length ?? 0}</div>
            {comments.data?.items.length === 0 && <div className="hint">Комментариев пока нет</div>}
            {comments.data?.items.map((c) => (
              <div key={c.id} className="cmt">
                <span className="av" aria-hidden="true">{c.author ? initials(c.author.fullName) : 'А'}</span>
                <div>
                  <div className="who">{c.author?.fullName ?? 'Автоматизация'} · {formatDateTime(c.createdAt)}</div>
                  <div className="tx">{c.body}</div>
                </div>
              </div>
            ))}
            {!readOnly && (
              <form className="grid-gap mt12" onSubmit={(e) => { e.preventDefault(); addComment.mutate(); }}>
                <textarea className="inp" required maxLength={4000} placeholder="Написать комментарий: что сделано, что мешает" value={comment}
                  onChange={(e) => setComment(e.target.value)} aria-label="Комментарий" />
                <div><button className="btn sm" type="submit" disabled={addComment.isPending || !comment.trim()}>Добавить комментарий</button></div>
              </form>
            )}
          </div>

          {canHistory && (
            <div>
              <div className="eyebrow">История изменений</div>
              <div className="hist">
                {history.data?.items.map((h) => (
                  <div key={h.id} className="hist-item">
                    <div>{formatDateTime(h.at)} · {h.actor?.fullName ?? 'Система'}</div>
                    <div className="m">{h.summary}</div>
                    {h.changes.map((c, i) => <div key={i} className="m">«{c.label}»: {c.from} → {c.to}</div>)}
                  </div>
                ))}
              </div>
            </div>
          )}

          {t && !confirmDelete && (
            <div className="row dr-actions">
              <button className="btn sm" type="button" disabled={archive.isPending} onClick={() => archive.mutate()}>{t.archived ? 'Вернуть на доску' : 'В архив'}</button>
              {canDelete
                ? <button className="btn sm danger-t" type="button" onClick={() => setConfirmDelete(true)}>Удалить задачу</button>
                : <span className="hint">Удалить задачу может роль с правом «Задачи: удаление»</span>}
            </div>
          )}
          {t && confirmDelete && (
            <div className="danger-zone">
              <div>Удалить задачу «{t.title}»? Она пропадёт с доски и из архива; в журнале останется запись.</div>
              <div className="row">
                <button className="btn sm danger" type="button" disabled={remove.isPending} onClick={() => remove.mutate()}>Удалить</button>
                <button className="btn sm" type="button" onClick={() => setConfirmDelete(false)}>Отмена</button>
              </div>
            </div>
          )}
        </div>
      </aside>
    </Overlay>
  );
}
