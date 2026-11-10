// Ответственные лица (драфт и «Согласование»), переводы («Перевод») и блокеры документа — маршрут 1.11.0, ADR-0042.
// Решает всегда backend: кнопки видны по d.can, ошибки — через onError карточки.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { dkeys, docsApi, type At, type DocDetail, type DocResult } from '../../api/documents';
import { formatDate } from '../registers/logic';
import { formatDateTime } from '../settings/logic';
import { todayLocal as todayIso } from '../tasks/logic';
import { CopyButton, useCopy } from '../../components/CopyButton';
import { MultiSelect, type MsOption } from '../../components/MultiSelect';
import { matchPerson, personKey } from './logic';
import { addLabel, BATCH_MAX, buildBatch, emailOk, type ManualRow } from './party-batch';

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

type PartyMode = { kind: 'add' } | { kind: 'approve' | 'due' | 'recheck' | 'email'; party: Party } | null;

let rowSeq = 0;
const newRow = (): ManualRow => ({ key: `r${++rowSeq}`, fullName: '', department: '', email: '' });

/**
 * «Добавить ответственных лиц» (1.13.5): несколько человек за раз с одним сроком — из справочника «Ответственные лица»
 * (MultiSelect: поиск по ФИО и должности, чипы) и строками ручного ввода. Один человек — тот же путь. Уже добавленные
 * в документ — в списке с пометкой «уже добавлен», не выбираются; повторы подсвечиваются у строки (окончательно —
 * сервер, 409 PARTY_DUPLICATE). После добавления каждый — отдельное лицо со своим сроком.
 */
