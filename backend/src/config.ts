import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL не задан'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET должен быть не короче 32 символов'),
  FILES_DIR: z.string().default('/data/files'),
  // Адреса прокси, которым верим в X-Forwarded-For: nginx в сети front.
  TRUST_PROXY: z.string().default('loopback,uniquelocal'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  // Часовой пояс банка: «сегодня» для сроков и автоматизаций (lib/today.ts).
  APP_TZ: z.string().default('Asia/Dushanbe').refine((tz) => {
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'неизвестный часовой пояс'),
  // Проверка правил автоматизации внутри backend (минуты). 0 — выключено.
  AUTOMATION_INTERVAL_MIN: z.coerce.number().int().min(0).max(1440).default(60),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Неверная конфигурация: ${problems}`);
  }
  return parsed.data;
}
