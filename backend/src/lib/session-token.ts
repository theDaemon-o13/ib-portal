import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

// Сессии (релиз 1.10.0, ADR-0023 «Изменено в 1.10.0»; было: 30 минут без действий и 12 часов — ADR-0001).
//   Обычный пользователь: без завершения по бездействию; срок — параметр maxDays (0 — бессрочно), от входа.
//   «Запомнить меня» — постоянная cookie (Max-Age), без галочки — до закрытия браузера.
//   Администратор (users.manage или служебная роль «Администратор портала»): галочка не действует, срок —
//   adminMaxHours от входа (по умолчанию 12 часов). Кто администратор — по текущим правам, на каждом запросе.
//   Настенный монитор — общие правила (7 суток ADR-0012 убраны), вход и запросы — только с MONITOR_ALLOWED_IPS.

/** Параметр «Параметров портала» со сроками сессий. */
export const SESSION_SETTINGS_KEY = 'auth.session';
export const SessionSettingsSchema = z.strictObject({
  maxDays: z.number({ error: 'Срок сессии: нужно число дней' }).int('Срок сессии: целое число дней')
    .min(0, 'Срок сессии: не меньше 0 (0 — бессрочно)').max(3650, 'Срок сессии: не больше 3650 дней'),
  adminMaxHours: z.number({ error: 'Срок сессии администратора: нужно число часов' }).int('Срок сессии администратора: целое число часов')
    .min(1, 'Срок сессии администратора: не меньше 1 часа').max(720, 'Срок сессии администратора: не больше 720 часов'),
});
export type SessionSettings = z.infer<typeof SessionSettingsSchema>;
export const DEFAULT_SESSION_SETTINGS: SessionSettings = { maxDays: 0, adminMaxHours: 12 };

/** Строка app_settings → параметры; неверное или отсутствующее значение — по умолчанию. */
export function parseSessionSettings(raw: unknown): SessionSettings {
  const parsed = SessionSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : { ...DEFAULT_SESSION_SETTINGS };
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * expires_at новой сессии: дальняя дата. Колонка NOT NULL, а 1.9.0 после отката читает её как дату ('infinity'
 * JavaScript не прочтёт). Действующий предел — limitOf от created_at; у сессий до 1.10.0 — ещё и их expires_at.
 */
export const FAR_FUTURE_MS = 100 * 365 * DAY_MS;

/** До какого времени живёт сессия по параметрам: null — бессрочно. */
export function sessionDeadline(createdAt: Date, admin: boolean, s: SessionSettings): Date | null {
  if (admin) return new Date(createdAt.getTime() + s.adminMaxHours * HOUR_MS);
  return s.maxDays > 0 ? new Date(createdAt.getTime() + s.maxDays * DAY_MS) : null;
}

/** last_seen_at обновляется не чаще раза в 5 минут: «последняя активность» в «Моих сессиях», без нагрузки на БД. */
export const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/** Max-Age постоянной cookie, секунды: 400 дней — больше Chrome не хранит; продлевается при обновлении активности. */
export const REMEMBER_COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;

export const SESSION_COOKIE = 'ib_session';

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** В БД хранится только хэш токена: утечка таблицы sessions не даёт войти. */
export function sessionIdFromToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
