// Статусы учебного письма (1.9.0, ADR-0039; docs/specs/awareness.md, разделы 13–14). Без БД: сервис передаёт
// состояние письма и действующего пользователя, здесь — только решение «можно ли» и что меняется.
// Черновик → На согласовании → Утверждено → Отправлено; отправленное заморожено (дублируется триггером в БД).
import { AppError } from '../../lib/errors.js';
import { htmlToText } from './export/text.js';
import { SIGNATURE_BLOCK, type TemplateTexts } from './variables.js';

export const LETTER_STATUSES = ['draft', 'review', 'approved', 'sent'] as const;
export type LetterStatus = (typeof LETTER_STATUSES)[number];
export const LETTER_KINDS = ['planned', 'urgent'] as const;
export type LetterKind = (typeof LETTER_KINDS)[number];
export type LangMark = 'only_ru' | 'only_tj' | null;

export const STATUS_NAMES: Record<LetterStatus, string> = {
  draft: 'Черновик', review: 'На согласовании', approved: 'Утверждено', sent: 'Отправлено',
};
export const LANG_MARK_TEXT: Record<Exclude<LangMark, null>, string> = { only_ru: 'только RU', only_tj: 'только TJ' };

export const AUDIENCE_MAX = 500;
export const COMMENT_MAX = 2000;

export interface LetterState {
  status: LetterStatus;
  kind: LetterKind;
  frozen: boolean;
  archived: boolean;
  createdBy: string;
  /** Кто отправил на согласование (последнее событие submitted). */
  submittedBy: string | null;
  /** Последняя версия совпадает с утверждённой. */
  latestIsApproved: boolean;
}

/** Действующий пользователь. isIbHead — активная отметка «Является начальником ИБ» (ADR-0027). */
export interface LetterActor {
  id: string;
  isIbHead: boolean;
}

const state = (code: string, message: string) => new AppError(409, code, message);

function assertLive(s: LetterState): void {
  if (s.archived) throw state('LETTER_ARCHIVED', 'Письмо в архиве. Верните его из архива, чтобы продолжить');
  if (s.frozen) throw state('LETTER_FROZEN', 'Письмо отправлено — его нельзя изменить. Создайте копию');
}

// ——— Языки (ответ 9) ———

const hasText = (html: string) => /<img\s/i.test(html) || htmlToText(html.split(SIGNATURE_BLOCK).join('')).trim().length > 0;

/** Заполнен ли язык: «full» — и тема, и текст; «half» — только одно; «empty» — ничего. */
export function langFill(subject: string, html: string): 'full' | 'half' | 'empty' {
  const s = subject.trim().length > 0;
  const t = hasText(html);
  return s && t ? 'full' : s || t ? 'half' : 'empty';
}

/**
 * Плановому письму обязательны оба языка, срочному — хотя бы один. Половина языка (только тема или только текст) —
 * всегда ошибка. Возвращает пометку одноязычного срочного письма.
 */
export function checkLanguages(kind: LetterKind, v: TemplateTexts): LangMark {
  const ru = langFill(v.subjectRu, v.htmlRu);
  const tj = langFill(v.subjectTj, v.htmlTj);
  const half = [ru === 'half' ? 'русском' : null, tj === 'half' ? 'таджикском' : null].filter(Boolean);
  if (half.length) throw new AppError(400, 'LANG_REQUIRED', `Заполните и тему, и текст на ${half.join(' и ')}`);
  if (kind === 'planned' && (ru !== 'full' || tj !== 'full')) {
    throw new AppError(400, 'LANG_REQUIRED', 'Плановому письму нужны тема и текст на русском и таджикском');
  }
  if (ru === 'empty' && tj === 'empty') throw new AppError(400, 'LANG_REQUIRED', 'Заполните тему и текст хотя бы на одном языке');
  return ru === 'empty' ? 'only_tj' : tj === 'empty' ? 'only_ru' : null;
}

// ——— Переходы ———

/** Можно ли сохранить новое содержимое. Утверждённое — только с подтверждением: утверждение снимается. */
export function assertEditable(s: LetterState, confirmDropApproval = false): { dropsApproval: boolean } {
  assertLive(s);
  if (s.status === 'review') throw state('LETTER_STATE', 'Письмо на согласовании. Чтобы изменить его, отзовите письмо');
  if (s.status === 'approved') {
    if (!confirmDropApproval) throw state('APPROVAL_DROP_CONFIRM', 'Письмо утверждено. Если изменить его, утверждение будет снято');
    return { dropsApproval: true };
  }
  return { dropsApproval: false };
}

