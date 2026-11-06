// Блок задачи учебного письма в карточке (1.9.0, ADR-0040; docs/specs/awareness.md, раздел 19.5): правило, плановая
// дата, письмо и этапы «черновик → согласование → отправка». Этапы следуют за письмом, отметить вручную нельзя.
// Письмо отмечено отправленным, а задача открыта — подсказка завершить её по обычным правилам проверки.
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Task } from '../../api/tasks';
import { STAGE_LABEL } from './logic';

const ru = (iso: string) => iso.split('-').reverse().join('.');
const STATUS: Record<string, string> = { draft: 'черновик', review: 'на согласовании', approved: 'утверждено', sent: 'отправлено' };

export const letterHref = (id: string) => `/awareness/letters?letter=${id}`;

export function TaskOriginBlock({ task, actions }: { task: Pick<Task, 'origin' | 'completedAt'>; actions?: ReactNode }) {
  const o = task.origin;
  if (!o) return null;
  // Задача автоматизации контроля документа (1.11.0, ADR-0043): документ, автоматизация, механизм контроля.
  if (o.kind === 'document_control') {
    return (
      <div className="chain-block aw-origin" aria-label="Контроль по документу" data-testid="task-origin">
        <div className="eyebrow">Контроль по документу</div>
        <div className="row">
          <Link to={`/documents?doc=${o.document.id}`}>Документ #{o.document.number} «{o.document.title}»</Link>
          <span className="muted">запуск {ru(o.nominalDate)}</span>
        </div>
        <div className="row"><span>Автоматизация «{o.automation.title}»</span></div>
        {o.control && <div className="row"><span className="muted">Механизм контроля {o.control.position}: {o.control.requirement}</span></div>}
      </div>
    );
  }
  const sentHint = o.letterSent && !task.completedAt
    ? <div className="note aw-hint" role="status">Письмо отправлено — завершите задачу</div>
    : null;
  const letterLine = o.letter
    ? <Link to={letterHref(o.letter.id)}>Учебное письмо № {o.letter.number}</Link>
    : null;

  if (o.kind === 'letter') {
    return (
      <div className="chain-block aw-origin" aria-label="Учебное письмо" data-testid="task-origin">
        <div className="eyebrow">{o.reason === 'urgent' ? 'Срочная рассылка' : 'Доработка письма'}</div>
        <div className="row">{letterLine}<span className="muted">{STATUS[o.letter.status] ?? o.letter.status}</span></div>
        {sentHint}
      </div>
    );
  }
  return (
    <div className="chain-block aw-origin" aria-label="Рассылка" data-testid="task-origin">
      <div className="eyebrow">Рассылка по расписанию</div>
      <div className="row"><span>Правило «{o.rule.title}»</span><span className="muted">отправка {ru(o.plannedDate)}</span></div>
      <ol className="aw-stages" aria-label="Этапы">
        {o.stages.map((s) => (
          <li key={s.key} className={s.done ? 'done' : s.overdue ? 'late' : ''} data-testid={`stage-${s.key}`}>
            <span className="aw-mark" aria-hidden="true">{s.done ? '✓' : s.overdue ? '!' : '·'}</span>
            <span className="grow">{STAGE_LABEL[s.key]}</span>
            <span className="mono">{s.done ? 'выполнен' : `${s.overdue ? 'просрочен, ' : 'до '}${ru(s.due)}`}</span>
          </li>
        ))}
      </ol>
      {letterLine
        ? <div className="row">{letterLine}<span className="muted">{o.letter ? STATUS[o.letter.status] ?? o.letter.status : ''}</span></div>
        : <div className="muted">Письма пока нет{actions ? '' : ' — создайте его в разделе «Осведомлённость»'}</div>}
      {!o.letter && actions}
      {sentHint}
    </div>
  );
}
