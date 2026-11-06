import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { Me } from '../../api/client';
import { ApiError } from '../../api/client';
import { docsApi, dkeys, type ApprovalSlot, type DocAction, type DocDetail, type DocResult } from '../../api/documents';
import type { FileInfo } from '../../api/files';
import { settingsApi } from '../../api/settings';
import { useFileViewer } from '../../components/files/FileViewer';
import { FileUpload } from '../../components/files/FileUpload';
import { DetailPanel } from '../../components/DetailPanel';
import { LockIcon } from '../../components/LockIcon';
import { useToast } from '../../components/Toast';
import { formatDate } from '../registers/logic';
import { formatDateTime } from '../settings/logic';
import { todayLocal as todayIso } from '../tasks/logic';
import { DocumentBlockers, DocumentParties, DocumentTranslations } from './DocumentParties';
import { DocumentControls } from './DocumentControls';
import { HoldersLine, StageWho } from './Holders';
import { ACTION_DONE, ACTION_LABEL, historyText, isReturn, reviewLabel, SELF_APPROVED, STATUS_TONE, versionLabel } from './logic';

/** Ошибки, после которых карточку нужно перечитать: документ успели изменить или он ушёл на другой этап. */
const STALE = new Set(['VERSION_CONFLICT', 'STAGE_CHANGED', 'NOT_IN_ROUTE', 'WRONG_STAGE']);

type Mode = 'view' | DocAction | 'sign' | 'cancel' | 'delete' | 'edit' | 'revise' | 'settings';

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

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

type ViewFile = (f: { id: string; name: string; mime: string }) => void;
type SetFile = (x: { slot: ApprovalSlot; translationId?: string; fileId: string | null }) => void;

/** Ячейка файла этапа 24: есть — имя (просмотр), «Заменить», «Снять»; нет — загрузка (сразу привязывается к версии). */
function ApprovalSlotRow({ label, required, pdf, file, busy, onSet, onView }: {
  label: string; required: boolean; pdf: boolean; file: { id: string; name: string; mime?: string } | null; busy: boolean;
  onSet: (fileId: string | null) => void; onView: ViewFile;
}) {
  const [replace, setReplace] = useState(false);
  const pick = (list: FileInfo[]) => { const f = list[0]; if (f) { setReplace(false); onSet(f.id); } };
  return (
    <div className="appr-slot" data-slot={label}>
      <div className="row">
        <b>{label}</b>{required ? <span className="chip high">обязательно</span> : <span className="hint">по желанию</span>}
        {file && !replace && (
          <>
            <button type="button" className="btn ghost sm" data-view-file={file.name} onClick={() => onView({ id: file.id, name: file.name, mime: file.mime ?? (pdf ? 'application/pdf' : DOCX_MIME) })}>{file.name}</button>
            <button type="button" className="btn ghost sm" disabled={busy} onClick={() => setReplace(true)}>Заменить</button>
            <button type="button" className="btn ghost sm" disabled={busy} onClick={() => onSet(null)}>Снять</button>
          </>
        )}
      </div>
      {(!file || replace) && (
        <FileUpload label={pdf ? 'PDF' : 'Документ Word (.docx)'} multiple={false} accept={pdf ? '.pdf' : '.docx'} allowed={[pdf ? 'pdf' : 'docx']} value={[]} onChange={pick} />
      )}
    </div>
  );
}

/** Этап 24 «Утверждение» — единственный этап с файлами (решение владельца): основной язык и каждый язык перевода. */
function ApprovalFiles({ d, busy, onSet, onView, onViewPlain }: { d: DocDetail; busy: boolean; onSet: SetFile; onView: ViewFile; onViewPlain: ViewFile }) {
  const w = d.working;
  if (!w) return null;
  const pdf = d.versions.find((v) => v.no === w.no)?.pdf ?? null;
  const docx = d.versions.find((v) => v.no === w.no)?.docx ?? null;
  return (
    <div className="pdf-box" aria-label="Файлы утверждения">
      <div className="eyebrow">Файлы утверждения · версия {w.no}</div>
      <ApprovalSlotRow label="Подписанный PDF" required pdf file={pdf} busy={busy} onSet={(fileId) => onSet({ slot: 'pdf', fileId })} onView={onView} />
      <ApprovalSlotRow label="Исходный документ Word" required pdf={false} file={docx} busy={busy} onSet={(fileId) => onSet({ slot: 'docx', fileId })} onView={onView} />
      {d.translations.map((t) => (
        <div key={t.id} data-translation-files={t.language}>
          <ApprovalSlotRow label={`Перевод (${t.language}): Word`} required pdf={false} file={t.docx} busy={busy}
            onSet={(fileId) => onSet({ slot: 'translation_docx', translationId: t.id, fileId })} onView={onViewPlain} />
          <ApprovalSlotRow label={`Перевод (${t.language}): подписанный PDF`} required={false} pdf file={t.pdf} busy={busy}
            onSet={(fileId) => onSet({ slot: 'translation_pdf', translationId: t.id, fileId })} onView={onViewPlain} />
        </div>
      ))}
    </div>
  );
}

