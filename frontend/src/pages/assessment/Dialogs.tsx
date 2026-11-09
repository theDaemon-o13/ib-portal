// Окна раздела «Самооценка»: новая оценка, возврат в черновик, шапка и профиль, архив.
import { useState, type FormEvent, type ReactNode } from 'react';
import { assessmentsApi, type Assessment, type AssessmentSummary, type Profile } from '../../api/assessments';
import { Overlay } from '../../components/Overlay';
import { defaultTitle } from './logic';
import { useAssessmentAction } from './useAssessmentAction';
import { Select } from '../../components/Select';

function todayIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function Modal({ title, onClose, onSubmit, busy, submit, children, wide }: {
  title: string; onClose: () => void; onSubmit: () => void; busy: boolean; submit: string; children: ReactNode; wide?: boolean;
}) {
  const send = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };
  return (
    <Overlay>
      <div className="backdrop" role="presentation" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
        <form className={`modal panel${wide ? ' wide-modal' : ''}`} role="dialog" aria-modal="true" aria-label={title} onSubmit={send}>
          <h2>{title}</h2>
          {children}
          <div className="row end">
            <button className="btn" type="button" onClick={onClose} disabled={busy}>Отмена</button>
            <button className="btn primary" type="submit" disabled={busy}>{submit}</button>
          </div>
        </form>
      </div>
    </Overlay>
  );
}

/** Новая оценка: пустая или копия последней зафиксированной (баллы и цели переносятся, комментарии — нет). */
export function NewAssessmentDialog({ items, onClose, onCreated }: { items: readonly AssessmentSummary[]; onClose: () => void; onCreated: (a: Assessment) => void }) {
  const lastFinal = items.find((x) => x.finalizedAt !== null && x.status !== 'draft');
  const [assessedOn, setDate] = useState(todayIso());
  const [title, setTitle] = useState(defaultTitle(todayIso()));
  const [copyFromId, setCopy] = useState(lastFinal?.id ?? '');
  const create = useAssessmentAction(
    () => assessmentsApi.create({ title: title.trim(), assessedOn, ...(copyFromId ? { copyFromId } : {}) }),
    (a) => `Оценка «${a.title}» создана`,
    (a) => {
      onCreated(a);
      onClose();
    },
  );
  return (
    <Modal title="Новая оценка" onClose={onClose} onSubmit={() => create.mutate(undefined)} busy={create.isPending} submit="Создать">
      <label className="fd-label">Название<input className="inp" required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <label className="fd-label">Дата проведения<input className="inp" type="date" required value={assessedOn} onChange={(e) => setDate(e.target.value)} /></label>
      <label className="fd-label">Начать с
        <Select className="inp" value={copyFromId} onChange={(e) => setCopy(e.target.value)}>
          {lastFinal && <option value={lastFinal.id}>Копии «{lastFinal.title}» (баллы и цели)</option>}
          <option value="">Пустого чек-листа</option>
        </Select>
      </label>
      {copyFromId && <p className="hint">Комментарии к ответам не копируются.</p>}
    </Modal>
  );
}

/** Вернуть в черновик: итог снова считается на лету, действие — в журнале оценки. */
export function ReopenDialog({ a, onClose }: { a: Assessment; onClose: () => void }) {
  const [comment, setComment] = useState('');
  const reopen = useAssessmentAction(
    () => assessmentsApi.reopen(a.id, a.version, comment.trim()),
    () => 'Оценка возвращена в черновик',
    onClose,
  );
  return (
    <Modal title="Вернуть оценку в черновик" onClose={onClose} onSubmit={() => reopen.mutate(undefined)} busy={reopen.isPending} submit="Вернуть в черновик">
      <label className="fd-label">Комментарий (необязательно)
        <textarea className="inp" rows={3} maxLength={4000} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Например: уточнить раздел 6.3 после аудита" />
      </label>
      <p className="hint">Итог перестанет быть зафиксированным. Действие попадёт в журнал оценки.</p>
    </Modal>
  );
}

/** Шапка и профиль оценки (только черновик). Флажки отрасли, стажа и численности КБ из Excel — здесь вручную. */
export function ProfileDialog({ a, onClose }: { a: Assessment; onClose: () => void }) {
  const [title, setTitle] = useState(a.title);
  const [assessedOn, setDate] = useState(a.assessedOn);
  const [p, setP] = useState<Profile>({ ...a.profile });
  const [industries, setIndustries] = useState((a.profile.industries ?? []).join(', '));
  const [employees, setEmployees] = useState(a.profile.employees == null ? '' : String(a.profile.employees));
  const save = useAssessmentAction(
    () => assessmentsApi.update(a.id, {
      version: a.version, title: title.trim(), assessedOn,
      profile: {
        ...p,
        industries: industries.split(',').map((x) => x.trim()).filter(Boolean),
        employees: employees.trim() ? Number(employees) : null,
      },
    }),
    () => 'Профиль сохранён',
    onClose,
  );
  const text = (key: 'organization' | 'respondent' | 'position' | 'kbExperience' | 'kbStaff', label: string) => (
    <label className="fd-label">{label}
      <input className="inp" maxLength={300} value={p[key] ?? ''} onChange={(e) => setP({ ...p, [key]: e.target.value })} />
    </label>
  );
  return (
    <Modal title="Оценка и профиль" onClose={onClose} onSubmit={() => save.mutate(undefined)} busy={save.isPending} submit="Сохранить" wide>
      <div className="sa-form">
        <label className="fd-label">Название<input className="inp" required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="fd-label">Дата проведения<input className="inp" type="date" required value={assessedOn} onChange={(e) => setDate(e.target.value)} /></label>
        {text('organization', 'Организация')}
        {text('respondent', 'Респондент')}
        {text('position', 'Должность')}
        <label className="fd-label">Численность сотрудников
          <input className="inp" type="number" min={0} step={1} value={employees} onChange={(e) => setEmployees(e.target.value)} />
        </label>
        <label className="fd-label">Отрасли (через запятую)<input className="inp" value={industries} onChange={(e) => setIndustries(e.target.value)} /></label>
        {text('kbExperience', 'Стаж функции КБ')}
        {text('kbStaff', 'Численность функции КБ')}
      </div>
    </Modal>
  );
}

/** В архив: удаления нет, архивная оценка остаётся в истории и в сравнении. */
export function ArchiveDialog({ target, onClose }: { target: { id: string; title: string; version: number }; onClose: () => void }) {
  const archive = useAssessmentAction(
    () => assessmentsApi.archive(target.id, target.version),
    (a) => `Оценка «${a.title}» в архиве`,
    onClose,
  );
  return (
    <Modal title="Отправить оценку в архив?" onClose={onClose} onSubmit={() => archive.mutate(undefined)} busy={archive.isPending} submit="В архив">
      <p>«{target.title}» перестанет показываться в выборе оценки. Удаления нет: оценка останется в истории и в сравнении.</p>
    </Modal>
  );
}
