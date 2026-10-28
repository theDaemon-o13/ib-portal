// Что pino вырезает из логов: cookie, заголовок авторизации и пароли в любом виде.
// Тело запроса Fastify сам не пишет; пути — страховка на случай, если его залогируют явно.

const PASSWORD_KEYS = ['password', 'currentPassword', 'newPassword', 'temporaryPassword'] as const;

export const LOG_REDACT: string[] = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  ...PASSWORD_KEYS.flatMap((k) => [k, `*.${k}`, `req.body.${k}`]),
];
