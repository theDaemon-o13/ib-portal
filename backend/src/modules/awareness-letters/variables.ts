// Переменные шаблонов писем `{{описание}}` (1.9.0; docs/specs/awareness.md, раздел 17.2).
// Список извлекается из обеих тем и обоих текстов. Одинаковое имя (без регистра, «ё» = «е», пробелы схлопнуты) —
// одна переменная на оба языка. `{{подпись}}` — служебная: становится блоком «Подпись ИБ».
import { AppError } from '../../lib/errors.js';

export const MAX_VARIABLES = 30;
export const MAX_VARIABLE_NAME = 60;
export const SIGNATURE_VARIABLE = 'подпись';
/** Блок «Подпись ИБ» в HTML письма: показывает текущую подпись, при отправке заменяется её текстом. */
export const SIGNATURE_BLOCK = '<div data-ib-fragment="signature"></div>';

const VAR_RE = /\{\{([^{}]*)\}\}/g;

export const variableKey = (name: string) => name.replace(/\s+/g, ' ').trim().toLowerCase().replace(/ё/g, 'е');

export interface TemplateVariable {
  /** Нормализованное имя — ключ значения в форме. */
  key: string;
  /** Написание при первом появлении — подпись поля формы. */
  label: string;
}

export interface TemplateTexts {
  subjectRu: string;
  subjectTj: string;
  htmlRu: string;
  htmlTj: string;
  /** Шапка письма (1.12.0): «Заголовок» и «Метка» языка, «Тема общая» RU+TJ — простой текст, пусто — по умолчанию. */
  headerRu: string;
  headerTj: string;
  labelRu: string;
  labelTj: string;
  subjectBoth: string;
}

/** Поля шапки 1.12.0 — простой текст, как тема. */
export const HEAD_FIELDS = ['headerRu', 'headerTj', 'labelRu', 'labelTj', 'subjectBoth'] as const;
export type HeadField = (typeof HEAD_FIELDS)[number];
export const EMPTY_HEAD: Record<HeadField, string> = { headerRu: '', headerTj: '', labelRu: '', labelTj: '', subjectBoth: '' };
/** Вход сервисов и чистых функций: поля шапки необязательны (письма, шаблоны и тесты 1.9.0), пусто — ''. */
export type TextsInput = Omit<TemplateTexts, HeadField> & Partial<Record<HeadField, string>>;
export const withHead = (t: TextsInput): TemplateTexts => ({
  subjectRu: t.subjectRu, subjectTj: t.subjectTj, htmlRu: t.htmlRu, htmlTj: t.htmlTj,
  headerRu: t.headerRu ?? '', headerTj: t.headerTj ?? '', labelRu: t.labelRu ?? '', labelTj: t.labelTj ?? '', subjectBoth: t.subjectBoth ?? '',
});
/** Простые текстовые поля письма: темы и шапка — где переменные подставляются без HTML. */
export const plainTexts = (t: TextsInput): string[] => [t.subjectRu, t.subjectTj, ...HEAD_FIELDS.map((k) => t[k] ?? '')];
/** Все поля с переменными: простые и HTML. */
export const allTexts = (t: TextsInput): string[] => [...plainTexts(t), t.htmlRu, t.htmlTj];

/** Все `{{…}}` из текстов по порядку появления, без служебной `{{подпись}}`. Ошибки — пустое и слишком длинное имя. */
export function extractVariables(texts: readonly string[]): { variables: TemplateVariable[]; problems: string[] } {
  const seen = new Map<string, TemplateVariable>();
  const problems: string[] = [];
  for (const text of texts) {
    for (const m of text.matchAll(VAR_RE)) {
      const raw = decodeEntities(m[1] ?? '');
      const label = raw.replace(/\s+/g, ' ').trim();
      if (!label) {
        problems.push('Пустая переменная {{}}');
        continue;
      }
      if (label.length > MAX_VARIABLE_NAME) {
        problems.push(`Имя переменной длиннее ${MAX_VARIABLE_NAME} символов: «${label.slice(0, 30)}…»`);
        continue;
      }
      const key = variableKey(label);
      if (key === SIGNATURE_VARIABLE || seen.has(key)) continue;
      seen.set(key, { key, label });
    }
  }
  const variables = [...seen.values()];
  if (variables.length > MAX_VARIABLES) problems.push(`Переменных больше ${MAX_VARIABLES}: ${variables.length}`);
  return { variables, problems: [...new Set(problems)] };
}

