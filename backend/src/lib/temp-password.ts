import { randomInt } from 'node:crypto';

// Без похожих символов (0/O, 1/l/I), чтобы пароль можно было продиктовать.
const LOWER = 'abcdefghijkmnpqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const OTHER = '!#%*+-=?@_';
const ALL = LOWER + UPPER + DIGITS + OTHER;

export const TEMP_PASSWORD_LENGTH = 16;

function pick(chars: string): string {
  return chars[randomInt(chars.length)] ?? '';
}

/**
 * Временный пароль для нового пользователя и сброса: 16 символов, все четыре класса.
 * Показывается администратору один раз и нигде не хранится в открытом виде.
 */
export function generateTemporaryPassword(): string {
  const chars = [pick(LOWER), pick(UPPER), pick(DIGITS), pick(OTHER)];
  while (chars.length < TEMP_PASSWORD_LENGTH) chars.push(pick(ALL));
  // Перемешивание Фишера — Йейтса криптографически стойким генератором.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j] ?? '', chars[i] ?? ''];
  }
  return chars.join('');
}
