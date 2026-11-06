// Ответственные лица (драфт и «Согласование»), переводы («Перевод») и блокеры документа — маршрут 1.11.0, ADR-0042.
// Решает всегда backend: кнопки видны по d.can, ошибки — через onError карточки.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useState, type KeyboardEvent } from 'react';
import { dkeys, docsApi, type At, type DocDetail, type DocResult } from '../../api/documents';
import { formatDate } from '../registers/logic';
import { formatDateTime } from '../settings/logic';
import { todayLocal as todayIso } from '../tasks/logic';
import { matchPerson, personKey } from './logic';

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

type PartyMode = { kind: 'add' } | { kind: 'approve' | 'due' | 'recheck'; party: Party } | null;
type Person = { id: string; fullName: string; position: string };

/** Сколько подсказок показывать: дальше — уточнить ввод. */
const PICK_MAX = 50;

/**
 * «ФИО» с выбором из справочника «Ответственные лица» (1.6.7): ввод фильтрует список по ФИО и должности, выбор
 * заполняет ФИО и должность. «Ввести вручную» закрывает список — оба поля вводятся как раньше (разовые люди).
 * Уже добавленные в документ — в списке с пометкой, не выбираются (окончательно — 409 PARTY_DUPLICATE на сервере).
 */
function PersonCombobox({ value, onChange, onPick, people, taken }: {
  value: string; onChange: (v: string) => void; onPick: (p: Person) => void; people: Person[]; taken: ReadonlySet<string>;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [manual, setManual] = useState(false);
  const [active, setActive] = useState(-1);
  const found = people.filter((p) => matchPerson(p, value));
  const shown = found.slice(0, PICK_MAX);
  // Последний пункт — «Ввести вручную»; индекс shown.length.
  const total = shown.length + 1;
  const visible = open && !manual && people.length > 0;
  const isTaken = (p: Person) => taken.has(personKey(p.fullName, p.position));
  const choose = (i: number) => {
    if (i === shown.length) { setManual(true); setOpen(false); return; }
    const p = shown[i];
    if (!p || isTaken(p)) return;
    onPick(p);
    setOpen(false);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setManual(false); setActive((a) => (a + 1) % total); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setOpen(true); setManual(false); setActive((a) => (a <= 0 ? total - 1 : a - 1)); }
    else if (e.key === 'Enter' && visible && active >= 0) { e.preventDefault(); choose(active); }
    else if (e.key === 'Escape' && visible) { e.preventDefault(); e.stopPropagation(); setOpen(false); }
  };
  return (
    <span className="combo">
      <input className="inp" required maxLength={300} value={value} role="combobox" aria-autocomplete="list" aria-expanded={visible} aria-controls={listId}
        aria-activedescendant={visible && active >= 0 ? `${listId}-${active}` : undefined} autoComplete="off"
        onChange={(e) => { onChange(e.target.value); setActive(-1); if (!manual) setOpen(true); }}
        onFocus={() => { if (!manual) setOpen(true); }} onBlur={() => setOpen(false)} onKeyDown={onKey} />
      {visible && (
        <ul className="combo-list" id={listId} role="listbox" aria-label="Ответственные лица из справочника">
          {shown.length === 0 && <li className="combo-empty" role="presentation">В справочнике такого нет</li>}
          {shown.map((p, i) => {
            const off = isTaken(p);
            return (
              <li key={p.id} id={`${listId}-${i}`} role="option" aria-selected={active === i} aria-disabled={off || undefined} className="combo-opt"
                onMouseDown={(e) => e.preventDefault()} onClick={() => choose(i)} onMouseEnter={() => setActive(i)} data-person={p.fullName}>
                <span className="combo-name">{p.fullName}</span>
                {p.position && <span className="combo-pos">{p.position}</span>}
                {off && <span className="combo-pos">уже добавлен(а)</span>}
              </li>
            );
          })}
          {found.length > shown.length && <li className="combo-empty" role="presentation">Ещё {found.length - shown.length} — уточните ввод</li>}
          <li id={`${listId}-${shown.length}`} role="option" aria-selected={active === shown.length} className="combo-opt combo-manual"
            onMouseDown={(e) => e.preventDefault()} onClick={() => choose(shown.length)} onMouseEnter={() => setActive(shown.length)}>
            Ввести вручную
          </li>
        </ul>
      )}
    </span>
  );
}

