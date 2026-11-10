// Адрес e-mail в справочных полях (1.13.6: почта ответственных лиц): портал писем не отправляет, адрес только хранится
// и копируется. Обрезка пробелов, нижний регистр, не длиннее 254 символов; пусто — адреса нет.
import { badRequest } from './errors.js';

export const EMAIL_MAX = 254;
/** Тот же формат, что у адресов «Получателей уведомлений» (catalogs/service.ts). */
export const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

/** Почта или ''. Неверный адрес — 400 BAD_EMAIL. */
export function cleanEmail(v: string | undefined | null): string {
  const e = (v ?? '').trim().toLowerCase();
  if (!e) return '';
  if (e.length > EMAIL_MAX || !EMAIL_RE.test(e)) throw badRequest('BAD_EMAIL', `«${e.slice(0, 80)}» — не адрес e-mail`);
  return e;
}
