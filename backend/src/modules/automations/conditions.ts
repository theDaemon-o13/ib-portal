// Автоматизации «условие → действие» (этап 4): чистые функции проверки условия без БД.
// Действие — событие в automation_events; с этапа 5 событие превращается в задачи получателям.
import { workingDaysBetween, parseIsoDate, type WorkCalendar } from '../../lib/working-days.js';
import { addDays, type StoredValue, type Values } from '../../lib/register-values.js';

export const CONDITION_KINDS = ['before', 'overdue', 'equals', 'yearly', 'basis_missing'] as const;
export const EVENT_TYPES = ['remind', 'notify', 'escalate'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_TYPE_NAMES: Record<EventType, string> = {
  remind: 'Напомнить',
  notify: 'Уведомить',
  escalate: 'Эскалация',
};

export type Condition =
  /**
   * За N календарных дней до даты (и до самой даты включительно). skipYearEnd — кроме дат 31.12
   * (этап 8б: разрешения до конца года продлевает правило 1 декабря).
   */
  | { kind: 'before'; fieldId: string; days: number; skipYearEnd?: boolean }
  /**
   * Дата просрочена: сегодня позже даты. С workdays — просрочка не меньше N рабочих дней по календарю РТ;
   * с unlessFilledFieldId — только пока это поле пустое (п. 7.4: «мер нет 10 рабочих дней»).
   */
  | { kind: 'overdue'; fieldId: string; workdays?: number | null; unlessFilledFieldId?: string | null }
  /** Поле-список равно значению. */
  | { kind: 'equals'; fieldId: string; optionId: string }
  /**
   * Ежегодно в день ДД.ММ (этап 8б): одна сводная задача по реестру со списком открытых записей
   * (statusOptionIds — только с этими статусами). Не сработало в тот день (сервер стоял) — догоняет в течение недели.
   */
  | { kind: 'yearly'; month: number; day: number; statusOptionIds?: string[] }
  /** Канал открыт, а действующего основания нет (вычисляемое поле link_basis: none или expired). */
  | { kind: 'basis_missing'; fieldId: string };

/**
 * Получатель правила: поле-сотрудник записи, метка справочника «Получатели уведомлений»
 * или сотрудник портала (имя — на момент сохранения правила, для описания).
 */
export type Recipient =
  | { kind: 'field'; fieldId: string }
  /** Метка по id значения справочника (ADR-0005); label — название на момент сохранения, для старых версий. */
  | { kind: 'label'; itemId?: string | null; label?: string }
  | { kind: 'user'; userId: string; name?: string };

/** Действие «задача»: событие → задачи получателям. title — свой заголовок задачи ({год} — следующий год). */
export interface TaskAction {
  eventType: EventType;
  recipients: Recipient[];
  title?: string;
}

/**
 * Действие «установить значение» (этап 8б: 1 января — «Истекло»): поле-список записи получает значение,
 * если сейчас у него одно из fromOptionIds. Задачи нет; изменение — в истории записи и журнале (автор — система).
 */
export interface SetOptionAction {
  eventType: 'set_option';
  fieldId: string;
  optionId: string;
  fromOptionIds: string[];
  recipients: [];
}

export type Action = TaskAction | SetOptionAction;

export function isSetOption(a: Action): a is SetOptionAction {
  return a.eventType === 'set_option';
}

export interface RecordView {
  values: Values;
  /** Дата поля (хранимая или вычисленный срок) — 'YYYY-MM-DD' или null. */
  dateOf: (fieldId: string) => string | null;
  /** Статус основания (link_basis): состояние, разрешение и значение канала. */
  basisOf?: (fieldId: string) => { state: string; permissionId: string | null; channel: string } | null;
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
      if (cond.skipYearEnd && date.slice(5) === '12-31') return null;
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
    case 'basis_missing': {
      // Ключ — значение канала и разрешение: то же состояние повторно событий не даёт, новое открытие канала или
      // истечение другого разрешения — новое событие.
      const b = rec.basisOf?.(cond.fieldId);
      if (!b || (b.state !== 'none' && b.state !== 'expired')) return null;
      return { triggerKey: `${b.channel}:${b.state}:${b.permissionId ?? '-'}` };
    }
    case 'yearly':
      return null; // сводное условие — evaluateYearly
  }
}

/** Окно догоняющего срабатывания ежегодного условия, дней. */
export const YEARLY_WINDOW_DAYS = 7;

/** Ежегодное условие на дату today: ключ — «ГГГГ-ММ-ДД» дня срабатывания этого года. */
export function evaluateYearly(cond: Extract<Condition, { kind: 'yearly' }>, today: string): Trigger | null {
  const date = `${today.slice(0, 4)}-${String(cond.month).padStart(2, '0')}-${String(cond.day).padStart(2, '0')}`;
  return today >= date && today < addDays(date, YEARLY_WINDOW_DAYS) ? { triggerKey: date } : null;
}

/** Заголовок сводной задачи: {год} — следующий год от дня срабатывания. */
export function digestTitle(template: string, triggerKey: string): string {
  return template.replace(/\{год\}/g, String(Number(triggerKey.slice(0, 4)) + 1));
}