/** Шаблон при сохранении: переменные разбираются, `{{подпись}}` в теме запрещена. */
export function checkTemplate(t: TextsInput): TemplateVariable[] {
  const { variables, problems } = extractVariables(allTexts(t));
  if (plainTexts(t).some(hasSignatureInSubject)) problems.push('Подпись ИБ не ставится в тему, заголовок и метку письма');
  if (problems.length) throw new AppError(400, 'BAD_TEMPLATE', [...new Set(problems)].join('. '));
  return variables;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
/** Редактор хранит текст с HTML-сущностями: `{{a &amp; b}}` — переменная «a & b». */
function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' })[e] ?? '');
}

const isSignature = (name: string) => variableKey(decodeEntities(name)) === SIGNATURE_VARIABLE;

/**
 * `{{подпись}}` в HTML — блок «Подпись ИБ»; абзац из одной подписи заменяется блоком целиком. Подставляет система:
 * в шаблоне (fillTemplate) и при каждом сохранении письма — набранная вручную подпись не уйдёт в письмо текстом.
 */
export function signatureToBlock(html: string): string {
  return html
    .replace(/<p>\s*\{\{([^{}]*)\}\}\s*<\/p>/g, (all, name: string) => (isSignature(name) ? SIGNATURE_BLOCK : all))
    .replace(VAR_RE, (all, name: string) => (isSignature(name) ? SIGNATURE_BLOCK : all));
}

/** `{{подпись}}` в теме письма или шаблона — ошибка: подпись бывает только в тексте. */
export function hasSignatureInSubject(subject: string): boolean {
  return [...subject.matchAll(VAR_RE)].some((m) => isSignature(m[1] ?? ''));
}

/**
 * Подстановка значений. Пустая или незаданная переменная — 400 UNFILLED_VARIABLES со списком, ничего не создаётся.
 * Значения — простой текст: в HTML экранируются. `{{подпись}}` в тексте становится блоком «Подпись ИБ»,
 * абзац из одной подписи заменяется блоком целиком. Результат HTML затем проходит санитайзер, как любое сохранение.
 */
export function fillTemplate(input: TextsInput, values: Readonly<Record<string, string>>): TemplateTexts {
  const t = withHead(input);
  const given = new Map(Object.entries(values).map(([k, v]) => [variableKey(k), v.trim()]));
  const { variables } = extractVariables(allTexts(t));
  const unfilled = variables.filter((v) => !given.get(v.key));
  if (unfilled.length) {
    throw new AppError(400, 'UNFILLED_VARIABLES', `Заполните переменные: ${unfilled.map((v) => `«${v.label}»`).join(', ')}`);
  }
  const subject = (s: string) => s.replace(VAR_RE, (all, name: string) => given.get(variableKey(name)) ?? all);
  const html = (s: string) => signatureToBlock(s).replace(VAR_RE, (all, name: string) => {
    const v = given.get(variableKey(decodeEntities(name)));
    return v === undefined ? all : escapeHtml(v);
  });
  return {
    subjectRu: subject(t.subjectRu), subjectTj: subject(t.subjectTj), htmlRu: html(t.htmlRu), htmlTj: html(t.htmlTj),
    headerRu: subject(t.headerRu), headerTj: subject(t.headerTj), labelRu: subject(t.labelRu), labelTj: subject(t.labelTj), subjectBoth: subject(t.subjectBoth),
  };
}

/**
 * Незаполненные переменные в письме, кроме служебной `{{подпись}}`: с ними нельзя «На согласование» и первую отметку
 * «Отправлено» (черновик из расписания, срочное без согласования).
 */
export function unfilledInLetter(t: TextsInput): string[] {
  return extractVariables(allTexts(t)).variables.map((v) => v.label);
}
