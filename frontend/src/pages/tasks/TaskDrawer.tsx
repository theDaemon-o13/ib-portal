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
import { ACTION_LABEL, actionNeedsComment, initials, needsComment, processHint, type ProcessAction } from './logic';

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

/** В PATCH уходят только изменённые поля. Статус в обход кнопок — только с правом «Задачи: свободная смена статуса». */
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

/** Задача по документу: причина и когда закроется сама. Этап маршрута (1.6.3) — действие в карточке документа. */
const DOC_REASON: Record<NonNullable<TaskDetail['document']>['reason'], { label: string; hint: string }> = {
  review: { label: 'пересмотр', hint: 'Задача закроется сама, когда новую версию утвердят.' },
  returned: { label: 'доработка после возврата', hint: 'Задача закроется сама, когда документ снова отправят на согласование.' },
  stage: { label: 'этап маршрута', hint: 'Действие выполняется в карточке документа. Задача закроется сама, когда документ перейдёт на следующий этап.' },
};
const SOURCE: Record<TaskDetail['source'], string> = { manual: 'поставлена вручную', mail: 'из письма', automation: 'автоматизация реестра', document: 'по документу', evidence: 'по доказательству' };

export function TaskDrawer({ id, canDelete, onClose }: { id: string; canDelete: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const task = useQuery({ queryKey: tkeys.detail(id), queryFn: () => tasksApi.get(id) });
  const comments = useQuery({ queryKey: tkeys.comments(id), queryFn: () => tasksApi.comments(id) });
  // История — по праву «История в карточках» (ADR-0021); комментарии видят все.
  const me = useMe().data;
  const perms = me?.permissions ?? [];
  const canHistory = perms.includes('history.view');
  // Процесс задач (релиз 1.2.0, ADR-0022): статус списком и перетаскивание — tasks.status.override, исполнитель-другой — tasks.assign.
  const canOverride = perms.includes('tasks.status.override');
  const canAssign = perms.includes('tasks.assign');
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
  /** Кнопка процесса с обязательным комментарием: сначала поле, потом подтверждение. */
  const [stepping, setStepping] = useState<ProcessAction | null>(null);
  const [stepComment, setStepComment] = useState('');
  const [moveComment, setMoveComment] = useState('');
  /** «Заменить проверяющего» (релиз 1.4.0): выбранный сотрудник и комментарий; null — форма закрыта. */
  const [swap, setSwap] = useState<{ reviewerId: string; comment: string } | null>(null);
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
    onSuccess: async (r) => {
      setMoveComment('');
      await Promise.all([afterSave(`Задача #${r.number} сохранена`), qc.invalidateQueries({ queryKey: tkeys.comments(id) })]);
    },
    onError,
  });
  const step = useMutation({
    mutationFn: ({ action, comment }: { action: ProcessAction; comment?: string }) => tasksApi.action(id, action, t?.version ?? 0, comment),
    onSuccess: async (r, v) => {
      setStepping(null);
      setStepComment('');
      await Promise.all([afterSave(`Задача #${r.number}: «${ACTION_LABEL[v.action]}» → ${r.status.value}`), qc.invalidateQueries({ queryKey: tkeys.comments(id) })]);
    },
    onError,
  });
  const runStep = (a: ProcessAction) => {
    if (t && actionNeedsComment(statuses.data?.items ?? [], t, a)) {
      setStepping(a);
      setStepComment('');
    } else {
      step.mutate({ action: a });
    }
  };
  const replaceReviewer = useMutation({
    mutationFn: (v: { reviewerId: string; comment: string }) => tasksApi.replaceReviewer(id, t?.version ?? 0, v.reviewerId, v.comment.trim() || undefined),
    onSuccess: async (r) => {
      setSwap(null);
      await Promise.all([afterSave(`Задача #${r.number}: проверяет ${r.reviewer?.fullName ?? '—'}`), qc.invalidateQueries({ queryKey: tkeys.comments(id) })]);
    },
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
    save.mutate(statusNeedsComment ? { ...patch, comment: moveComment } : patch);
  };
  const readOnly = !!t?.archived;
  const people0 = people.data?.items ?? [];
  const statusNeedsComment = !!t && !!draft && draft.statusId !== t.status.id && needsComment(statuses.data?.items ?? [], t.status.id, draft.statusId);
  // Без «Задачи: постановка другим»: себя — на задачу без исполнителя, снять себя — пока задача в «Поставленные».
  const mine = !!t?.assignee && t.assignee.id === me?.id;
  const assigneeLocked = !canAssign && !!t?.assignee && !(mine && t.status.systemKey === 'assigned');
  const assigneeOptions = canAssign ? people0 : people0.filter((p) => p.id === me?.id);
  const hint = t && me ? processHint(t, me.id, perms) : null;
  const canSwap = canOverride && !readOnly && t?.status.systemKey === 'review';
  const swapOptions = people0.filter((p) => p.id !== t?.assignee?.id && p.id !== t?.reviewer?.id);

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
                {canOverride
                  ? (
                    <label>Статус
                      <select className="inp" value={draft.statusId} disabled={readOnly} onChange={(e) => setDraft({ ...draft, statusId: e.target.value })}>
                        {statuses.data?.items.map((s) => <option key={s.id} value={s.id}>{s.value}</option>)}
                        {!statuses.data?.items.some((s) => s.id === t.status.id) && <option value={t.status.id}>{t.status.value}</option>}
                      </select>
                    </label>
                  )
                  : <div className="field-ro"><span>Статус</span><b data-testid="task-status">{t.status.value}</b></div>}
                <label>Ответственный
                  <select className="inp" value={draft.assigneeId} disabled={readOnly || assigneeLocked} onChange={(e) => setDraft({ ...draft, assigneeId: e.target.value })}
                    title={assigneeLocked ? (mine ? 'Снять себя можно, пока задача не взята в работу' : 'Исполнителя меняет пользователь с правом «Задачи: постановка другим»') : undefined}>
                    <option value="">— не назначен</option>
                    {t.assignee && !assigneeOptions.some((p) => p.id === t.assignee?.id) && <option value={t.assignee.id}>{t.assignee.fullName}</option>}
                    {assigneeOptions.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
                  </select>
                </label>
                {t.reviewer && <div className="field-ro"><span>Проверяет</span><b data-testid="task-reviewer">{t.reviewer.fullName}</b></div>}
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
              {statusNeedsComment && !readOnly && (
                <label>Комментарий к переходу
                  <textarea className="inp" required maxLength={4000} value={moveComment} onChange={(e) => setMoveComment(e.target.value)}
                    placeholder="Для этой колонки комментарий обязателен" />
                </label>
              )}
              {!readOnly && (
                <div className="row">
                  <button className="btn primary" type="submit" disabled={save.isPending || conflict || (statusNeedsComment && !moveComment.trim())}>Сохранить</button>
                </div>
              )}
            </form>
          )}

          {t && !readOnly && (t.actions.length > 0 || hint) && (
            <div className="process" aria-label="Шаг процесса">
              <div className="eyebrow">Шаг процесса · {t.status.value}</div>
              {!stepping && (
                <div className="row">
                  {t.actions.map((a) => (
                    <button key={a} className={`btn sm${a === 'return' ? '' : ' primary'}`} type="button" disabled={step.isPending || conflict} onClick={() => runStep(a)}>
                      {ACTION_LABEL[a]}
                    </button>
                  ))}
                </div>
              )}
              {stepping && (
                <form className="grid-gap" onSubmit={(e) => { e.preventDefault(); step.mutate({ action: stepping, comment: stepComment }); }}>
                  <textarea className="inp" required maxLength={4000} autoFocus aria-label="Комментарий к шагу" value={stepComment} onChange={(e) => setStepComment(e.target.value)}
                    placeholder={stepping === 'submit' || stepping === 'complete' ? 'Что сделано, где результат' : stepping === 'return' ? 'Что доделать' : 'Комментарий: что проверено'} />
                  <div className="row">
                    <button className="btn sm primary" type="submit" disabled={step.isPending || !stepComment.trim()}>{ACTION_LABEL[stepping]}</button>
                    <button className="btn sm" type="button" onClick={() => setStepping(null)}>Отмена</button>
                  </div>
                </form>
              )}
              {hint && <div className="hint">{hint}</div>}
            </div>
          )}

          {canSwap && t && (
            <div className="process" aria-label="Проверяющий">
              <div className="eyebrow">Проверяющий · {t.reviewer?.fullName ?? 'не назначен (правила до 1.4.0)'}</div>
              {!swap && (
                <div className="row">
                  <button className="btn sm" type="button" disabled={conflict} onClick={() => setSwap({ reviewerId: '', comment: '' })}>Заменить проверяющего</button>
                </div>
              )}
              {swap && (
                <form className="grid-gap" onSubmit={(e) => { e.preventDefault(); replaceReviewer.mutate(swap); }}>
                  <select className="inp" required aria-label="Новый проверяющий" value={swap.reviewerId} onChange={(e) => setSwap({ ...swap, reviewerId: e.target.value })}>
                    <option value="">— выберите сотрудника</option>
                    {swapOptions.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
                  </select>
                  <textarea className="inp" maxLength={4000} aria-label="Комментарий к замене" value={swap.comment}
                    onChange={(e) => setSwap({ ...swap, comment: e.target.value })} placeholder="Почему меняете (по желанию)" />
                  <div className="row">
                    <button className="btn sm primary" type="submit" disabled={replaceReviewer.isPending || !swap.reviewerId}>Заменить</button>
                    <button className="btn sm" type="button" onClick={() => setSwap(null)}>Отмена</button>
                  </div>
                </form>
              )}
            </div>
          )}

          {t?.record && (
            <div className="mailbox">
              <div className="eyebrow">Запись реестра</div>
              <div>
                {/* Реестр или запись удалены (1.6.1): задача остаётся, ссылки нет — открыть можно только из корзины. */}
                {t.record.registerDeleted || t.record.recordDeleted
                  ? <span>{t.record.registerName}, запись #{t.record.number}{t.record.title ? ` «${t.record.title}»` : ''} <span className="chip">{t.record.registerDeleted ? 'реестр удалён' : 'запись удалена'}</span></span>
                  : <Link to={`/registers#${t.record.registerId}/records`}>{t.record.registerName}, запись #{t.record.number}{t.record.title ? ` «${t.record.title}»` : ''}</Link>}
              </div>
              {t.recipientLabel && <div className="hint">Получатели по правилу: {t.recipientLabel}</div>}
            </div>
          )}
          {t?.document && (
            <div className="mailbox">
              <div className="eyebrow">Документ</div>
              <div>
                <Link to={`/documents?doc=${t.document.id}`}>Документ #{t.document.number}</Link>
                {' · '}{DOC_REASON[t.document.reason].label}
              </div>
              <div className="hint">{DOC_REASON[t.document.reason].hint}</div>
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
                  <div className="who">
                    {c.author?.fullName ?? (c.automatic ? 'Автоматизация' : 'Система')} · {formatDateTime(c.createdAt)}
                    {c.transition && <span className="chip tr-chip">{c.transition.from ? `${c.transition.from} → ` : ''}{c.transition.to}{c.transition.reviewer ? ` → ${c.transition.reviewer}` : ''}</span>}
                  </div>
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
