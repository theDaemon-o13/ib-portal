import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { docsApi, dkeys, type DocAction, type DocDetail, type DocResult } from '../../api/documents';
import type { FileInfo } from '../../api/files';
import { settingsApi } from '../../api/settings';
import { FilePreview } from '../../components/files/FilePreview';
import { FileUpload } from '../../components/files/FileUpload';
import { LockIcon } from '../../components/LockIcon';
import { useToast } from '../../components/Toast';
import { formatDate } from '../registers/logic';
import { formatDateTime } from '../settings/logic';
import { todayLocal as todayIso } from '../tasks/logic';
import { DocumentBlockers, DocumentParties, DocumentTranslations } from './DocumentParties';
import { ACTION_DONE, ACTION_LABEL, FIXED_FILE_LABEL, historyText, reviewLabel, SELF_APPROVED, STATUS_TONE, versionLabel } from './logic';

/** Ошибки, после которых карточку нужно перечитать: документ успели изменить или он ушёл на другой этап. */
const STALE = new Set(['VERSION_CONFLICT', 'STAGE_CHANGED', 'NOT_IN_ROUTE', 'WRONG_STAGE']);

type Mode = 'view' | DocAction | 'sign' | 'cancel' | 'delete' | 'files' | 'edit' | 'revise' | 'settings';

/** Начало sha256 — какой именно файл зафиксирован. */
const shaShort = (sha: string) => `${sha.slice(0, 12)}…`;

interface ContentDraft {
  title: string;
  edition: string;
  onlyofficeUrl: string;
  changeNote: string;
}

const contentOf = (v: DocDetail['current']): ContentDraft => ({ title: v.title, edition: v.edition, onlyofficeUrl: v.onlyofficeUrl, changeNote: v.changeNote });

function ContentFields({ draft, setDraft, noteLabel }: { draft: ContentDraft; setDraft: (d: ContentDraft) => void; noteLabel: string }) {
  return (
    <>
      <label>Название<input className="inp" required maxLength={300} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>
      <div className="fgrid">
        <label>Редакция<input className="inp" maxLength={20} placeholder="например, 3.1" value={draft.edition} onChange={(e) => setDraft({ ...draft, edition: e.target.value })} /></label>
        <label>Ссылка на файл в OnlyOffice<input className="inp" type="url" required maxLength={2000} placeholder="https://" value={draft.onlyofficeUrl} onChange={(e) => setDraft({ ...draft, onlyofficeUrl: e.target.value })} /></label>
      </div>
      <label>{noteLabel}<textarea className="inp" maxLength={4000} value={draft.changeNote} onChange={(e) => setDraft({ ...draft, changeNote: e.target.value })} /></label>
    </>
  );
}

