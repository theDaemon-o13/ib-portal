// Этапы 14 и 15 и блокеры документа (релиз 1.2.0, этапы Г3–Г4, ADR-0024): ответственные лица, переводы, блокеры.
// Решает всегда backend: кнопки видны по d.can, ошибки — через onError карточки.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { docsApi, type At, type DocDetail, type DocResult } from '../../api/documents';
import type { FileInfo } from '../../api/files';
import { settingsApi } from '../../api/settings';
import { FileUpload } from '../../components/files/FileUpload';
import { formatDate } from '../registers/logic';
import { formatDateTime } from '../settings/logic';

type Party = DocDetail['parties'][number];
type Done = (r: DocResult, text: string) => Promise<void>;
type Preview = { id: string; name: string; mime: string; size: number };

interface Props {
  d: DocDetail;
  at: At;
  onDone: Done;
  onError: (e: unknown) => void;
  onPreview: (f: Preview) => void;
}

type PartyMode = { kind: 'add' } | { kind: 'approve' | 'due'; party: Party } | null;

const empty = { fullName: '', department: '', email: '', userId: '', dueDate: '' };

export function DocumentParties({ d, at, onDone, onError, onPreview }: Props) {
  const [mode, setMode] = useState<PartyMode>(null);
  const [form, setForm] = useState(empty);
  const [comment, setComment] = useState('');
  const [files, setFiles] = useState<FileInfo[]>([]);
  const people = useQuery({ queryKey: ['settings', 'userOptions', 'all'], queryFn: settingsApi.allUserOptions, enabled: mode?.kind === 'add' });

  const close = () => { setMode(null); setForm(empty); setComment(''); setFiles([]); };
  const done = async (r: DocResult, text: string) => { close(); await onDone(r, text); };
  const add = useMutation({
    mutationFn: () => docsApi.addParty(d.id, { ...at, fullName: form.fullName, department: form.department, email: form.email, userId: form.userId || null, dueDate: form.dueDate }),
    onSuccess: (r) => done(r, 'Ответственное лицо добавлено'), onError,
  });
  const approve = useMutation({
    mutationFn: (p: Party) => docsApi.approveParty(d.id, p.id, { ...at, comment: comment.trim() || undefined, fileIds: files.map((f) => f.id) }),
    onSuccess: (r, p) => done(r, `${p.fullName}: согласование отмечено`), onError,
  });
  const due = useMutation({
    mutationFn: (p: Party) => docsApi.updateParty(d.id, p.id, { ...at, dueDate: form.dueDate, comment }),
    onSuccess: (r) => done(r, 'Срок изменён'), onError,
  });
  const remove = useMutation({ mutationFn: (p: Party) => docsApi.removeParty(d.id, p.id, at), onSuccess: (r) => done(r, 'Ответственное лицо снято'), onError });
  const removeFile = useMutation({ mutationFn: (linkId: string) => docsApi.removeResponse(d.id, linkId, at), onSuccess: (r) => done(r, 'Файл ответа снят'), onError });
  const busy = add.isPending || approve.isPending || due.isPending || remove.isPending || removeFile.isPending;

  if (!d.parties.length && !d.can.parties) return null;
  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  return (
    <div aria-label="Ответственные лица">
      <div className="eyebrow">Ответственные лица</div>
      {d.parties.length === 0 && <div className="hint">Пока никого. Документ на этапе «Согласование с ответственными лицами» идёт дальше, когда все лица согласовали.</div>}
      <div className="hist">
        {d.parties.map((p) => (
          <div key={p.id} className="hist-item" data-party={p.fullName}>
            <div>
              <b>{p.fullName}</b>{p.department && ` · ${p.department}`}{p.email && <span className="hint"> · {p.email}</span>}
              {p.user && <span className="hint"> · в портале: {p.user.fullName}</span>}
            </div>
            <div className="row">
              <span className={`mono${p.overdue ? ' late-t' : ''}`}>срок {formatDate(p.dueDate)}{p.overdue ? ' — просрочен' : ''}</span>
              {p.approvedAt
                ? <span className="chip low">согласовал(а) {formatDate(p.approvedAt.slice(0, 10))}{p.approvedBy ? ` · отметил(а) ${p.approvedBy}` : ''}</span>
                : <span className="chip">ждём ответа</span>}
              {!mode && !p.approvedAt && d.can.approveParties && <button type="button" className="btn sm primary" disabled={busy} onClick={() => setMode({ kind: 'approve', party: p })}>Отметить согласование</button>}
              {!mode && !p.approvedAt && d.can.parties && <button type="button" className="btn ghost sm" disabled={busy} onClick={() => { setForm({ ...empty, dueDate: p.dueDate }); setMode({ kind: 'due', party: p }); }}>Срок</button>}
              {!mode && !p.approvedAt && d.can.parties && <button type="button" className="btn ghost sm" disabled={busy} onClick={() => remove.mutate(p)}>Снять</button>}
            </div>
            {p.approveComment && <div className="m">{p.approveComment}</div>}
            {p.files.map((f) => (
              <div key={f.id} className="row">
                <span className="hint">Ответ:</span>
                <button type="button" className="btn ghost sm" onClick={() => onPreview({ id: f.file.id, name: f.file.name, mime: f.file.mime, size: f.file.size })}>{f.file.name}</button>
                {d.can.parties && !mode && <button type="button" className="btn ghost sm" disabled={busy} onClick={() => removeFile.mutate(f.id)}>Снять</button>}
              </div>
            ))}
            {p.deadlines.map((c) => (
              <div key={c.at} className="hint">{formatDateTime(c.at)} · {c.actor}: срок {formatDate(c.from)} → {formatDate(c.to)} — {c.comment}</div>
            ))}
          </div>
        ))}
      </div>
      {!mode && d.can.parties && <div className="row"><button type="button" className="btn sm" onClick={() => setMode({ kind: 'add' })}>Добавить ответственное лицо</button></div>}

      {mode?.kind === 'add' && (
        <form className="task-form" aria-label="Ответственное лицо" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <div className="fgrid">
            <label>ФИО<input className="inp" required maxLength={300} value={form.fullName} onChange={set('fullName')} /></label>
            <label>Подразделение<input className="inp" maxLength={300} value={form.department} onChange={set('department')} /></label>
            <label>E-mail (для справки)<input className="inp" type="email" maxLength={320} value={form.email} onChange={set('email')} /></label>
            <label>Пользователь портала (необязательно)
              <select className="inp" value={form.userId} onChange={set('userId')}>
                <option value="">— нет —</option>
                {people.data?.items.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
              </select>
            </label>
            <label>Срок ответа<input className="inp" type="date" required value={form.dueDate} onChange={set('dueDate')} /></label>
          </div>
          <div className="hint">Портал писем не отправляет: документ ответственному лицу отправьте по почте, ответ отметьте здесь.</div>
          <div className="row">
            <button className="btn primary" type="submit" disabled={busy || !form.fullName.trim() || !form.dueDate}>Добавить</button>
            <button className="btn" type="button" onClick={close}>Отмена</button>
          </div>
        </form>
      )}
      {mode?.kind === 'approve' && (
        <form className="task-form" aria-label="Согласование лица" onSubmit={(e) => { e.preventDefault(); approve.mutate(mode.party); }}>
          <div className="hint">{mode.party.fullName}: отметить, что согласовал(а).</div>
          <FileUpload label="Ответ (необязательно): письмо, скан" accept=".pdf,.docx,.png,.jpg,.jpeg,.txt" allowed={['pdf', 'docx', 'png', 'jpg', 'jpeg', 'txt']} value={files} onChange={setFiles} />
          <label>Комментарий (необязательно)<textarea className="inp" maxLength={4000} value={comment} onChange={(e) => setComment(e.target.value)} /></label>
          <div className="row">
            <button className="btn primary" type="submit" disabled={busy}>Согласовал(а)</button>
            <button className="btn" type="button" onClick={close}>Отмена</button>
          </div>
        </form>
      )}
      {mode?.kind === 'due' && (
        <form className="task-form" aria-label="Срок ответа" onSubmit={(e) => { e.preventDefault(); due.mutate(mode.party); }}>
          <div className="hint">{mode.party.fullName}: сейчас до {formatDate(mode.party.dueDate)}.</div>
          <label>Новый срок<input className="inp" type="date" required value={form.dueDate} onChange={set('dueDate')} /></label>
          <label>Почему меняется срок<textarea className="inp" required maxLength={4000} value={comment} onChange={(e) => setComment(e.target.value)} /></label>
          <div className="row">
            <button className="btn primary" type="submit" disabled={busy || !comment.trim() || !form.dueDate || form.dueDate === mode.party.dueDate}>Изменить срок</button>
            <button className="btn" type="button" onClick={close}>Отмена</button>
          </div>
        </form>
      )}
    </div>
  );
}

type Blocker = DocDetail['blockers'][number];

export function DocumentBlockers({ d, at, onDone, onError }: Omit<Props, 'onPreview'>) {
  const [mode, setMode] = useState<{ kind: 'add' } | { kind: 'resolve'; blocker: Blocker } | null>(null);
  const [text, setText] = useState('');
  const close = () => { setMode(null); setText(''); };
  const done = async (r: DocResult, msg: string) => { close(); await onDone(r, msg); };
  const add = useMutation({ mutationFn: () => docsApi.addBlocker(d.id, { ...at, text }), onSuccess: (r) => done(r, 'Блокер открыт: документ не двинется дальше, пока его не снимут'), onError });
  const resolve = useMutation({ mutationFn: (b: Blocker) => docsApi.resolveBlocker(d.id, b.id, { ...at, comment: text }), onSuccess: (r) => done(r, 'Блокер снят'), onError });
  const busy = add.isPending || resolve.isPending;
  if (!d.blockers.length && !d.can.blockers) return null;
  const open = d.blockers.filter((b) => !b.resolvedAt);

  return (
    <div aria-label="Блокеры">
      <div className="eyebrow">Блокеры{open.length ? ` · открыто ${open.length}` : ''}</div>
      <div className="hist">
        {d.blockers.map((b) => (
          <div key={b.id} className={`hist-item${b.resolvedAt ? '' : ' returned'}`} data-blocker={b.resolvedAt ? 'resolved' : 'open'}>
            <div>{b.text}</div>
            <div className="hint">{b.openedBy}, {formatDateTime(b.openedAt)}{b.resolvedAt && ` · снят: ${b.resolvedBy ?? ''}, ${formatDateTime(b.resolvedAt)} — ${b.resolveComment}`}</div>
            {!b.resolvedAt && !mode && d.can.blockers && <div className="row"><button type="button" className="btn ghost sm" disabled={busy} onClick={() => setMode({ kind: 'resolve', blocker: b })}>Снять блокер</button></div>}
          </div>
        ))}
      </div>
      {!mode && d.can.blockers && <div className="row"><button type="button" className="btn sm" onClick={() => setMode({ kind: 'add' })}>Добавить блокер</button></div>}
      {mode && (
        <form className="task-form" aria-label={mode.kind === 'add' ? 'Блокер' : 'Снятие блокера'} onSubmit={(e) => { e.preventDefault(); if (mode.kind === 'add') add.mutate(); else resolve.mutate(mode.blocker); }}>
          <label>{mode.kind === 'add' ? 'Что мешает' : 'Как снят блокер'}
            <textarea className="inp" required maxLength={mode.kind === 'add' ? 2000 : 4000} value={text} onChange={(e) => setText(e.target.value)} />
          </label>
          <div className="row">
            <button className="btn primary" type="submit" disabled={busy || !text.trim()}>{mode.kind === 'add' ? 'Открыть блокер' : 'Снять блокер'}</button>
            <button className="btn" type="button" onClick={close}>Отмена</button>
          </div>
        </form>
      )}
    </div>
  );
}

type Translation = DocDetail['translations'][number];
type TrMode = { kind: 'add' } | { kind: 'due' | 'upload'; t: Translation } | null;

/** Этап 15 «Перевод» (Г4): языки, переводчики, сроки; 15 → 16 — когда у каждого языка есть файл. */
export function DocumentTranslations({ d, at, onDone, onError, onPreview }: Props) {
  const [mode, setMode] = useState<TrMode>(null);
  const [form, setForm] = useState({ language: '', translatorId: '', dueDate: '' });
  const [comment, setComment] = useState('');
  const [files, setFiles] = useState<FileInfo[]>([]);
  const people = useQuery({ queryKey: ['settings', 'userOptions', 'all'], queryFn: settingsApi.allUserOptions, enabled: mode?.kind === 'add' });
  const close = () => { setMode(null); setForm({ language: '', translatorId: '', dueDate: '' }); setComment(''); setFiles([]); };
  const done = async (r: DocResult, text: string) => { close(); await onDone(r, text); };
  const add = useMutation({ mutationFn: () => docsApi.addTranslation(d.id, { ...at, ...form }), onSuccess: (r) => done(r, 'Язык перевода добавлен'), onError });
  const due = useMutation({ mutationFn: (t: Translation) => docsApi.updateTranslation(d.id, t.id, { ...at, dueDate: form.dueDate, comment }), onSuccess: (r) => done(r, 'Срок перевода изменён'), onError });
  const remove = useMutation({ mutationFn: (t: Translation) => docsApi.removeTranslation(d.id, t.id, at), onSuccess: (r) => done(r, 'Язык снят'), onError });
  const upload = useMutation({ mutationFn: (t: Translation) => docsApi.addTranslationFiles(d.id, t.id, { ...at, fileIds: files.map((f) => f.id) }), onSuccess: (r, t) => done(r, `Перевод на ${t.language} приложен`), onError });
  const removeFile = useMutation({ mutationFn: (x: { t: Translation; linkId: string }) => docsApi.removeTranslationFile(d.id, x.t.id, x.linkId, at), onSuccess: (r) => done(r, 'Файл перевода снят'), onError });
  const busy = add.isPending || due.isPending || remove.isPending || upload.isPending || removeFile.isPending;
  if (!d.translations.length && !d.can.translations) return null;
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  return (
    <div aria-label="Перевод">
      <div className="eyebrow">Перевод</div>
      {d.translations.length === 0 && <div className="hint">Языки не указаны: если перевод не нужен, документ пройдёт этап «Перевод» без файлов.</div>}
      <div className="hist">
        {d.translations.map((t) => (
          <div key={t.id} className="hist-item" data-translation={t.language}>
            <div><b>{t.language}</b> · переводчик {t.translator.fullName}</div>
            <div className="row">
              <span className={`mono${t.overdue ? ' late-t' : ''}`}>срок {formatDate(t.dueDate)}{t.overdue ? ' — просрочен' : ''}</span>
              <span className={`chip${t.done ? ' low' : ''}`}>{t.done ? 'перевод приложен' : 'ждём перевод'}</span>
              {!mode && t.canUpload && <button type="button" className="btn sm primary" disabled={busy} onClick={() => setMode({ kind: 'upload', t })}>Приложить перевод</button>}
              {!mode && d.can.translations && <button type="button" className="btn ghost sm" disabled={busy} onClick={() => { setForm({ ...form, dueDate: t.dueDate }); setMode({ kind: 'due', t }); }}>Срок</button>}
              {!mode && d.can.translations && !t.done && <button type="button" className="btn ghost sm" disabled={busy} onClick={() => remove.mutate(t)}>Снять</button>}
            </div>
            {t.files.map((f) => (
              <div key={f.id} className="row">
                <button type="button" className="btn ghost sm" onClick={() => onPreview({ id: f.file.id, name: f.file.name, mime: f.file.mime, size: f.file.size })}>{f.file.name}</button>
                {t.canUpload && !mode && <button type="button" className="btn ghost sm" disabled={busy} onClick={() => removeFile.mutate({ t, linkId: f.id })}>Снять</button>}
              </div>
            ))}
            {t.deadlines.map((c) => <div key={c.at} className="hint">{formatDateTime(c.at)} · {c.actor}: срок {formatDate(c.from)} → {formatDate(c.to)} — {c.comment}</div>)}
          </div>
        ))}
      </div>
      {!mode && d.can.translations && <div className="row"><button type="button" className="btn sm" onClick={() => setMode({ kind: 'add' })}>Добавить язык</button></div>}
      {mode?.kind === 'add' && (
        <form className="task-form" aria-label="Язык перевода" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <div className="fgrid">
            <label>Язык<input className="inp" required maxLength={100} placeholder="например, таджикский" value={form.language} onChange={set('language')} /></label>
            <label>Переводчик
              <select className="inp" required value={form.translatorId} onChange={set('translatorId')}>
                <option value="">— выберите —</option>
                {people.data?.items.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
              </select>
            </label>
            <label>Срок перевода<input className="inp" type="date" required value={form.dueDate} onChange={set('dueDate')} /></label>
          </div>
          <div className="row">
            <button className="btn primary" type="submit" disabled={busy || !form.language.trim() || !form.translatorId || !form.dueDate}>Добавить</button>
            <button className="btn" type="button" onClick={close}>Отмена</button>
          </div>
        </form>
      )}
      {mode?.kind === 'due' && (
        <form className="task-form" aria-label="Срок перевода" onSubmit={(e) => { e.preventDefault(); due.mutate(mode.t); }}>
          <label>Новый срок<input className="inp" type="date" required value={form.dueDate} onChange={set('dueDate')} /></label>
          <label>Почему меняется срок<textarea className="inp" required maxLength={4000} value={comment} onChange={(e) => setComment(e.target.value)} /></label>
          <div className="row">
            <button className="btn primary" type="submit" disabled={busy || !comment.trim() || !form.dueDate || form.dueDate === mode.t.dueDate}>Изменить срок</button>
            <button className="btn" type="button" onClick={close}>Отмена</button>
          </div>
        </form>
      )}
      {mode?.kind === 'upload' && (
        <form className="task-form" aria-label="Файл перевода" onSubmit={(e) => { e.preventDefault(); upload.mutate(mode.t); }}>
          <FileUpload label={`Перевод на ${mode.t.language} (pdf или docx)`} accept=".pdf,.docx" allowed={['pdf', 'docx']} value={files} onChange={setFiles} required />
          <div className="row">
            <button className="btn primary" type="submit" disabled={busy || !files.length}>Приложить</button>
            <button className="btn" type="button" onClick={close}>Отмена</button>
          </div>
        </form>
      )}
    </div>
  );
}
