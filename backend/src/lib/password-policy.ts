// Парольная политика (CLAUDE.md, раздел 5; совпадает с формой «Парольная защита»).

export const PASSWORD_MIN_LENGTH = 12;
/** Ограничение сверху, чтобы длинная строка не нагружала argon2. */
export const PASSWORD_MAX_LENGTH = 256;
export const PASSWORD_MIN_CLASSES = 3;
/** Нельзя повторять последние N паролей, включая текущий. */
export const PASSWORD_HISTORY_DEPTH = 5;

export type PasswordViolation = 'too_short' | 'too_long' | 'too_few_classes' | 'contains_login';

const MESSAGES: Record<PasswordViolation, string> = {
  too_short: `Пароль должен быть не короче ${PASSWORD_MIN_LENGTH} символов`,
  too_long: `Пароль должен быть не длиннее ${PASSWORD_MAX_LENGTH} символов`,
  too_few_classes:
    'Используйте минимум три вида символов из четырёх: строчные и прописные буквы, цифры, другие символы',
  contains_login: 'Пароль не должен содержать логин',
};

export function violationMessage(v: PasswordViolation): string {
  return MESSAGES[v];
}

/** Число классов символов: строчные, прописные, цифры, прочие. Буквы любого алфавита. */
export function characterClasses(password: string): number {
  let lower = false;
  let upper = false;
  let digit = false;
  let other = false;
  for (const ch of password) {
    if (/\p{Ll}/u.test(ch)) lower = true;
    else if (/\p{Lu}/u.test(ch)) upper = true;
    else if (/\p{Nd}/u.test(ch)) digit = true;
    else other = true;
  }
  return Number(lower) + Number(upper) + Number(digit) + Number(other);
}

export function checkPasswordStrength(password: string, login: string): PasswordViolation[] {
  const violations: PasswordViolation[] = [];
  const length = [...password].length;
  if (length < PASSWORD_MIN_LENGTH) violations.push('too_short');
  if (length > PASSWORD_MAX_LENGTH) violations.push('too_long');
  if (characterClasses(password) < PASSWORD_MIN_CLASSES) violations.push('too_few_classes');
  const normalizedLogin = login.trim().toLowerCase();
  if (normalizedLogin.length >= 3 && password.toLowerCase().includes(normalizedLogin)) {
    violations.push('contains_login');
  }
  return violations;
}

/**
 * Проверяет, совпадает ли пароль с одним из последних PASSWORD_HISTORY_DEPTH.
 * recentHashes — текущий хэш первым, затем история от новых к старым.
 */
export async function isRecentlyUsed(
  password: string,
  recentHashes: readonly string[],
  verify: (hash: string, password: string) => Promise<boolean>,
): Promise<boolean> {
  for (const hash of recentHashes.slice(0, PASSWORD_HISTORY_DEPTH)) {
    if (await verify(hash, password)) return true;
  }
  return false;
}
