// Причины отказа во входе (1.13.7). Пользователь видит одно и то же — 401 «Неверный логин или пароль» (423 — при
// блокировке): по ответу нельзя узнать, верен ли пароль и с какого адреса пускают. Причина — для администратора:
// в журнале аудита (diff.reason, подпись в «Журнале») и строкой warn в логе backend.

export const LOGIN_FAILURE_REASONS = {
  unknown_user: 'логин не найден',
  wrong_password: 'неверный пароль',
  inactive: 'учётная запись отключена',
  locked: 'вход заблокирован после неудачных попыток',
  kiosk_ip_denied: 'адрес не разрешён для настенного монитора (MONITOR_ALLOWED_IPS)',
  admin_ip_denied: 'адрес не разрешён для администратора (ADMIN_ALLOWED_IPS)',
} as const;

export type LoginFailureReason = keyof typeof LOGIN_FAILURE_REASONS;

export const isLoginFailureReason = (v: unknown): v is LoginFailureReason =>
  typeof v === 'string' && Object.hasOwn(LOGIN_FAILURE_REASONS, v);

/**
 * Маска логина, которого нет в базе: в поле логина иногда вводят пароль. Первые 2 символа и длина — «iv… (7 симв.)»;
 * короче 3 символов — только длина.
 */
export function maskLogin(login: string): string {
  const chars = [...login];
  const head = chars.length > 2 ? `${chars.slice(0, 2).join('')}…` : '…';
  return `${head} (${chars.length} симв.)`;
}

/** Логин для лога и подписи журнала: при unknown_user — маска, иначе полностью. */
export const loginForLog = (reason: LoginFailureReason, login: string) => (reason === 'unknown_user' ? maskLogin(login) : login);

/** Подпись записи журнала auth.login_failed: «Неудачный вход «ivanov»: неверный пароль (попытка 2)». */
export function loginFailureSummary(diff: Record<string, unknown>): string | null {
  if (!isLoginFailureReason(diff.reason)) return null;
  const login = typeof diff.login === 'string' ? loginForLog(diff.reason, diff.login) : '';
  const attempt = diff.reason === 'wrong_password' && typeof diff.attempt === 'number' ? ` (попытка ${diff.attempt})` : '';
  return `Неудачный вход${login ? ` «${login}»` : ''}: ${LOGIN_FAILURE_REASONS[diff.reason]}${attempt}`;
}