// Ответственное лицо — внешний человек: ФИО, подразделение или должность, срок. В драфте (21) срок — днями от перехода на
// «Согласование» (решение владельца 11), на «Согласовании» (22) — датой; отметка — дата согласования и комментарий, без файла.
const empty = { fullName: '', department: '', dueDate: '', dueDays: '7', approvedOn: '' };

export function DocumentParties({ d, at, onDone, onError, onPreview }: Props) {
  const [mode, setMode] = useState<PartyMode>(null);
  const [form, setForm] = useState(empty);
  const [comment, setComment] = useState('');
  const onDraft = d.working?.stage === 21;

  const close = () => { setMode(null); setForm(empty); setComment(''); };
  const done = async (r: DocResult, text: string) => { close(); await onDone(r, text); };
  const add = useMutation({
    mutationFn: () => docsApi.addParty(d.id, {
      ...at, fullName: form.fullName, department: form.department,
      ...(onDraft ? { dueDays: Number(form.dueDays) } : { dueDate: form.dueDate }),
    }),
    onSuccess: (r) => done(r, 'Ответственное лицо добавлено'), onError,
  });
  const approve = useMutation({
    mutationFn: (p: Party) => docsApi.approveParty(d.id, p.id, { ...at, comment: comment.trim() || undefined, approvedOn: form.approvedOn || undefined }),
    onSuccess: (r, p) => done(r, `${p.fullName}: согласование отмечено`), onError,
  });
  const due = useMutation({
    mutationFn: (p: Party) => docsApi.updateParty(d.id, p.id, onDraft ? { ...at, dueDays: Number(form.dueDays) } : { ...at, dueDate: form.dueDate, comment }),
    onSuccess: (r) => done(r, 'Срок изменён'), onError,
  });
  const recheck = useMutation({
    mutationFn: (p: Party) => docsApi.recheckParty(d.id, p.id, { ...at, dueDate: form.dueDate, comment: comment.trim() || undefined }),
    onSuccess: (r, p) => done(r, `${p.fullName}: согласование запрошено повторно`), onError,
  });
  const remove = useMutation({ mutationFn: (p: Party) => docsApi.removeParty(d.id, p.id, at), onSuccess: (r) => done(r, 'Ответственное лицо снято'), onError });
  const busy = add.isPending || approve.isPending || due.isPending || recheck.isPending || remove.isPending;
  // Справочник «Ответственные лица» — только активные; запрашивается, когда открыта форма добавления (1.6.7).
  const directory = useQuery({ queryKey: dkeys.partyDirectory(d.id), queryFn: () => docsApi.partyDirectory(d.id), enabled: mode?.kind === 'add', staleTime: 30_000 });
  const people = directory.data?.items ?? [];
  const taken = new Set(d.parties.map((p) => personKey(p.fullName, p.department)));

  if (!d.parties.length && !d.can.parties) return null;
  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const daysOk = (v: string) => /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 90;

  return (
    <div aria-label="Ответственные лица">
      <div className="eyebrow">Ответственные лица</div>
      {d.parties.length === 0 && (
        <div className="hint">Пока никого. {onDraft ? 'Лиц можно добавить уже в драфте: срок — в днях, отсчёт начнётся с перехода на «Согласование».' : 'Документ идёт дальше, когда все лица (хотя бы одно) согласовали.'}</div>
      )}
      <div className="hist">
        {d.parties.map((p) => (
          <div key={p.id} className="hist-item" data-party={p.fullName}>
            <div>
              <b>{p.fullName}</b>{p.department && ` · ${p.department}`}
              {/* Строки до 1.4.0: e-mail и пользователь портала — только текстом, в форме их больше нет. */}
              {p.email && <span className="hint"> · {p.email}</span>}
              {p.user && <span className="hint"> · в портале: {p.user.fullName}</span>}
            </div>
            <div className="row">
              {p.dueDays !== null
                ? <span className="mono">срок {p.dueDays} дн. от перехода на «Согласование»</span>
                : <span className={`mono${p.overdue ? ' late-t' : ''}`}>срок {formatDate(p.dueDate)}{p.overdue ? ' — просрочен' : ''}</span>}
              {p.approvedAt
                ? <span className="chip low">согласовал(а) {formatDate(p.approvedOn ?? p.approvedAt.slice(0, 10))}{p.approvedBy ? ` · отметил(а) ${p.approvedBy}` : ''}</span>
                : <span className="chip">ждём ответа</span>}
              {p.reworkedAt && <span className="chip high" data-testid="reworked">до доработки от {formatDate(p.reworkedAt.slice(0, 10))}</span>}
              {!mode && !p.approvedAt && d.can.approveParties && <button type="button" className="btn sm primary" disabled={busy} onClick={() => { setForm({ ...empty, approvedOn: todayIso() }); setMode({ kind: 'approve', party: p }); }}>Отметить согласование</button>}
              {!mode && p.approvedAt && d.can.approveParties && <button type="button" className="btn ghost sm" disabled={busy} onClick={() => { setForm({ ...empty, dueDate: '' }); setMode({ kind: 'recheck', party: p }); }}>Запросить повторно</button>}
              {!mode && !p.approvedAt && d.can.parties && (onDraft || d.can.approveParties) && (
                <button type="button" className="btn ghost sm" disabled={busy} onClick={() => { setForm({ ...empty, dueDate: p.dueDate, dueDays: String(p.dueDays ?? 7) }); setMode({ kind: 'due', party: p }); }}>Срок</button>
              )}
              {!mode && !p.approvedAt && d.can.parties && <button type="button" className="btn ghost sm" disabled={busy} onClick={() => remove.mutate(p)}>Снять</button>}
            </div>
            {p.approveComment && <div className="m">{p.approveComment}</div>}
            {/* Ответы файлами — у документов прежнего маршрута, только просмотр. */}
            {p.files.map((f) => (
              <div key={f.id} className="row">
                <span className="hint">Ответ (прежний маршрут):</span>
                <button type="button" className="btn ghost sm" onClick={() => onPreview({ id: f.file.id, name: f.file.name, mime: f.file.mime, size: f.file.size })}>{f.file.name}</button>
              </div>
            ))}
            {p.rechecks.map((c) => (
              <div key={c.at} className="hint">
                {formatDateTime(c.at)} · {c.actor}: запрошено повторно{c.prevApprovedOn ? ` (согласовал(а) ${formatDate(c.prevApprovedOn)}${c.reworkedAt ? `, до доработки от ${formatDate(c.reworkedAt.slice(0, 10))}` : ''})` : ''}, срок {formatDate(c.toDue)}{c.comment ? ` — ${c.comment}` : ''}
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
            <label>ФИО<PersonCombobox value={form.fullName} onChange={(v) => setForm({ ...form, fullName: v })} people={people} taken={taken}
              onPick={(p) => setForm({ ...form, fullName: p.fullName, department: p.position })} /></label>
            <label>Подразделение или должность<input className="inp" maxLength={300} value={form.department} onChange={set('department')} /></label>
            {onDraft
              ? <label>Срок ответа, дней<input className="inp" type="number" min={1} max={90} required value={form.dueDays} onChange={set('dueDays')} /></label>
              : <label>Срок ответа<input className="inp" type="date" required value={form.dueDate} onChange={set('dueDate')} /></label>}
          </div>
          <div className="hint">
            {people.length ? 'Начните вводить ФИО или должность и выберите из списка. Нет в списке — «Ввести вручную». ' : directory.isSuccess ? 'Справочник «Ответственные лица» пуст — введите ФИО и должность вручную. Список ведут в «Настройки → Справочники». ' : ''}
            {onDraft ? 'Срок в днях начнёт идти, когда начальник ИБ одобрит документ. ' : ''}
            Портал писем не отправляет: документ ответственному лицу отправьте по почте, ответ отметьте здесь.
          </div>
          <div className="row">
            <button className="btn primary" type="submit" disabled={busy || !form.fullName.trim() || (onDraft ? !daysOk(form.dueDays) : !form.dueDate)}>Добавить</button>
            <button className="btn" type="button" onClick={close}>Отмена</button>
          </div>
        </form>
      )}
      {mode?.kind === 'approve' && (
        <form className="task-form" aria-label="Согласование лица" onSubmit={(e) => { e.preventDefault(); approve.mutate(mode.party); }}>
          <div className="hint">{mode.party.fullName}: отметить, что согласовал(а).</div>
          <label>Дата согласования<input className="inp" type="date" required max={todayIso()} value={form.approvedOn} onChange={set('approvedOn')} /></label>
          <label>Комментарий (необязательно)<textarea className="inp" maxLength={4000} placeholder="например, согласовано письмом от 05.11" value={comment} onChange={(e) => setComment(e.target.value)} /></label>
          <div className="row">
            <button className="btn primary" type="submit" disabled={busy || !form.approvedOn}>Согласовал(а)</button>
            <button className="btn" type="button" onClick={close}>Отмена</button>
          </div>
        </form>
      )}
      {mode?.kind === 'recheck' && (
        <form className="task-form" aria-label="Запросить повторно" onSubmit={(e) => { e.preventDefault(); recheck.mutate(mode.party); }}>
          <div className="hint">{mode.party.fullName}: отметка согласования снимется и останется в истории лица.</div>
          <label>Новый срок ответа<input className="inp" type="date" required min={todayIso()} value={form.dueDate} onChange={set('dueDate')} /></label>
          <label>Комментарий (необязательно)<textarea className="inp" maxLength={4000} value={comment} onChange={(e) => setComment(e.target.value)} /></label>
          <div className="row">
            <button className="btn primary" type="submit" disabled={busy || !form.dueDate}>Запросить повторно</button>
            <button className="btn" type="button" onClick={close}>Отмена</button>
          </div>
        </form>
      )}
      {mode?.kind === 'due' && (
        <form className="task-form" aria-label="Срок ответа" onSubmit={(e) => { e.preventDefault(); due.mutate(mode.party); }}>
          {onDraft ? (
            <label>Срок ответа, дней<input className="inp" type="number" min={1} max={90} required value={form.dueDays} onChange={set('dueDays')} /></label>
          ) : (
            <>
              <div className="hint">{mode.party.fullName}: сейчас до {formatDate(mode.party.dueDate)}.</div>
              <label>Новый срок<input className="inp" type="date" required value={form.dueDate} onChange={set('dueDate')} /></label>
              <label>Почему меняется срок<textarea className="inp" required maxLength={4000} value={comment} onChange={(e) => setComment(e.target.value)} /></label>
            </>
          )}
          <div className="row">
            <button className="btn primary" type="submit"
              disabled={busy || (onDraft ? !daysOk(form.dueDays) || Number(form.dueDays) === mode.party.dueDays : !comment.trim() || !form.dueDate || form.dueDate === mode.party.dueDate)}>Изменить срок</button>
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
      <div className="eyebrow">Блокеры{open.length ? <span className="count crit">открыто {open.length}</span> : null}</div>
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
type TrMode = { kind: 'add' } | { kind: 'due' | 'link'; t: Translation } | null;

/**
 * «Перевод» (этап 23, только на нём — замечание владельца): язык, переводчик текстом, срок, ссылка на перевод в
 * OnlyOffice. «На утверждение» — когда у каждого языка есть ссылка. Word и PDF перевода — на «Утверждении».
 */
export function DocumentTranslations({ d, at, onDone, onError, onPreview }: Props) {
  const [mode, setMode] = useState<TrMode>(null);
  const [form, setForm] = useState({ language: '', translatorName: '', dueDate: '', onlyofficeUrl: '' });
  const [comment, setComment] = useState('');
  const close = () => { setMode(null); setForm({ language: '', translatorName: '', dueDate: '', onlyofficeUrl: '' }); setComment(''); };
  const done = async (r: DocResult, text: string) => { close(); await onDone(r, text); };
  const add = useMutation({
    mutationFn: () => docsApi.addTranslation(d.id, { ...at, language: form.language, translatorName: form.translatorName, dueDate: form.dueDate, onlyofficeUrl: form.onlyofficeUrl.trim() || undefined }),
    onSuccess: (r) => done(r, 'Язык перевода добавлен'), onError,
  });
  const due = useMutation({ mutationFn: (t: Translation) => docsApi.updateTranslation(d.id, t.id, { ...at, dueDate: form.dueDate, comment }), onSuccess: (r) => done(r, 'Срок перевода изменён'), onError });
  const link = useMutation({ mutationFn: (t: Translation) => docsApi.updateTranslation(d.id, t.id, { ...at, onlyofficeUrl: form.onlyofficeUrl.trim() }), onSuccess: (r, t) => done(r, `Ссылка на перевод (${t.language}) сохранена`), onError });
  const remove = useMutation({ mutationFn: (t: Translation) => docsApi.removeTranslation(d.id, t.id, at), onSuccess: (r) => done(r, 'Язык снят'), onError });
  const busy = add.isPending || due.isPending || link.isPending || remove.isPending;
  // На «Утверждении» языки — строками файлов утверждения; здесь — раздел этапа 23 и история утверждённых версий.
  if (d.can.approvalFiles) return null;
  if (!d.translations.length && !d.can.translations) return null;
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  return (
    <div aria-label="Перевод">
      <div className="eyebrow">Перевод</div>
      {d.translations.length === 0 && <div className="hint">Языки не указаны: если перевод не нужен, отправьте документ на утверждение.</div>}
      <div className="hist">
        {d.translations.map((t) => (
          <div key={t.id} className="hist-item" data-translation={t.language}>
            <div><b>{t.language}</b>{t.translatorName ? ` · переводчик ${t.translatorName}` : ''}</div>
            <div className="row">
              <span className={`mono${t.overdue ? ' late-t' : ''}`}>срок {formatDate(t.dueDate)}{t.overdue ? ' — просрочен' : ''}</span>
              {t.onlyofficeUrl
                ? <a className="btn ghost sm" href={t.onlyofficeUrl} target="_blank" rel="noopener noreferrer">Перевод в OnlyOffice</a>
                : <span className={`chip${t.done ? ' low' : ''}`}>{t.done ? 'перевод приложен (прежний маршрут)' : 'нет ссылки на перевод'}</span>}
              {!mode && d.can.translations && <button type="button" className="btn sm" disabled={busy} onClick={() => { setForm({ ...form, onlyofficeUrl: t.onlyofficeUrl }); setMode({ kind: 'link', t }); }}>{t.onlyofficeUrl ? 'Изменить ссылку' : 'Добавить ссылку'}</button>}
              {!mode && d.can.translations && <button type="button" className="btn ghost sm" disabled={busy} onClick={() => { setForm({ ...form, dueDate: t.dueDate }); setMode({ kind: 'due', t }); }}>Срок</button>}
              {!mode && d.can.translations && <button type="button" className="btn ghost sm" disabled={busy} onClick={() => remove.mutate(t)}>Снять</button>}
            </div>
            {(t.docx || t.pdf) && (
              <div className="row">
                {t.docx && <button type="button" className="btn ghost sm" onClick={() => t.docx && onPreview(t.docx)}>{t.docx.name}</button>}
                {t.pdf && <button type="button" className="btn ghost sm" onClick={() => t.pdf && onPreview(t.pdf)}>{t.pdf.name}</button>}
              </div>
            )}
            {t.files.map((f) => (
              <div key={f.id} className="row">
                <span className="hint">Файл (прежний маршрут):</span>
                <button type="button" className="btn ghost sm" onClick={() => onPreview({ id: f.file.id, name: f.file.name, mime: f.file.mime, size: f.file.size })}>{f.file.name}</button>
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
            <label>Переводчик (необязательно)<input className="inp" maxLength={200} placeholder="ФИО или организация" value={form.translatorName} onChange={set('translatorName')} /></label>
            <label>Срок перевода<input className="inp" type="date" required value={form.dueDate} onChange={set('dueDate')} /></label>
            <label>Ссылка на перевод в OnlyOffice (можно позже)<input className="inp" type="url" maxLength={2000} placeholder="https://" value={form.onlyofficeUrl} onChange={set('onlyofficeUrl')} /></label>
          </div>
          <div className="row">
            <button className="btn primary" type="submit" disabled={busy || !form.language.trim() || !form.dueDate}>Добавить</button>
            <button className="btn" type="button" onClick={close}>Отмена</button>
          </div>
        </form>
      )}
      {mode?.kind === 'link' && (
        <form className="task-form" aria-label="Ссылка на перевод" onSubmit={(e) => { e.preventDefault(); link.mutate(mode.t); }}>
          <label>Ссылка на перевод ({mode.t.language}) в OnlyOffice<input className="inp" type="url" required maxLength={2000} placeholder="https://" value={form.onlyofficeUrl} onChange={set('onlyofficeUrl')} /></label>
          <div className="row">
            <button className="btn primary" type="submit" disabled={busy || !form.onlyofficeUrl.trim() || form.onlyofficeUrl.trim() === mode.t.onlyofficeUrl}>Сохранить ссылку</button>
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
    </div>
  );
}
