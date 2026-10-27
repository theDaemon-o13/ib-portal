// Автоматизации «условие → действие» (этап 4): чистые функции проверки условия без БД.
// До появления задач (этап 5) действие — событие в automation_events.
import { workingDaysBetween, parseIsoDate, type WorkCalendar } from '../../lib/working-days.js';
import { addDays, type StoredValue, type Values } from '../../lib/register-values.js';

export const CONDITION_KINDS = ['before', 'overdue', 'equals'] as const;
export const EVENT_TYPES = ['remind', 'notify', 'escalate'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_TYPE_NAMES: Record<EventType, string> = {
  remind: 'Напомнить',
  notify: 'Уведомить',
  escalate: 'Эскалация',
};

export type Condition =
  /** За N календарных дней до даты (и до самой даты включительно). */
  | { kind: 'before'; fieldId: string; days: number }
  /**
   * Дата просрочена: сегодня позже даты. С workdays — просрочка не меньше N рабочих дней по календарю РТ;
   * с unlessFilledFieldId — только пока это поле пустое (п. 7.4: «мер нет 10 рабочих дней»).
   */
  | { kind: 'overdue'; fieldId: string; workdays?: number | null; unlessFilledFieldId?: string | null }
  /** Поле-список равно значению. */
  | { kind: 'equals'; fieldId: string; optionId: string };

export type Recipient = { kind: 'field'; fieldId: string } | { kind: 'label'; label: string };

export interface Action {
  eventType: EventType;
  recipients: Recipient[];
}

export interface RecordView {
  values: Values;
  /** Дата поля (хранимая или вычисленный срок) — 'YYYY-MM-DD' или null. */
  dateOf: (fieldId: string) => string | null;
}

export interface Trigger {
  /** Что сработало: дата срока или id значения. Повторная проверка с тем же ключом события не создаёт. */
  triggerKey: string;
}

const filled = (v: StoredValue | undefined) => v !== undefined && v !== null && String(v).trim() !== '';

/** Сработало ли условие для записи на дату today ('YYYY-MM-DD'). */
export function evaluate(cond: Condition, rec: RecordView, today: string, calendar: WorkCalendar): Trigger | null {
  switch (cond.kind) {
    case 'before': {
      const date = rec.dateOf(cond.fieldId);
      if (!date) return null;
      // Окно напоминания: [дата − N; дата]. Уже просроченное — дело правила «просрочено».
      return today >= addDays(date, -cond.days) && today <= date ? { triggerKey: date } : null;
    }
    case 'overdue': {
      const date = rec.dateOf(cond.fieldId);
      if (!date || today <= date) return null;
      if (cond.unlessFilledFieldId && filled(rec.values[cond.unlessFilledFieldId])) return null;
      if (cond.workdays && workingDaysBetween(parseIsoDate(date), parseIsoDate(today), calendar) < cond.workdays) return null;
      return { triggerKey: date };
    }
    case 'equals':
      return rec.values[cond.fieldId] === cond.optionId ? { triggerKey: cond.optionId } : null;
  }
}