export function DocumentPanel({ id, onGone }: { id: string; onGone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const doc = useQuery({ queryKey: dkeys.detail(id), queryFn: () => docsApi.get(id), retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2 });
  const [mode, setMode] = useState<Mode>('view');
  const [comment, setComment] = useState('');
  const [note, setNote] = useState('');
  const [content, setContent] = useState<ContentDraft | null>(null);
  const [settings, setSettings] = useState<{ typeId: string; ownerId: string; reviewMonths: number } | null>(null);
  const [stale, setStale] = useState<string | null>(null);
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [signedOn, setSignedOn] = useState(todayIso());
  const [shown, setShown] = useState<{ id: string; name: string; mime: string; size: number } | null>(null);
  const d = doc.data;

  const types = useQuery({ queryKey: dkeys.types, queryFn: () => settingsApi.items('document_types', false), enabled: mode === 'settings' });
  const people = useQuery({ queryKey: ['settings', 'userOptions'], queryFn: settingsApi.userOptions, enabled: mode === 'settings' });

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: dkeys.all }), qc.invalidateQueries({ queryKey: ['tasks'] })]);
  const done = async (r: DocResult, text: string) => {
    setMode('view');
    setComment('');
    setFiles([]);
    await refresh();
    toast(text);
    // Документ вам больше не виден (удалён или ушёл с этапа, где вы его видели) — снять выбор.
    if (!r.document) onGone();
  };
  const onError = (e: unknown) => {
    if (e instanceof ApiError && STALE.has(e.code)) {
      setStale(e.message);
      return;
    }
    toast(e instanceof Error ? e.message : 'Не удалось выполнить действие', 'error');
  };
  const reload = async () => {
    setStale(null);
    setMode('view');
    await refresh();
  };

  const stage = d?.working?.stage ?? 0;
  const at = { version: d?.version ?? 0, stage };
  const act = useMutation({
    mutationFn: (a: DocAction) => docsApi.action(id, a, { ...at, comment: comment.trim() || undefined, fileId: FIXED_FILE_LABEL[a] ? files[0]?.id : undefined }),
    onSuccess: (r, a) => done(r, ACTION_DONE[a]),
    onError,
  });
  const sign = useMutation({
    mutationFn: () => docsApi.sign(id, { ...at, fileId: files[0]?.id ?? '', signedOn }),
    onSuccess: (r) => done(r, 'Документ подписан: эта версия теперь действующая'),
    onError,
  });
  const cancel = useMutation({ mutationFn: () => docsApi.cancelRevision(id, { version: at.version, comment }), onSuccess: (r) => done(r, 'Пересмотр отменён: действует подписанная версия'), onError });
  const remove = useMutation({ mutationFn: () => docsApi.remove(id, { version: at.version, comment: comment.trim() || undefined }), onSuccess: (r) => done(r, 'Документ удалён'), onError });
  const addFiles = useMutation({ mutationFn: () => docsApi.addFiles(id, { ...at, fileIds: files.map((f) => f.id) }), onSuccess: (r) => done(r, 'Файлы приложены'), onError });
  const removeFile = useMutation({ mutationFn: (linkId: string) => docsApi.removeFile(id, linkId, at), onSuccess: (r) => done(r, 'Файл снят'), onError });
  const say = useMutation({
    mutationFn: () => docsApi.comment(id, note),
    onSuccess: async () => { setNote(''); await refresh(); toast('Комментарий добавлен'); },
    onError,
  });
  const save = useMutation({
    mutationFn: (c: ContentDraft) => docsApi.update(id, { version: at.version, ...c }),
    onSuccess: (r) => done(r, 'Драфт сохранён'),
    onError,
  });
  const revise = useMutation({
    mutationFn: (c: ContentDraft) => docsApi.revise(id, { version: at.version, ...c }),
    onSuccess: (r) => done(r, `Создана версия ${r.document?.current.no ?? ''}: она начинается с этапа «Драфт»`),
    onError,
  });
  const saveSettings = useMutation({
    mutationFn: (s: { typeId: string; ownerId: string; reviewMonths: number }) => docsApi.update(id, { version: at.version, ...s }),
    onSuccess: (r) => done(r, 'Документ сохранён'),
    onError,
  });
  const archive = useMutation({
    mutationFn: () => (d?.archived ? docsApi.restore(id, at.version) : docsApi.archive(id, at.version)),
    onSuccess: (r) => done(r, r.document?.archived ? 'Документ в архиве' : 'Документ возвращён из архива'),
    onError,
  });
  const busy = [act, sign, cancel, remove, addFiles, removeFile, say, save, revise, saveSettings, archive].some((m) => m.isPending);

  if (doc.isError) {
    return <div className="panel-b form-error">{doc.error instanceof ApiError && doc.error.status === 404 ? 'Документ не найден или вам не виден' : doc.error.message}</div>;
  }
  if (!d) return <div className="panel-b hint">Загрузка…</div>;

  const open = (m: Mode) => {
    setComment('');
    setFiles([]);
    setMode(m);
  };
  const startEdit = (m: 'edit' | 'revise') => {
    setContent(m === 'revise' ? { ...contentOf(d.current), changeNote: '' } : contentOf(d.current));
    setMode(m);
  };
  const onContent = (e: FormEvent) => {
    e.preventDefault();
    if (!content) return;
    if (mode === 'revise') revise.mutate(content);
    else save.mutate(content);
  };
  const toggle = (f: { id: string; name: string; mime: string; size: number }) => setShown(shown?.id === f.id ? null : f);
  const nextNo = Math.max(0, ...d.versions.map((v) => v.no)) + 1;
  const action = d.can.actions.find((a) => a === mode);
  const cancelBtn = <button className="btn" type="button" onClick={() => setMode('view')}>Отмена</button>;

  return (
    <>
      <div className="panel-h">
        <h3>{d.title}</h3>
        <span className={`chip ${STATUS_TONE[d.status]}`}>{d.statusName}</span>
      </div>
      <div className="panel-b doc-detail">
        {stale && (
          <div className="note conflict" role="alert">
            {stale}
            <div className="row mt6"><button className="btn sm primary" type="button" onClick={() => void reload()}>Обновить документ</button></div>
          </div>
        )}
        <div className="row gap-lg">
          <div><div className="eyebrow">Версия</div><div className="mono">{versionLabel(d.current)}</div></div>
          <div><div className="eyebrow">Цикл пересмотра</div><div>{d.reviewMonths} мес.</div></div>
          <div><div className="eyebrow">Владелец</div><div>{d.owner.fullName}</div></div>
          {d.signedOn && <div><div className="eyebrow">Подписан</div><div className="mono">{formatDate(d.signedOn)}</div></div>}
          <div><div className="eyebrow">Пересмотр до</div><div className={`mono${d.status === 'review_overdue' ? ' late-t' : ''}`}>{reviewLabel(d)}</div></div>
        </div>
        {d.working && d.approved && (
          <div className="hint">Действует версия {versionLabel(d.approved)} от {formatDate(d.approved.signedOn ?? d.approved.approvedAt?.slice(0, 10))}. Версия {d.working.no} — на этапе «{d.working.stageName}».</div>
        )}
        {d.archived && <div className="note ro"><LockIcon /><span>Документ в архиве: маршрут и пересмотр не ведутся.</span></div>}
        {d.approved && !d.approved.textFrozen && (
          <div className="note"><span className="chip high">текст не зафиксирован</span> Версия {d.approved.no} утверждена до появления итогового PDF: ссылка на OnlyOffice не фиксирует содержимое. Текст зафиксирует следующий пересмотр.</div>
        )}

        <div>
          <div className="eyebrow">Маршрут{d.current.round > 1 ? ` · круг ${d.current.round}` : ''}</div>
          <div className="vsteps">
            {d.route.map((r) => (
              <div key={r.stage} className="vstep" data-stage={r.stage}>
                <span className={`step${r.state === 'done' ? ' done' : r.state === 'current' ? ' cur' : ''}`} />
                <div>
                  <b>{r.name}</b>
                  {r.hint && <small>{r.hint}{r.approvers.length ? `: ${r.approvers.join(', ')}` : ''}</small>}
                  {r.skipped && <small className="skip-why">{r.skipped}</small>}
                  {r.selfApproved && <small><span className="chip high" data-testid="self-approved">{SELF_APPROVED}</span></small>}
                </div>
                <small className="vr">
                  {r.skipped ? <>не требуется<br />{formatDateTime(r.actedAt)}</> : r.actedBy
                    ? <>{r.actedBy}<br />{formatDateTime(r.actedAt)}</>
                    : r.state === 'current' && !d.archived ? <b className="wait">ожидает</b> : null}
                </small>
              </div>
            ))}
          </div>
        </div>

        {(d.files.length > 0 || d.can.draftFiles) && (
          <div className="pdf-box" aria-label="Файлы версии">
            <div className="eyebrow">Файлы версии {d.current.no}</div>
            {d.files.map((f) => (
              <div key={f.id} className="row" data-file-kind={f.kind}>
                <span className="hint">{f.kindName}{f.kind !== 'draft' && d.current.round > 1 ? `, круг ${f.round}` : ''}:</span>
                <button type="button" className="btn ghost sm" aria-pressed={shown?.id === f.file.id} onClick={() => toggle(f.file)}>{f.file.name}</button>
                <span className="hint mono" title={f.file.sha256}>sha256 {shaShort(f.file.sha256)}</span>
                {f.removable && mode === 'view' && <button type="button" className="btn ghost sm" disabled={busy} onClick={() => removeFile.mutate(f.id)}>Снять</button>}
              </div>
            ))}
            {d.files.length === 0 && <div className="hint">Файлов драфта нет. Можно приложить .docx или .pdf — по желанию.</div>}
            {d.can.draftFiles && mode === 'view' && <div className="row"><button type="button" className="btn sm" onClick={() => open('files')}>Приложить файлы драфта</button></div>}
          </div>
        )}
        {mode === 'files' && (
          <form className="task-form" aria-label="Файлы драфта" onSubmit={(e) => { e.preventDefault(); addFiles.mutate(); }}>
            <FileUpload label="Файлы драфта (docx, pdf)" accept=".docx,.pdf" allowed={['docx', 'pdf']} value={files} onChange={setFiles} required />
            <div className="row"><button className="btn primary" type="submit" disabled={busy || !files.length}>Приложить</button>{cancelBtn}</div>
          </form>
        )}

        {mode === 'view' && (
          <div className="row">
            {d.can.actions.filter((a) => a !== 'return').map((a) => (
              <button key={a} className="btn primary" type="button" disabled={busy} onClick={() => open(a)}>{ACTION_LABEL[a]}</button>
            ))}
            {d.can.sign && <button className="btn primary" type="button" disabled={busy} onClick={() => open('sign')}>Загрузить подписанный PDF</button>}
            {d.can.actions.includes('return') && <button className="btn" type="button" disabled={busy} onClick={() => open('return')}>{ACTION_LABEL.return}</button>}
            {d.can.edit && <button className="btn" type="button" disabled={busy} onClick={() => startEdit('edit')}>Изменить драфт</button>}
            {d.can.revise && <button className="btn" type="button" disabled={busy} onClick={() => startEdit('revise')}>Новая версия</button>}
            <a className="btn" href={d.current.onlyofficeUrl} target="_blank" rel="noopener noreferrer">Открыть в OnlyOffice</a>
          </div>
        )}
        {mode === 'view' && d.blockedReason && (
          <div className="note ro"><LockIcon /><span>{d.blockedReason}</span></div>
        )}
        {mode === 'view' && d.returned && (
          <div className="note conflict" data-testid="doc-returned">
            Возвращён на доработку с этапа «{d.returned.stageName}» · {d.returned.actor}, {formatDateTime(d.returned.at)}: {d.returned.comment}
          </div>
        )}

        {action && (
          <form className="task-form" aria-label={ACTION_LABEL[action]} onSubmit={(e) => { e.preventDefault(); act.mutate(action); }}>
            {FIXED_FILE_LABEL[action] && (
              <FileUpload label={FIXED_FILE_LABEL[action] ?? ''} multiple={false} accept=".docx,.pdf" allowed={['docx', 'pdf']} value={files} onChange={setFiles} required />
            )}
            <label>{action === 'return' ? 'Что нужно исправить' : 'Комментарий (необязательно)'}
              <textarea className="inp" required={action === 'return'} maxLength={4000}
                placeholder={action === 'return' ? 'Замечания для автора: они попадут в историю и в задачу автору' : ''}
                value={comment} onChange={(e) => setComment(e.target.value)} />
            </label>
            <div className="row">
              <button className="btn primary" type="submit" disabled={busy || (action === 'return' && !comment.trim()) || (!!FIXED_FILE_LABEL[action] && !files.length)}>
                {action === 'return' ? 'Вернуть автору' : ACTION_LABEL[action]}
              </button>
              {cancelBtn}
            </div>
          </form>
        )}

        {mode === 'sign' && (
          <form className="task-form" aria-label="Подписание" onSubmit={(e) => { e.preventDefault(); sign.mutate(); }}>
            <FileUpload label="Подписанный PDF" multiple={false} accept=".pdf" allowed={['pdf']} value={files} onChange={setFiles} required />
            <label>Дата подписания<input className="inp" type="date" required max={todayIso()} value={signedOn} onChange={(e) => setSignedOn(e.target.value)} /></label>
            <div className="hint">Пересмотр — через {d.reviewMonths} мес. от даты подписания.</div>
            <div className="row"><button className="btn primary" type="submit" disabled={busy || !files.length || !signedOn}>Подписан</button>{cancelBtn}</div>
          </form>
        )}

        {mode === 'view' && <DocumentBlockers d={d} at={at} onDone={done} onError={onError} />}
        {mode === 'view' && <DocumentParties d={d} at={at} onDone={done} onError={onError} onPreview={toggle} />}
        {mode === 'view' && <DocumentTranslations d={d} at={at} onDone={done} onError={onError} onPreview={toggle} />}

        {(d.comments.length > 0 || d.can.comment) && (
          <div aria-label="Комментарии сотрудников">
            <div className="eyebrow">Комментарии сотрудников</div>
            <div className="hist">
              {d.comments.map((c) => <div key={c.id} className="hist-item">{formatDateTime(c.at)} · {c.author}: {c.body}</div>)}
            </div>
            {d.can.comment && (
              <form className="task-form" onSubmit={(e) => { e.preventDefault(); say.mutate(); }}>
                <textarea className="inp" aria-label="Комментарий" maxLength={4000} placeholder="Замечание или ответ автора" value={note} onChange={(e) => setNote(e.target.value)} />
                <div className="row"><button className="btn sm" type="submit" disabled={busy || !note.trim()}>Добавить комментарий</button></div>
              </form>
            )}
          </div>
        )}

        {(mode === 'cancel' || mode === 'delete') && (
          <form className="task-form" aria-label={mode === 'cancel' ? 'Отмена пересмотра' : 'Удаление'} onSubmit={(e) => { e.preventDefault(); (mode === 'cancel' ? cancel : remove).mutate(); }}>
            <div className="note">
              {mode === 'cancel'
                ? `Версия ${d.working?.no ?? ''} уйдёт в историю как отменённая, действующей останется подписанная версия ${d.approvedVersionNo ?? ''}.`
                : 'Документ пропадёт из реестра, поиска и дашборда. Файлы и история сохранятся.'}
            </div>
            <label>{mode === 'cancel' ? 'Почему пересмотр отменяется' : 'Причина (необязательно)'}
              <textarea className="inp" required={mode === 'cancel'} maxLength={4000} value={comment} onChange={(e) => setComment(e.target.value)} />
            </label>
            <div className="row">
              <button className="btn primary" type="submit" disabled={busy || (mode === 'cancel' && !comment.trim())}>{mode === 'cancel' ? 'Отменить пересмотр' : 'Удалить документ'}</button>
              {cancelBtn}
            </div>
          </form>
        )}

        {(mode === 'edit' || mode === 'revise') && content && (
          <form className="task-form" onSubmit={onContent} aria-label={mode === 'revise' ? 'Новая версия' : 'Драфт'}>
            {mode === 'revise' && (
              <div className="hint">Версия {nextNo} пройдёт маршрут заново. Пересмотр без изменений — тоже новая версия. Версия {d.approvedVersionNo} действует, пока новую не подпишут.</div>
            )}
            <ContentFields draft={content} setDraft={setContent} noteLabel={mode === 'revise' ? 'Что изменено (необязательно)' : 'Что изменено'} />
            <div className="row">
              <button className="btn primary" type="submit" disabled={busy}>{mode === 'revise' ? `Создать версию ${nextNo}` : 'Сохранить'}</button>
              {cancelBtn}
            </div>
          </form>
        )}

        {mode === 'settings' && settings && (
          <form className="task-form" aria-label="Тип, владелец и цикл" onSubmit={(e) => { e.preventDefault(); saveSettings.mutate(settings); }}>
            <div className="fgrid">
              <label>Тип документа
                <select className="inp" value={settings.typeId} onChange={(e) => setSettings({ ...settings, typeId: e.target.value })}>
                  {!types.data?.items.some((t) => t.id === d.type.id) && <option value={d.type.id}>{d.type.value}</option>}
                  {types.data?.items.map((t) => <option key={t.id} value={t.id}>{t.value}</option>)}
                </select>
              </label>
              <label>Владелец
                <select className="inp" value={settings.ownerId} onChange={(e) => setSettings({ ...settings, ownerId: e.target.value })}>
                  {!people.data?.items.some((p) => p.id === d.owner.id) && <option value={d.owner.id}>{d.owner.fullName}</option>}
                  {people.data?.items.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
                </select>
              </label>
              <label>Цикл пересмотра, мес.
                <input className="inp" type="number" min={1} max={60} required value={settings.reviewMonths} onChange={(e) => setSettings({ ...settings, reviewMonths: Number(e.target.value) })} />
              </label>
            </div>
            <div className="row">
              <button className="btn primary" type="submit" disabled={busy}>Сохранить</button>
              {cancelBtn}
            </div>
          </form>
        )}

        {shown && <FilePreview key={shown.id} file={shown} />}
        {d.versions.length > 0 && (
          <div>
            <div className="eyebrow">Версии</div>
            <div className="hist">
              {d.versions.map((v) => (
                <div key={v.no} className="hist-item">
                  <div>
                    <a href={v.onlyofficeUrl} target="_blank" rel="noopener noreferrer">Версия {versionLabel(v)}</a>
                    {' · '}{v.cancelledAt ? `пересмотр отменён ${formatDate(v.cancelledAt.slice(0, 10))}`
                      : v.signedOn ? `подписана ${formatDate(v.signedOn)}`
                        : v.approvedAt ? `утверждена ${formatDate(v.approvedAt.slice(0, 10))}` : 'в работе'}
                    {v.pdf && (
                      <>{' · '}<button type="button" className="btn ghost sm" aria-pressed={shown?.id === v.pdf.id} onClick={() => v.pdf && toggle({ id: v.pdf.id, name: v.pdf.name, mime: 'application/pdf', size: v.pdf.size })}>{v.signedOn ? 'Подписанный PDF' : 'PDF'}</button>
                        <span className="hint mono" title={v.pdf.sha256}> {shaShort(v.pdf.sha256)}</span></>
                    )}
                    {v.approvedAt && !v.textFrozen && <> <span className="chip high" title="Утверждена до появления итогового PDF: ссылка на OnlyOffice не фиксирует содержимое">текст не зафиксирован</span></>}
                  </div>
                  {v.changeNote && <div className="m">{v.changeNote}</div>}
                </div>
              ))}
            </div>
          </div>
        )}

        {d.history.length > 0 && (
          <div>
            <div className="eyebrow">История согласования</div>
            <div className="hist">
              {d.history.map((h) => (
                <div key={h.id} className={`hist-item${h.decision === 'returned' || h.decision === 'cancelled' ? ' returned' : ''}`}>
                  {formatDateTime(h.at)} · {h.actor}: {historyText(h)}
                  {h.pdfSha256 && <span className="hint mono" title={h.pdfSha256}> · файл {shaShort(h.pdfSha256)}</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {mode === 'view' && (d.can.manage || d.can.cancelRevision || d.can.delete) && (
          <div className="row dr-actions">
            {d.can.cancelRevision && <button className="btn sm" type="button" disabled={busy} onClick={() => open('cancel')}>Отменить пересмотр</button>}
            {d.can.manage && !d.archived && (
              <button className="btn sm" type="button" disabled={busy} onClick={() => { setSettings({ typeId: d.type.id, ownerId: d.owner.id, reviewMonths: d.reviewMonths }); setMode('settings'); }}>
                Тип, владелец, цикл
              </button>
            )}
            {d.can.manage && <button className="btn sm" type="button" disabled={busy} onClick={() => archive.mutate()}>{d.archived ? 'Вернуть из архива' : 'В архив'}</button>}
            {d.can.delete && <button className="btn sm danger" type="button" disabled={busy} onClick={() => open('delete')}>Удалить</button>}
          </div>
        )}
        <div className="hint">За 30 дней до даты пересмотра владельцу ставится задача «Пересмотреть документ».</div>
      </div>
    </>
  );
}
