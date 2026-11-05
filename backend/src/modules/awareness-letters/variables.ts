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
}

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
export function checkTemplate(t: TemplateTexts): TemplateVariable[] {
  const { variables, problems } = extractVariables([t.subjectRu, t.subjectTj, t.htmlRu, t.htmlTj]);
  if ([t.subjectRu, t.subjectTj].some(hasSignatureInSubject)) problems.push('Подпись ИБ не ставится в тему письма');
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
export function fillTemplate(t: TemplateTexts, values: Readonly<Record<string, string>>): TemplateTexts {
  const given = new Map(Object.entries(values).map(([k, v]) => [variableKey(k), v.trim()]));
  const { variables } = extractVariables([t.subjectRu, t.subjectTj, t.htmlRu, t.htmlTj]);
  const unfilled = variables.filter((v) => !given.get(v.key));
  if (unfilled.length) {
    throw new AppError(400, 'UNFILLED_VARIABLES', `Заполните переменные: ${unfilled.map((v) => `«${v.label}»`).join(', ')}`);
  }
  const subject = (s: string) => s.replace(VAR_RE, (all, name: string) => given.get(variableKey(name)) ?? all);
  const html = (s: string) => signatureToBlock(s).replace(VAR_RE, (all, name: string) => {
    const v = given.get(variableKey(decodeEntities(name)));
    return v === undefined ? all : escapeHtml(v);
  });
  return { subjectRu: subject(t.subjectRu), subjectTj: subject(t.subjectTj), htmlRu: html(t.htmlRu), htmlTj: html(t.htmlTj) };
}

/**
 * Незаполненные переменные в письме, кроме служебной `{{подпись}}`: с ними нельзя «На согласование» и первую отметку
 * «Отправлено» (черновик из расписания, срочное без согласования).
 */
export function unfilledInLetter(t: TemplateTexts): string[] {
  return extractVariables([t.subjectRu, t.subjectTj, t.htmlRu, t.htmlTj]).variables.map((v) => v.label);
}
