// Карточка учебного письма (1.9.0, ADR-0039; docs/specs/awareness.md, разделы 13–14): редактор RU/TJ, сохранение
// с version (409 — перечитать), «Утверждение будет снято», согласование, «Отметить отправленным», копия, архив,
// версии и сравнение, события. Кнопки — по `actions` из ответа backend; решает всё равно backend.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { useMe } from '../../auth/useMe';
import { awarenessApi, awarenessKeys, type ExportLang, type Letter, type LetterKind } from '../../api/awareness';
import { DetailPanel } from '../../components/DetailPanel';
import { useToast } from '../../components/Toast';
import { ConfirmDialog, type ConfirmAsk } from '../settings/ConfirmDialog';
import { todayLocal } from '../tasks/logic';
import { BilingualFields, EMPTY_TEXTS, sameTexts, textsOf, type Texts } from './editor';
import { FormDialog } from './FormDialog';
import { EVENT_NAME, KIND_NAME, letterMarks, ru, ruDateTime, STATUS_NAME, STATUS_TONE, withoutApprovalComment } from './logic';
import { LetterVersions } from './LetterVersions';
import { LetterExport } from './LetterExport';
import { MailPreview } from './MailPreview';
import { Select } from '../../components/Select';

interface Draft {
  title: string;
  kind: LetterKind;
  reason: string;
  texts: Texts;
}

const draftOf = (l: Letter): Draft => ({ title: l.title, kind: l.kind, reason: l.reason, texts: textsOf(l.content) });
const sameDraft = (a: Draft, b: Draft) => a.title === b.title && a.kind === b.kind && a.reason === b.reason && sameTexts(a.texts, b.texts);

type Tab = 'letter' | 'versions' | 'events' | 'export';
type Dialog = null | 'return' | 'send' | 'send_without_approval' | 'resend';

/** Форма «Отметить отправленным» (1.12.0): языки, получатели, файл письма — выгрузка ('' — последняя или собрать). */
interface SendForm { comment: string; sentOn: string; audience: string; langs: ExportLang | ''; recipients: string; exportId: string }
const EMPTY_FORM: SendForm = { comment: '', sentOn: todayLocal(), audience: '', langs: '', recipients: '', exportId: '' };
const LANGS_NAME: Record<ExportLang, string> = { both: 'RU+TJ', ru: 'RU', tj: 'TJ' };

