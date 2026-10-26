/** Ошибка с кодом и понятным текстом на русском. Превращается в { error: { code, message } }. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const unauthorized = () =>
  new AppError(401, 'UNAUTHORIZED', 'Войдите в систему');

export const forbidden = () =>
  new AppError(403, 'FORBIDDEN', 'Недостаточно прав для этого действия');

export const passwordChangeRequired = () =>
  new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'Сначала смените пароль');

export const notFound = (what = 'Запись') => new AppError(404, 'NOT_FOUND', `${what} не найдена`);

/** Запись успела измениться: frontend предлагает перечитать (CLAUDE.md, раздел 8). */
export const versionConflict = () =>
  new AppError(409, 'VERSION_CONFLICT', 'Запись уже изменил другой пользователь. Обновите данные и повторите');

export const conflict = (code: string, message: string) => new AppError(409, code, message);

export const badRequest = (code: string, message: string) => new AppError(400, code, message);
