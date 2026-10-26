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
