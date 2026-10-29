import { createHash, randomBytes } from 'node:crypto';

/** Неактивная сессия завершается через 30 минут (CLAUDE.md, раздел 5). */
export const SESSION_IDLE_MS = 30 * 60 * 1000;
/** Абсолютный предел жизни сессии, даже при постоянной активности. */
export const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
/**
 * Настенный монитор (ADR-0012, решение владельца после этапа В): работает сутками — абсолютный срок 7 суток,
 * только у роли с monitor.kiosk и только с MONITOR_ALLOWED_IPS. Сбрасывается сменой пароля и снятием роли или права.
 */
export const KIOSK_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** last_seen_at обновляется не чаще раза в минуту. */
export const SESSION_TOUCH_INTERVAL_MS = 60 * 1000;

export const SESSION_COOKIE = 'ib_session';

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** В БД хранится только хэш токена: утечка таблицы sessions не даёт войти. */
export function sessionIdFromToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