/** Карточка документа справа от реестра (1.6.5): прилипает к верху окна, действия — в подвале; на узком окне — выезжающая панель. */
export function DocumentPanel({ id, onGone, onClose, className }: { id: string; onGone: () => void; onClose?: () => void; className?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const doc = useQuery({ queryKey: dkeys.detail(id), queryFn: () => docsApi.get(id), retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2 });
  const [mode, setMode] = useState<Mode>('view');
  /** Вкладки утверждённого документа (1.11.0): карточка и механизмы контроля — сотрудникам ИБ. */
  const [tab, setTab] = useState<'doc' | 'controls'>('doc');
  const me = useOutletContext<Me | undefined>();
  const ibWork = me?.permissions.includes('ib.work') ?? false;
  const [comment, setComment] = useState('');
  const [note, setNote] = useState('');
  const [content, setContent] = useState<ContentDraft | null>(null);
  const [settings, setSettings] = useState<{ typeId: string; ownerId: string; reviewMonths: number } | null>(null);
  const [stale, setStale] = useState<string | null>(null);
  /** «Отправить на перевод»: автор подтверждает, что документ не изменялся после проверки начальником ИБ. */
  const [unchanged, setUnchanged] = useState(false);
  const [signedOn, setSignedOn] = useState(todayIso());
  const [order, setOrder] = useState({ no: '', date: '' });
  // Просмотр файлов на весь экран (1.4.0, шаг 8): содержимое — через backend с проверкой прав.
  const viewer = useFileViewer();
  const d = doc.data;

  const types = useQuery({ queryKey: dkeys.types, queryFn: () => settingsApi.items('document_types', false), enabled: mode === 'settings' });
  const people = useQuery({ queryKey: ['settings', 'userOptions'], queryFn: settingsApi.userOptions, enabled: mode === 'settings' });

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: dkeys.all }), qc.invalidateQueries({ queryKey: ['tasks'] })]);
  const done = async (r: DocResult, text: string) => {
    setMode('view');
    setComment('');
    setUnchanged(false);
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
    // Файлов в действиях нет (1.11.0): документ до утверждения — ссылка OnlyOffice.
    mutationFn: (a: DocAction) => docsApi.action(id, a, {
      ...at, comment: comment.trim() || undefined, confirmUnchanged: a === 'to_translation' ? unchanged : undefined,
    }),
    onSuccess: (r, a) => done(r, ACTION_DONE[a]),
    onError,
  });
  const sign = useMutation({
    mutationFn: () => docsApi.sign(id, { ...at, signedOn, orderNo: order.no.trim() || undefined, orderDate: order.date || null }),
    onSuccess: (r) => done(r, 'Документ утверждён: эта версия теперь действующая'),
    onError,
  });
  /** Этап 24: файл утверждения — сразу после загрузки (замена — тем же действием, снять — fileId null). */
  const approvalFile = useMutation({
    mutationFn: (x: { slot: ApprovalSlot; translationId?: string; fileId: string | null }) => docsApi.approvalFile(id, { ...at, ...x }),
    onSuccess: async (_r, x) => { await refresh(); toast(x.fileId ? 'Файл загружен' : 'Файл снят'); },
    onError,
  });
  const cancel = useMutation({ mutationFn: () => docsApi.cancelRevision(id, { version: at.version, comment }), onSuccess: (r) => done(r, 'Пересмотр отменён: действует утверждённая версия'), onError });
  const remove = useMutation({ mutationFn: () => docsApi.remove(id, { version: at.version, comment: comment.trim() || undefined }), onSuccess: (r) => done(r, 'Документ удалён'), onError });
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
  const busy = [act, sign, approvalFile, cancel, remove, say, save, revise, saveSettings, archive].some((m) => m.isPending);

  const shell = { label: 'Документ', variant: 'inline' as const, onClose, className, scrollKey: id };
  if (doc.isError) {
    return (
      <DetailPanel {...shell} title="Документ недоступен">
        <div className="form-error">{doc.error instanceof ApiError && doc.error.status === 404 ? 'Документ не найден или вам не виден' : doc.error.message}</div>
      </DetailPanel>
    );
  }
  if (!d) return <DetailPanel {...shell} title="Загрузка…"><div className="hint">Загружаем карточку документа</div></DetailPanel>;

  const open = (m: Mode) => {
    setComment('');
    setUnchanged(false);
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
  /** Файл версии документа: для .docx — ещё «Открыть в OnlyOffice» (ссылка есть только у версии). */
  const viewVersionFile = (f: { id: string; name: string; mime: string }, onlyofficeUrl = d.current.onlyofficeUrl) => void viewer.open(f, { onlyofficeUrl });
  /** Файлы прежнего маршрута, файлы утверждения — просмотр и «Скачать». */
  const viewFile = (f: { id: string; name: string; mime: string }) => void viewer.open(f);
  const nextNo = Math.max(0, ...d.versions.map((v) => v.no)) + 1;
  const action = d.can.actions.find((a) => a === mode);
  const cancelBtn = <button className="btn" type="button" onClick={() => setMode('view')}>Отмена</button>;

  // Подвал: главные действия этапа и файл документа — на виду при любой длине маршрута и истории.
  const footer = mode === 'view' && tab === 'doc' ? (
    <div className="row">
      {d.can.actions.filter((a) => !isReturn(a)).map((a) => (
        <button key={a} className="btn primary" type="button" disabled={busy} onClick={() => open(a)}>{ACTION_LABEL[a]}</button>
      ))}
      {d.can.approvalFiles && (
        <button className="btn primary" type="button" disabled={busy || !d.can.sign} title={d.can.sign ? undefined : 'Сначала загрузите обязательные файлы утверждения'} onClick={() => open('sign')}>Утвердить</button>
      )}
      {d.can.actions.filter(isReturn).map((a) => (
        <button key={a} className="btn" type="button" disabled={busy} onClick={() => open(a)}>{ACTION_LABEL[a]}</button>
      ))}
      {d.can.edit && <button className="btn" type="button" disabled={busy} onClick={() => startEdit('edit')}>Изменить драфт</button>}
      {d.can.revise && <button className="btn" type="button" disabled={busy} onClick={() => startEdit('revise')}>Новая версия</button>}
      <a className="btn" href={d.current.onlyofficeUrl} target="_blank" rel="noopener noreferrer">Открыть в OnlyOffice</a>
    </div>
  ) : undefined;

  return (
    <DetailPanel {...shell} eyebrow={d.type.value} title={d.title} footer={footer}
      badges={<span className={`chip ${STATUS_TONE[d.status]}`}>{d.statusName}</span>}>
        {stale && (
          <div className="note conflict" role="alert">
            {stale}
            <div className="row mt6"><button className="btn sm primary" type="button" onClick={() => void reload()}>Обновить документ</button></div>
          </div>
        )}
        {ibWork && d.approvedVersionNo !== null && (
          <div className="tabs" role="tablist" aria-label="Разделы документа">
            <button type="button" role="tab" aria-selected={tab === 'doc'} onClick={() => setTab('doc')}>Документ</button>
            <button type="button" role="tab" aria-selected={tab === 'controls'} onClick={() => setTab('controls')}>Механизмы контроля</button>
          </div>
        )}
        {tab === 'controls' && ibWork && d.approvedVersionNo !== null ? <DocumentControls docId={d.id} /> : (
        <>
        <div className="row gap-lg">
          <div><div className="eyebrow">Версия</div><div className="mono">{versionLabel(d.current)}</div></div>
          <div><div className="eyebrow">Цикл пересмотра</div><div>{d.reviewMonths} мес.</div></div>
          <div><div className="eyebrow">Владелец</div><div>{d.owner.fullName}</div></div>
          {d.signedOn && <div><div className="eyebrow">Утверждён</div><div className="mono">{formatDate(d.signedOn)}</div></div>}
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
          <div className="eyebrow">Маршрут согласования{d.current.round > 1 ? `, круг ${d.current.round}` : ''}</div>
          {d.holders && !d.archived && <HoldersLine holders={d.holders} testId="doc-now-at" className="now-at" />}
          <div className="vsteps">
            {d.route.map((r, i) => (
              <div key={r.stage} className={`vstep is-${r.state === 'done' ? 'done' : r.state === 'current' ? 'cur' : 'next'}${r.skipped ? ' is-skipped' : ''}`} data-stage={r.stage}
                aria-current={r.state === 'current' ? 'step' : undefined}>
                {/* Номер — настоящий порядок этапов; пройденный — галочка, текущий — кольцо: различимы не только цветом. */}
                <span className={`step${r.state === 'done' ? ' done' : r.state === 'current' ? ' cur' : ''}`} aria-hidden="true">
                  {r.state === 'done'
                    ? <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 8.5l3 3 6-7" /></svg>
                    : i + 1}
                </span>
                <div>
                  <b>{r.name}</b>
                  {r.place && r.place !== r.name && <small className="stage-place" data-testid="stage-place">{r.place}</small>}
                  {/* Кто действует на этапе — та же функция, что «Сейчас у»; у пройденного справа — кто и когда. */}
                  <StageWho hint={r.hint} approvers={r.approvers} missingHead={r.missingHead} />
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

        {d.files.length > 0 && (
          <div className="pdf-box" aria-label="Файлы прежнего маршрута">
            <div className="eyebrow">Файлы прежнего маршрута · версия {d.current.no}</div>
            {d.files.map((f) => (
              <div key={f.id} className="row" data-file-kind={f.kind}>
                <span className="hint" data-testid="file-marks">{f.marks.join(' · ')}{f.kind !== 'draft' && d.current.round > 1 ? `, круг ${f.round}` : ''}:</span>
                <button type="button" className="btn ghost sm" data-view-file={f.file.name} onClick={() => viewVersionFile(f.file)}>{f.file.name}</button>
                <span className="hint mono" title={f.file.sha256}>sha256 {shaShort(f.file.sha256)}</span>
              </div>
            ))}
          </div>
        )}
        {d.can.approvalFiles && d.working && (
          <ApprovalFiles d={d} busy={busy} onSet={(x) => approvalFile.mutate(x)} onView={viewVersionFile} onViewPlain={viewFile} />
        )}

        {mode === 'view' && d.blockedReason && (
          <div className="note ro"><LockIcon /><span>{d.blockedReason}</span></div>
        )}
        {mode === 'view' && d.returned && (
          <div className="note conflict" data-testid="doc-returned">
            Возвращён на доработку с этапа «{d.returned.stageName}». {d.returned.actor}, {formatDateTime(d.returned.at)}: {d.returned.comment}
            {d.returned.file && (
              <div className="row mt6">
                <span className="hint">Записка:</span>
                <button type="button" className="btn ghost sm" data-testid="return-note" onClick={() => d.returned?.file && viewFile(d.returned.file)}>{d.returned.file.name}</button>
              </div>
            )}
          </div>
        )}

        {action && (
          <form className="task-form" aria-label={ACTION_LABEL[action]} onSubmit={(e) => { e.preventDefault(); act.mutate(action); }}>
            {(action === 'head_approve' || action === 'head_reapprove') && (
              <div className="hint">Одобрение — по ссылке OnlyOffice версии {d.current.no}: ссылка, кто и когда попадут в историю. Содержимое по ссылке не фиксируется.</div>
            )}
            {action === 'to_translation' && (
              <label className="chk">
                <input type="checkbox" checked={unchanged} onChange={(e) => setUnchanged(e.target.checked)} />
                Документ не изменялся после проверки начальником ИБ
              </label>
            )}
            {action === 'to_translation' && !unchanged && (
              <div className="hint">Если документ менялся — «Повторная проверка»: начальник ИБ проверит доработанную версию.</div>
            )}
            <label>{isReturn(action) ? 'Что нужно исправить' : 'Комментарий (необязательно)'}
              <textarea className="inp" required={isReturn(action)} maxLength={4000}
                placeholder={isReturn(action) ? 'Замечания для автора: они попадут в историю и в задачу автору' : ''}
                value={comment} onChange={(e) => setComment(e.target.value)} />
            </label>
            <div className="row">
              <button className="btn primary" type="submit" disabled={busy || (isReturn(action) && !comment.trim()) || (action === 'to_translation' && !unchanged)}>
                {isReturn(action) ? 'Вернуть автору' : ACTION_LABEL[action]}
              </button>
              {cancelBtn}
            </div>
          </form>
        )}

        {mode === 'sign' && (
          <form className="task-form" aria-label="Утверждение" onSubmit={(e) => { e.preventDefault(); sign.mutate(); }}>
            <label>Дата утверждения<input className="inp" type="date" required max={todayIso()} value={signedOn} onChange={(e) => setSignedOn(e.target.value)} /></label>
            <div className="fgrid">
              <label>Номер приказа (необязательно)<input className="inp" maxLength={100} value={order.no} onChange={(e) => setOrder({ ...order, no: e.target.value })} /></label>
              <label>Дата приказа (необязательно)<input className="inp" type="date" max={todayIso()} value={order.date} onChange={(e) => setOrder({ ...order, date: e.target.value })} /></label>
            </div>
            <div className="hint">Пересмотр — через {d.reviewMonths} мес. от даты утверждения.</div>
            <div className="row"><button className="btn primary" type="submit" disabled={busy || !signedOn}>Утвердить</button>{cancelBtn}</div>
          </form>
        )}

        {mode === 'view' && <DocumentBlockers d={d} at={at} onDone={done} onError={onError} />}
        {mode === 'view' && <DocumentParties d={d} at={at} onDone={done} onError={onError} onPreview={viewFile} />}
        {mode === 'view' && <DocumentTranslations d={d} at={at} onDone={done} onError={onError} onPreview={viewFile} />}

        {(d.comments.length > 0 || d.can.comment) && (
          <div aria-label="Комментарии сотрудников">
            <div className="eyebrow">Комментарии сотрудников</div>
            <div className="hist">
              {d.comments.map((c) => <div key={c.id} className="hist-item"><div className="hist-meta"><b>{c.author}</b><time>{formatDateTime(c.at)}</time></div><div>{c.body}</div></div>)}
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
                ? `Версия ${d.working?.no ?? ''} уйдёт в историю как отменённая, действующей останется утверждённая версия ${d.approvedVersionNo ?? ''}.`
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
              <div className="hint">Версия {nextNo} пройдёт маршрут заново. Пересмотр без изменений — тоже новая версия. Версия {d.approvedVersionNo} действует, пока новую не утвердят.</div>
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

        {viewer.element}
        {d.versions.length > 0 && (
          <div>
            <div className="eyebrow">Версии</div>
            <div className="hist">
              {d.versions.map((v) => (
                <div key={v.no} className="hist-item">
                  <div>
                    <a href={v.onlyofficeUrl} target="_blank" rel="noopener noreferrer">Версия {versionLabel(v)}</a>
                    {' · '}{v.cancelledAt ? `пересмотр отменён ${formatDate(v.cancelledAt.slice(0, 10))}`
                      : v.signedOn ? `утверждена ${formatDate(v.signedOn)}`
                        : v.approvedAt ? `утверждена ${formatDate(v.approvedAt.slice(0, 10))}` : 'в работе'}
                    {v.pdf && (
                      <>{' · '}<button type="button" className="btn ghost sm" data-view-file={v.pdf.name} onClick={() => v.pdf && viewVersionFile({ id: v.pdf.id, name: v.pdf.name, mime: 'application/pdf' }, v.onlyofficeUrl)}>{v.signedOn ? 'Подписанный PDF' : 'PDF'}</button>
                        <span className="hint mono" title={v.pdf.sha256}> {shaShort(v.pdf.sha256)}</span></>
                    )}
                    {v.docx && v.approvedAt && (
                      <>{' · '}<button type="button" className="btn ghost sm" data-view-file={v.docx.name} onClick={() => v.docx && viewFile({ id: v.docx.id, name: v.docx.name, mime: DOCX_MIME })}>Исходный Word</button></>
                    )}
                    {v.orderNo && <>{' · '}приказ № {v.orderNo}{v.orderDate ? ` от ${formatDate(v.orderDate)}` : ''}</>}
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
                  <div className="hist-meta"><b>{h.actor}</b><time>{formatDateTime(h.at)}</time></div>
                  <div>{historyText(h)}{h.pdfSha256 && <span className="hint mono" title={h.pdfSha256}>, файл {shaShort(h.pdfSha256)}</span>}</div>
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
        </>
        )}
    </DetailPanel>
  );
}