function AddPartiesForm({ d, at, onDraft, busy, onCancel, onDone, onError }: {
  d: DocDetail; at: At; onDraft: boolean; busy: boolean; onCancel: () => void; onDone: Done; onError: (e: unknown) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [manual, setManual] = useState<ManualRow[]>([]);
  const [dueDate, setDueDate] = useState('');
  const [dueDays, setDueDays] = useState('7');
  // Справочник — только активные (1.6.7).
  const directory = useQuery({ queryKey: dkeys.partyDirectory(d.id), queryFn: () => docsApi.partyDirectory(d.id), staleTime: 30_000 });
  const people = directory.data?.items ?? [];
  const emptyDirectory = directory.isSuccess && people.length === 0;
  // Справочник пуст — сразу строка ручного ввода.
  useEffect(() => { if (emptyDirectory) setManual((m) => (m.length ? m : [newRow()])); }, [emptyDirectory]);

  const taken = new Set(d.parties.map((p) => personKey(p.fullName, p.department)));
  const options: MsOption[] = people.map((p) => ({
    // Вторая строка пункта — должность и почта (1.13.6); поиск — по всем трём.
    value: p.id, label: p.fullName, hint: [p.position, p.email].filter(Boolean).join(' · '), disabled: taken.has(personKey(p.fullName, p.position)), note: 'уже добавлен',
  }));
  const byId = new Map(people.map((p) => [p.id, p]));
  const pickedPeople = picked.map((id) => byId.get(id)).filter((p): p is (typeof people)[number] => !!p);
  const batch = buildBatch(pickedPeople, manual, taken);
  const dueOk = onDraft ? /^\d+$/.test(dueDays) && Number(dueDays) >= 1 && Number(dueDays) <= 90 : !!dueDate;
  const n = batch.people.length;

  const add = useMutation({
    mutationFn: () => docsApi.addParties(d.id, { ...at, people: batch.people, ...(onDraft ? { dueDays: Number(dueDays) } : { dueDate }) }),
    onSuccess: (r) => onDone(r, n === 1 ? 'Ответственное лицо добавлено' : `Добавлено ответственных лиц: ${n}`), onError,
  });
  const setRow = (key: string, patch: Partial<ManualRow>) => setManual((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  return (
    <form className="task-form party-add" aria-label="Добавить ответственных лиц" onSubmit={(e) => { e.preventDefault(); if (batch.ok && dueOk) add.mutate(); }}>
      {people.length > 0 && (
        <div className="party-pick">
          <span className="party-lbl" id={`pick-${d.id}`}>Из справочника</span>
          <MultiSelect
            options={options} selected={picked} onChange={setPicked} max={BATCH_MAX - batch.people.length + pickedPeople.length}
            label="Выбрать из справочника" listLabel="Ответственные лица из справочника" chipsLabel="Выбраны из справочника" testId="party-pick"
            match={(o, q) => matchPerson({ fullName: o.label, position: o.hint ?? '' }, q)}
          />
        </div>
      )}
      {manual.length > 0 && (
        <div className="party-rows" aria-label="Введены вручную">
          {manual.map((r, i) => (
            <div key={r.key} className={`party-row${batch.rowErrors[r.key] ? ' bad' : ''}`} data-row={i + 1}>
              <label>ФИО<input className="inp" maxLength={300} value={r.fullName} aria-invalid={!!batch.rowErrors[r.key] || undefined} onChange={(e) => setRow(r.key, { fullName: e.target.value })} /></label>
              <label>Подразделение или должность<input className="inp" maxLength={300} value={r.department} onChange={(e) => setRow(r.key, { department: e.target.value })} /></label>
              <label>Почта<input className="inp" type="email" inputMode="email" autoComplete="off" maxLength={254} placeholder="необязательно" value={r.email ?? ''}
                aria-invalid={!emailOk(r.email ?? '') || undefined} onChange={(e) => setRow(r.key, { email: e.target.value })} /></label>
              <button type="button" className="btn ghost sm party-row-x" aria-label={`Удалить строку ${i + 1}`} title="Удалить строку" onClick={() => setManual((rows) => rows.filter((x) => x.key !== r.key))}>×</button>
              {batch.rowErrors[r.key] && <div className="form-error party-row-err" role="alert">{batch.rowErrors[r.key]}</div>}
            </div>
          ))}
        </div>
      )}
      <div className="row"><button type="button" className="btn ghost sm" onClick={() => setManual((rows) => [...rows, newRow()])}>+ Добавить вручную</button></div>
      <div className="fgrid">
        {onDraft
          ? <label>Срок ответа, дней<input className="inp" type="number" min={1} max={90} required value={dueDays} onChange={(e) => setDueDays(e.target.value)} /></label>
          : <label>Срок ответа<input className="inp" type="date" required value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></label>}
      </div>
      <div className="hint">
        {emptyDirectory ? 'Справочник «Ответственные лица» пуст — введите ФИО и должность вручную. Список ведут в «Настройки → Справочники». ' : ''}
        Срок — один для всех в этой форме; потом у каждого он свой: перенести можно отдельно.
        {onDraft ? ' Срок в днях начнёт идти, когда начальник ИБ одобрит документ.' : ''}
        {' '}Портал писем не отправляет: документ ответственным лицам отправьте по почте, ответы отметьте здесь.
        {n > BATCH_MAX ? ` За один раз — не больше ${BATCH_MAX} человек.` : ''}
      </div>
      <div className="row">
        <button className="btn primary" type="submit" disabled={busy || add.isPending || !batch.ok || !dueOk}>{addLabel(n)}</button>
        <button className="btn" type="button" onClick={onCancel}>Отмена</button>
      </div>
    </form>
  );
}

// Ответственное лицо — внешний человек: ФИО, подразделение или должность, срок. В драфте (21) срок — днями от перехода на
// «Согласование» (решение владельца 11), на «Согласовании» (22) — датой; отметка — дата согласования и комментарий, без файла.
const empty = { dueDate: '', dueDays: '7', approvedOn: '', email: '' };

/** «Копировать все ФИО / должности / почты» (1.13.6): по строке на значение в порядке списка, пустые пропущены. */
function CopyAll({ parties }: { parties: Party[] }) {
  const copy = useCopy();
  if (!parties.length) return null;
  const mails = parties.filter((p) => p.email.trim()).length;
  return (
    <div className="row copy-all" role="group" aria-label="Копировать для титульного листа">
      <button type="button" className="btn ghost sm" onClick={() => void copy(parties.map((p) => p.fullName), 'ФИО')}>Копировать все ФИО</button>
      <button type="button" className="btn ghost sm" onClick={() => void copy(parties.map((p) => p.department), 'должностей нет')}>Копировать все должности</button>
      <button type="button" className="btn ghost sm" disabled={!mails} title={mails ? undefined : 'Почта не указана ни у кого'} onClick={() => void copy(parties.map((p) => p.email), 'почты нет')}>Копировать все почты</button>
    </div>
  );
}

export function DocumentParties({ d, at, onDone, onError, onPreview }: Props) {
  const [mode, setMode] = useState<PartyMode>(null);
  const [form, setForm] = useState(empty);
  const [comment, setComment] = useState('');
  const onDraft = d.working?.stage === 21;

  const close = () => { setMode(null); setForm(empty); setComment(''); };
  const done = async (r: DocResult, text: string) => { close(); await onDone(r, text); };
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
  const email = useMutation({
    mutationFn: (p: Party) => docsApi.updateParty(d.id, p.id, { ...at, email: form.email.trim() }),
    onSuccess: (r, p) => done(r, form.email.trim() ? `${p.fullName}: почта сохранена` : `${p.fullName}: почта убрана`), onError,
  });
  const busy = approve.isPending || due.isPending || recheck.isPending || remove.isPending || email.isPending;

  if (!d.parties.length && !d.can.parties) return null;
  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const daysOk = (v: string) => /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 90;

  return (
    <div aria-label="Ответственные лица">
      <div className="eyebrow">Ответственные лица</div>
      {d.parties.length === 0 && (
        <div className="hint">Пока никого. {onDraft ? 'Лиц можно добавить уже в драфте: срок — в днях, отсчёт начнётся с перехода на «Согласование».' : 'Документ идёт дальше, когда все лица (хотя бы одно) согласовали.'}</div>
      )}
      <CopyAll parties={d.parties} />
      <div className="hist">
        {d.parties.map((p) => (
          <div key={p.id} className="hist-item" data-party={p.fullName}>
            {/* ФИО, должность и почта — каждое со своей кнопкой «Копировать» (1.13.6, титульный лист в OnlyOffice). */}
            <div className="pf-list">
              <span className="pf"><b className="pf-v" data-field="name">{p.fullName}</b><CopyButton what="ФИО" value={p.fullName} /></span>
              {p.department && <span className="pf"><span className="pf-v" data-field="position">{p.department}</span><CopyButton what="должность" value={p.department} /></span>}
              {p.email && <span className="pf"><span className="pf-v pf-mail" data-field="email">{p.email}</span><CopyButton what="почту" value={p.email} /></span>}
              {/* Строки до 1.4.0: пользователь портала — только текстом. */}
              {p.user && <span className="hint">в портале: {p.user.fullName}</span>}
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
              {!mode && d.can.parties && <button type="button" className="btn ghost sm" disabled={busy} onClick={() => { setForm({ ...empty, email: p.email }); setMode({ kind: 'email', party: p }); }}>Почта</button>}
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
      {!mode && d.can.parties && <div className="row"><button type="button" className="btn sm" onClick={() => setMode({ kind: 'add' })}>Добавить ответственных лиц</button></div>}

      {mode?.kind === 'add' && <AddPartiesForm d={d} at={at} onDraft={onDraft} busy={busy} onCancel={close} onDone={done} onError={onError} />}
      {mode?.kind === 'email' && (
        <form className="task-form" aria-label="Почта лица" onSubmit={(e) => { e.preventDefault(); email.mutate(mode.party); }}>
          <div className="hint">{mode.party.fullName}: почта для титульного листа. Портал писем не отправляет. Изменение попадёт в журнал.</div>
          <label>Почта<input className="inp" type="email" inputMode="email" autoComplete="off" maxLength={254} autoFocus placeholder="ivanov@example.com" value={form.email}
            aria-invalid={!emailOk(form.email) || undefined} onChange={set('email')} /></label>
          {!emailOk(form.email) && <div className="form-error" role="alert">Почта — в виде ivanov@example.com</div>}
          <div className="row">
            <button className="btn primary" type="submit" disabled={busy || !emailOk(form.email) || form.email.trim().toLowerCase() === mode.party.email}>Сохранить</button>
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