/** На согласование: только черновик, без незаполненных переменных, с нужными языками. */
export function submit(s: LetterState, v: TemplateTexts, unfilled: readonly string[]): { langMark: LangMark } {
  assertLive(s);
  if (s.status !== 'draft') throw state('LETTER_STATE', `На согласование отправляется черновик, а письмо — «${STATUS_NAMES[s.status]}»`);
  if (unfilled.length) throw new AppError(400, 'UNFILLED_VARIABLES', `Заполните переменные: ${unfilled.map((u) => `«${u}»`).join(', ')}`);
  return { langMark: checkLanguages(s.kind, v) };
}

/** Отозвать с согласования: тот, кто отправил, или автор. */
export function withdraw(s: LetterState, actor: LetterActor): void {
  assertLive(s);
  if (s.status !== 'review') throw state('LETTER_STATE', 'Письмо не на согласовании');
  if (actor.id !== s.submittedBy && actor.id !== s.createdBy) {
    throw new AppError(403, 'LETTER_FORBIDDEN', 'Отозвать письмо может тот, кто отправил его на согласование, или автор');
  }
}

function assertHead(s: LetterState, actor: LetterActor): void {
  assertLive(s);
  if (s.status !== 'review') throw state('LETTER_STATE', 'Письмо не на согласовании');
  if (!actor.isIbHead) throw new AppError(403, 'NOT_IB_HEAD', 'Согласует письмо начальник ИБ (отметка «Является начальником ИБ»)');
}

/** Утвердить: начальник ИБ. Своё письмо — «без независимого согласования» (self_approved). */
export function approve(s: LetterState, actor: LetterActor): { selfApproved: boolean } {
  assertHead(s, actor);
  return { selfApproved: actor.id === s.createdBy };
}

/** Вернуть на доработку: начальник ИБ, с обязательным комментарием. */
export function returnForRework(s: LetterState, actor: LetterActor, comment: string): { comment: string } {
  assertHead(s, actor);
  const c = comment.trim();
  if (!c) throw new AppError(400, 'COMMENT_REQUIRED', 'Напишите, что доработать');
  if (c.length > COMMENT_MAX) throw new AppError(400, 'COMMENT_TOO_LONG', `Комментарий длиннее ${COMMENT_MAX} символов`);
  return { comment: c };
}

export interface SendInput {
  sentOn: string;
  audience: string;
  comment?: string;
}

export interface SendDecision {
  /** Первая отметка: создаётся версия sent и письмо замораживается. */
  firstSend: boolean;
  withoutApproval: boolean;
  sentOn: string;
  audience: string;
  comment: string;
}

/**
 * «Отметить отправленным». Утверждённое — если последняя версия утверждена. Срочное можно без согласования
 * (из черновика или с согласования) только с комментарием. Отправленное — повторная отметка: новая дата и аудитория.
 * Языки проверяет сервис по версии отправки (checkLanguages).
 */
export function markSent(s: LetterState, input: SendInput, today: string): SendDecision {
  if (s.archived) throw state('LETTER_ARCHIVED', 'Письмо в архиве. Верните его из архива, чтобы отметить отправку');
  const sentOn = input.sentOn;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sentOn) || Number.isNaN(Date.parse(`${sentOn}T00:00:00Z`)) || new Date(`${sentOn}T00:00:00Z`).toISOString().slice(0, 10) !== sentOn) {
    throw new AppError(400, 'BAD_DATE', 'Неверная дата отправки');
  }
  if (sentOn > today) throw new AppError(400, 'BAD_DATE', 'Дата отправки не может быть позже сегодняшней');
  const audience = input.audience.replace(/\s+/g, ' ').trim();
  if (!audience) throw new AppError(400, 'AUDIENCE_REQUIRED', 'Укажите аудиторию: «Все сотрудники» или подразделения');
  if (audience.length > AUDIENCE_MAX) throw new AppError(400, 'AUDIENCE_TOO_LONG', `Аудитория длиннее ${AUDIENCE_MAX} символов`);
  const comment = (input.comment ?? '').trim();
  if (comment.length > COMMENT_MAX) throw new AppError(400, 'COMMENT_TOO_LONG', `Комментарий длиннее ${COMMENT_MAX} символов`);

  if (s.status === 'sent') return { firstSend: false, withoutApproval: false, sentOn, audience, comment };
  if (s.frozen) throw state('LETTER_FROZEN', 'Письмо отправлено — его нельзя изменить. Создайте копию');
  if (s.status === 'approved') {
    if (!s.latestIsApproved) throw state('LETTER_STATE', 'После утверждения письмо изменили. Отправьте его на согласование снова');
    return { firstSend: true, withoutApproval: false, sentOn, audience, comment };
  }
  if (s.kind !== 'urgent') throw state('NOT_APPROVED', 'Плановое письмо отмечается отправленным только после утверждения');
  if (!comment) throw new AppError(400, 'COMMENT_REQUIRED', 'Укажите причину: «Отправлено без согласования: …»');
  return { firstSend: true, withoutApproval: true, sentOn, audience, comment };
}