export function LetterPanel({ id, onClose, onOpen }: { id: string; onClose: () => void; onOpen: (id: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const me = useMe().data;
  const canDelete = !!me?.permissions.includes('awareness.delete');
  const q = useQuery({ queryKey: awarenessKeys.letter(id), queryFn: () => awarenessApi.letter(id) });
  const sig = useQuery({ queryKey: awarenessKeys.signature, queryFn: awarenessApi.signature, staleTime: 60_000 });
  const layout = useQuery({ queryKey: awarenessKeys.layout, queryFn: awarenessApi.layout, staleTime: 60_000 });
  const l = q.data;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [resetKey, setResetKey] = useState('');
  const [conflict, setConflict] = useState(false);
  const [tab, setTab] = useState<Tab>('letter');
  const [ask, setAsk] = useState<ConfirmAsk | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [form, setForm] = useState<SendForm>(EMPTY_FORM);
  const [preview, setPreview] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  // Письмо загрузилось или его перечитали — черновик формы из ответа, редактор — с этим содержимым.
  const reset = (letter: Letter) => {
    setDraft(draftOf(letter));
    setResetKey(`${letter.id}:${letter.version}:${Date.now()}`);
    setConflict(false);
  };
  useEffect(() => {
    if (l && !draft) reset(l);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [l]);

  const editable = !!l && l.actions.includes('save') && !conflict;
  const dirty = !!l && !!draft && !sameDraft(draft, draftOf(l));
  const signature = sig.data ?? { htmlRu: '', htmlTj: '' };
  const limits = l?.size.limits ?? { maxImageKb: 1024, maxLetterKb: 2048, warnLetterKb: 1024 };
  const warn = (text: string) => toast(text, 'warn');

  const afterChange = async (next: Letter, text: string | null, warnings: readonly string[] = []) => {
    qc.setQueryData(awarenessKeys.letter(id), next);
    await qc.invalidateQueries({ queryKey: awarenessKeys.letters });
    await qc.invalidateQueries({ queryKey: ['tasks'] });
    if (warnings.length) warnings.forEach((w) => toast(w, 'warn'));
    else if (text) toast(text);
  };
  const onError = (err: unknown, retryWithConfirm?: () => void) => {
    if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') {
      setConflict(true);
      return;
    }
    if (err instanceof ApiError && err.code === 'APPROVAL_DROP_CONFIRM' && retryWithConfirm) {
      setAsk({ title: 'Снять утверждение?', text: 'Письмо утверждено. Если изменить его, утверждение будет снято и письмо вернётся в черновик — его нужно будет снова отправить на согласование.', confirm: 'Изменить и снять утверждение', run: retryWithConfirm });
      return;
    }
    toast(err instanceof Error ? err.message : 'Не удалось выполнить действие', 'error');
  };

  const save = useMutation({
    mutationFn: (confirmDropApproval: boolean) => {
      if (!l || !draft) throw new Error('Письмо не загружено');
      return awarenessApi.saveLetter(id, { version: l.version, title: draft.title, kind: draft.kind, reason: draft.reason, ...draft.texts, confirmDropApproval });
    },
    onSuccess: async (r) => {
      setAsk(null);
      // Санитайзер мог изменить текст (вырезал лишнее) — редактор показывает сохранённое.
      if (!draft || !sameTexts(draft.texts, textsOf(r.letter.content))) reset(r.letter);
      else setDraft(draftOf(r.letter));
      await afterChange(r.letter, r.versionCreated ? `Сохранено, версия ${r.letter.versionNo}` : 'Сохранено', r.warnings);
    },
    onError: (err) => onError(err, () => save.mutate(true)),
  });

  const act = useMutation({
    mutationFn: async (a: { run: (version: number) => Promise<Letter & { warnings?: string[] }>; done: string }) => {
      if (!l) throw new Error('Письмо не загружено');
      return { next: await a.run(l.version), done: a.done };
    },
    onSuccess: async ({ next, done }) => {
      setAsk(null);
      setDialog(null);
      reset(next);
      await afterChange(next, done, next.warnings ?? []);
    },
    onError: (err) => {
      if (dialog && err instanceof ApiError && err.code !== 'VERSION_CONFLICT') {
        setDialogError(err.message);
        return;
      }
      setDialog(null);
      onError(err);
    },
  });

  const restore = (no: number, confirm = false) => act.mutate({
    run: (v) => awarenessApi.restore(id, no, v, confirm),
    done: `Восстановлена версия ${no}`,
  });
  const restoreAsk = (no: number) => {
    if (l?.status === 'approved') {
      setAsk({ title: `Восстановить версию ${no}?`, text: 'Письмо утверждено: восстановление создаст новую версию, утверждение будет снято.', confirm: 'Восстановить и снять утверждение', run: () => restore(no, true) });
    } else restore(no);
  };

  const copy = useMutation({
    mutationFn: () => awarenessApi.copy(id),
    onSuccess: async (c) => {
      await qc.invalidateQueries({ queryKey: awarenessKeys.letters });
      toast(`Создана копия — письмо № ${c.number}`);
      onOpen(c.id);
    },
    onError: (err) => onError(err),
  });

  // Удаление (1.13.3): после ответа — панель закрывается, письма нет в списках.
  const remove = useMutation({
    mutationFn: async () => {
      if (!l) throw new Error('Письмо не загружено');
      return awarenessApi.remove(id, l.version);
    },
    onSuccess: async (r) => {
      setAsk(null);
      qc.removeQueries({ queryKey: awarenessKeys.letter(id) });
      await qc.invalidateQueries({ queryKey: awarenessKeys.letters });
      await qc.invalidateQueries({ queryKey: ['tasks'] });
      toast(`Письмо № ${r.number} удалено`);
      onClose();
    },
    onError: (err) => { setAsk(null); onError(err); },
  });

  const reload = async () => {
    const fresh = await qc.fetchQuery({ queryKey: awarenessKeys.letter(id), queryFn: () => awarenessApi.letter(id) });
    reset(fresh);
  };

  const close = () => {
    if (dirty) setAsk({ title: 'Закрыть без сохранения?', text: 'Изменения в письме не сохранены.', confirm: 'Закрыть', run: onClose });
    else onClose();
  };

  const openDialog = (d: Exclude<Dialog, null>) => {
    setForm({ ...EMPTY_FORM, sentOn: todayLocal() });
    setDialogError(null);
    setDialog(d);
  };

  const exportsQ = useQuery({
    queryKey: awarenessKeys.exports(id),
    queryFn: () => awarenessApi.exports(id),
    enabled: dialog === 'send' || dialog === 'send_without_approval' || dialog === 'resend',
  });
  // Значения по умолчанию, когда выгрузки загрузились: языки последней выгрузки текущей версии, получатели прошлой отметки.
  const versionExports = (exportsQ.data?.items ?? []).filter((e) => e.versionNo === l?.versionNo);
  const formLangs: ExportLang = form.langs || (versionExports[0]?.langs && l?.exportLangs.includes(versionExports[0].langs) ? versionExports[0].langs
    : l?.exportLangs.includes('both') ? 'both' : l?.exportLangs[0] ?? 'ru');
  const langExports = versionExports.filter((e) => e.langs === formLangs);
  useEffect(() => {
    if (exportsQ.data && !form.recipients) setForm((f) => (f.recipients ? f : { ...f, recipients: exportsQ.data.lastRecipients }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exportsQ.data]);

  const audiences = useQuery({
    queryKey: ['awareness', 'audiences', form.audience],
    queryFn: () => awarenessApi.audiences(form.audience),
    enabled: dialog === 'send' || dialog === 'send_without_approval' || dialog === 'resend',
    staleTime: 30_000,
  });

  const marks = useMemo(() => (l ? letterMarks(l) : []), [l]);
  const has = (a: Letter['actions'][number]) => !!l?.actions.includes(a);
  const busy = save.isPending || act.isPending || copy.isPending || remove.isPending;
  const needSave = dirty ? 'Сначала сохраните изменения' : undefined;

  const footer = l && (
    <>
      {editable && dirty && <button className="btn primary" type="button" disabled={busy} onClick={() => save.mutate(false)}>Сохранить</button>}
      {has('submit') && (
        <button className="btn" type="button" disabled={busy || dirty} title={needSave}
          onClick={() => act.mutate({ run: (v) => awarenessApi.submit(id, v), done: 'Отправлено на согласование' })}>На согласование</button>
      )}
      {has('withdraw') && <button className="btn" type="button" disabled={busy} onClick={() => act.mutate({ run: (v) => awarenessApi.withdraw(id, v), done: 'Письмо отозвано — снова черновик' })}>Отозвать</button>}
      {has('approve') && <button className="btn primary" type="button" disabled={busy} onClick={() => act.mutate({ run: (v) => awarenessApi.approve(id, v), done: 'Письмо утверждено' })}>Утвердить</button>}
      {has('return') && <button className="btn" type="button" disabled={busy} onClick={() => openDialog('return')}>Вернуть на доработку</button>}
      {has('send') && <button className="btn primary" type="button" disabled={busy || dirty} title={needSave} onClick={() => openDialog('send')}>Отметить отправленным</button>}
      {has('send_without_approval') && (
        <button className="btn" type="button" disabled={busy || dirty} title={needSave ?? 'Срочное письмо можно отметить без согласования — с причиной'}
          onClick={() => openDialog('send_without_approval')}>Отправлено без согласования</button>
      )}
      {has('resend') && <button className="btn" type="button" disabled={busy} onClick={() => openDialog('resend')}>Отметить отправленным ещё раз</button>}
      <span className="grow" />
      {has('copy') && <button className="btn ghost" type="button" disabled={busy} onClick={() => copy.mutate()}>Создать копию</button>}
      {has('archive') && <button className="btn ghost" type="button" disabled={busy} onClick={() => act.mutate({ run: (v) => awarenessApi.archive(id, v, true), done: 'Письмо в архиве' })}>В архив</button>}
      {has('unarchive') && <button className="btn ghost" type="button" disabled={busy} onClick={() => act.mutate({ run: (v) => awarenessApi.archive(id, v, false), done: 'Письмо возвращено из архива' })}>Из архива</button>}
      {l?.deletable && canDelete && (
        <button className="btn ghost danger-t" type="button" disabled={busy} data-testid="letter-delete"
          onClick={() => setAsk({
            title: `Удалить письмо № ${l.number}?`,
            text: `«${l.title}» исчезнет из списков и поиска. Письмо ни разу не отмечено отправленным, поэтому его можно удалить; версии сохранятся в базе, действие попадёт в журнал. Задача рассылки, если она есть, останется — с пометкой «письмо удалено».`,
            confirm: 'Удалить', run: () => remove.mutate(),
          })}>Удалить</button>
      )}
    </>
  );

  const stateNote = l && (
    l.archived ? 'Письмо в архиве. Верните его из архива, чтобы продолжить.'
      : l.frozen ? 'Письмо отправлено — его нельзя изменить. Создайте копию, чтобы сделать новое на его основе.'
        : l.status === 'review' ? 'Письмо на согласовании. Чтобы изменить его, отзовите письмо.'
          : l.status === 'approved' ? 'Письмо утверждено. Если изменить текст, тип или повод, утверждение будет снято.'
            : null
  );

  const sendDialog = dialog === 'send' || dialog === 'send_without_approval' || dialog === 'resend';
  const sendComment = dialog === 'send_without_approval' ? withoutApprovalComment(form.comment) : form.comment.trim();
  const sendTitle = dialog === 'send_without_approval' ? 'Отправлено без согласования' : dialog === 'resend' ? 'Отметить отправленным ещё раз' : 'Отметить отправленным';

  return (
    <DetailPanel label="Учебное письмо" variant="sheet" wide onClose={close} scrollKey={id} testId="letter-panel"
      eyebrow={l ? <>Письмо № {l.number} · {KIND_NAME[l.kind]}{l.versionNo ? ` · версия ${l.versionNo}` : ''}</> : 'Письмо'}
      title={draft?.title || l?.title || 'Загрузка…'}
      badges={l && <>
        <span className={`chip ${STATUS_TONE[l.status]}`} data-testid="letter-status">{STATUS_NAME[l.status]}</span>
        {marks.map((m) => <span key={m} className="chip high" data-testid="letter-mark">{m}</span>)}
        {l.archived && <span className="chip">В архиве</span>}
      </>}
      footer={footer}>
      {q.isError && <div className="form-error">{q.error.message}</div>}
      {conflict && (
        <div className="note conflict" role="alert">
          Письмо изменил другой пользователь — ваши изменения не сохранены.
          <div className="row mt6"><button className="btn sm primary" type="button" onClick={() => void reload()}>Перечитать письмо</button></div>
        </div>
      )}
      {l && draft && (
        <>
          <div className="filters aw-tabs" role="tablist" aria-label="Разделы письма">
            {([['letter', 'Письмо'], ['versions', `Версии ${l.versions.length}`], ['events', `События ${l.events.length}`], ['export', 'Экспорт']] as const).map(([k, t]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} aria-pressed={tab === k} onClick={() => setTab(k)}>{t}</button>
            ))}
          </div>

          {tab === 'letter' && (
            <div className="aw-letter">
              {stateNote && <div className="note ro" role="status">{stateNote}</div>}
              <div className="fgrid">
                <label>Название (для списков, в письмо не входит)
                  <input className="inp" maxLength={200} required value={draft.title} disabled={!editable} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
                </label>
                <label>Тип
                  <Select className="inp" value={draft.kind} disabled={!editable} onChange={(e) => setDraft({ ...draft, kind: e.target.value as LetterKind })}>
                    <option value="planned">Плановое</option>
                    <option value="urgent">Срочное</option>
                  </Select>
                </label>
              </div>
              {(draft.kind === 'urgent' || draft.reason) && (
                <label>Повод{draft.kind === 'urgent' ? ' (обязательно для срочного)' : ''}
                  <textarea className="inp" rows={2} maxLength={1000} value={draft.reason} disabled={!editable}
                    placeholder="Инцидент, новая схема мошенничества, предупреждение регулятора" onChange={(e) => setDraft({ ...draft, reason: e.target.value })} />
                </label>
              )}
              {(l.template || l.task) && (
                <div className="row hint gap6">
                  {l.template && <span>Из шаблона «{l.template.title}»</span>}
                  {l.task && <Link to={`/tasks?task=${l.task.id}`}>Задача #{l.task.number}</Link>}
                </div>
              )}
              <BilingualFields value={draft.texts ?? EMPTY_TEXTS} resetKey={resetKey} readOnly={!editable} signature={signature} limits={limits}
                defaultLabels={layout.data ? (draft.kind === 'urgent' ? { ru: layout.data.labelUrgentRu, tj: layout.data.labelUrgentTj } : { ru: layout.data.labelPlannedRu, tj: layout.data.labelPlannedTj }) : undefined}
                onWarning={warn} onChange={(texts) => setDraft((d) => (d ? { ...d, texts } : d))} />
              <div className="row mt6">
                <button className="btn" type="button" aria-expanded={preview} onClick={() => setPreview((x) => !x)}>
                  {preview ? 'Скрыть предпросмотр' : 'Предпросмотр как в почте'}
                </button>
              </div>
              {preview && (
                <MailPreview
                  langs={(['both', 'ru', 'tj'] as const).filter((x) => {
                    const ru = !!(draft.texts.subjectRu.trim() || draft.texts.htmlRu.replace(/<[^>]+>/g, '').trim());
                    const tj = !!(draft.texts.subjectTj.trim() || draft.texts.htmlTj.replace(/<[^>]+>/g, '').trim());
                    return x === 'both' ? ru && tj : x === 'ru' ? ru : tj;
                  })}
                  reloadKey={JSON.stringify(draft.texts) + draft.kind}
                  load={async (lang) => {
                    const r = await awarenessApi.mailPreview({ ...draft.texts, kind: draft.kind, lang });
                    return { subject: r.subject, src: `/api/v1/awareness/mail-preview/${r.token}`, warnings: r.warnings };
                  }}
                />
              )}
            </div>
          )}

          {tab === 'versions' && <LetterVersions letter={l} signature={signature} busy={busy || dirty} onRestore={restoreAsk} />}

          {tab === 'export' && <LetterExport letter={l} dirty={dirty} />}

          {tab === 'events' && (
            <ol className="aw-events" data-testid="letter-events">
              {l.events.length === 0 && <li className="hint">Событий пока нет: письмо не отправляли на согласование</li>}
              {l.events.map((e) => (
                <li key={e.id}>
                  <div className="row gap6"><b>{EVENT_NAME[e.action]}</b>{e.versionNo && <span className="mono hint">версия {e.versionNo}</span>}
                    {e.selfApproved && <span className="chip high">без независимого согласования</span>}
                    {e.withoutApproval && <span className="chip high">без согласования</span>}
                  </div>
                  <div className="hint">{e.actor.fullName} · {ruDateTime(e.at)}</div>
                  {e.sentOn && <div>Отправлено {ru(e.sentOn)} · {e.audience}{e.langs && ` · ${LANGS_NAME[e.langs]}`}{e.record && <> · <Link to={`/registers?record=${e.record.id}#${e.record.registerId}/records`}>«Рассылки» #{e.record.number}</Link></>}</div>}
                  {e.recipients && <div className="hint">Получатели: {e.recipients}</div>}
                  {e.file && <div className="hint">Файл письма: <a href={`/api/v1/files/${e.file.id}/content`} download>{e.file.name}</a> <span className="mono" title={e.file.sha256}>sha256 {e.file.sha256.slice(0, 12)}…</span></div>}
                  {e.task && <div><Link to={`/tasks?task=${e.task.id}`}>Задача #{e.task.number}</Link></div>}
                  {e.comment && <div className="aw-comment">{e.comment}</div>}
                </li>
              ))}
            </ol>
          )}
        </>
      )}

      {ask && <ConfirmDialog ask={ask} busy={busy} onClose={() => setAsk(null)} />}

      {dialog === 'return' && (
        <FormDialog title="Вернуть на доработку" submit="Вернуть" busy={act.isPending} disabled={!form.comment.trim()} error={dialogError} testId="return-dialog"
          onClose={() => setDialog(null)}
          onSubmit={() => act.mutate({ run: (v) => awarenessApi.returnLetter(id, v, form.comment.trim()), done: 'Письмо возвращено на доработку' })}>
          <label>Что доработать
            <textarea className="inp" rows={4} required autoFocus maxLength={2000} value={form.comment} onChange={(e) => setForm({ ...form, comment: e.target.value })} />
          </label>
          <p className="hint">Письмо вернётся в черновик, автору будет поставлена задача «Доработать письмо».</p>
        </FormDialog>
      )}

      {sendDialog && l && (
        <FormDialog title={sendTitle} submit="Отметить" busy={act.isPending} error={dialogError} testId="send-dialog"
          disabled={!form.audience.trim() || !form.sentOn || (dialog === 'send_without_approval' && !sendComment)}
          onClose={() => setDialog(null)}
          onSubmit={() => act.mutate({
            run: (v) => awarenessApi.send(id, {
              version: v, sentOn: form.sentOn, audience: form.audience.trim(), langs: formLangs, recipients: form.recipients.trim(),
              ...(form.exportId ? { exportId: form.exportId } : {}), ...(sendComment ? { comment: sendComment } : {}),
            }),
            done: dialog === 'resend' ? 'Отправка отмечена ещё раз' : 'Письмо отмечено отправленным',
          })}>
          {dialog === 'resend'
            ? <p className="hint">Текст письма не меняется: добавится новая отметка и запись в «Рассылках».</p>
            : <p className="hint">Письмо будет заморожено: править его будет нельзя, только создать копию. Добавится запись в «Рассылках».</p>}
          <div className="fgrid">
            <label>Дата отправки
              <input className="inp" type="date" required max={todayLocal()} value={form.sentOn} onChange={(e) => setForm({ ...form, sentOn: e.target.value })} />
            </label>
            <label>Аудитория
              <input className="inp" required autoFocus list="aw-audiences" maxLength={500} placeholder="Все сотрудники или подразделения через запятую"
                value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value })} />
              <datalist id="aw-audiences">
                {audiences.data?.items.map((a) => <option key={a.value} value={a.value} />)}
              </datalist>
            </label>
          </div>
          <div className="fgrid">
            <label>Языки
              <Select className="inp" value={formLangs} onChange={(e) => setForm({ ...form, langs: e.target.value as ExportLang, exportId: '' })}>
                {l.exportLangs.map((x) => <option key={x} value={x}>{LANGS_NAME[x]}</option>)}
              </Select>
            </label>
            <label>Получатели
              <input className="inp" maxLength={500} placeholder="Например, адрес общей рассылки" value={form.recipients}
                onChange={(e) => setForm({ ...form, recipients: e.target.value })} />
            </label>
          </div>
          <label>Файл письма
            <Select className="inp" value={form.exportId} onChange={(e) => setForm({ ...form, exportId: e.target.value })} data-testid="send-file">
              <option value="">{langExports[0] ? `Последняя выгрузка: ${langExports[0].fileName}` : 'Выгрузки с этими языками нет — собрать при отметке'}</option>
              {langExports.slice(1).map((x) => <option key={x.id} value={x.id}>{x.fileName} · {ruDateTime(x.createdAt)}</option>)}
            </Select>
            <span className="hint">Файл .eml, который отправили, сохраняется в записи «Рассылок» как доказательство.</span>
          </label>
          {dialog === 'send_without_approval' && (
            <label>Причина отправки без согласования
              <textarea className="inp" rows={3} required maxLength={1900} value={form.comment} placeholder="Например: атака идёт сейчас, начальник ИБ недоступен"
                onChange={(e) => setForm({ ...form, comment: e.target.value })} />
              <span className="hint">В карточке и журнале: «{withoutApprovalComment(form.comment) || 'Отправлено без согласования: …'}»</span>
            </label>
          )}
        </FormDialog>
      )}
    </DetailPanel>
  );
}
