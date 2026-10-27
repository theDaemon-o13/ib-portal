import { z } from 'zod';
import { parseIpList } from './lib/ip-list.js';

/** Список IP и подсетей: ошибка в .env видна при старте, а не при первом входе. */
function checkIpList(v: string, ctx: z.RefinementCtx): void {
  try {
    parseIpList(v);
  } catch (e) {
    ctx.addIssue({ code: 'custom', message: (e as Error).message });
  }
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL не задан'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET должен быть не короче 32 символов'),
  FILES_DIR: z.string().default('/data/files'),
  // Адреса прокси, которым верим в X-Forwarded-For (IP и подсети через запятую): nginx портала
  // с постоянным адресом в сети front (compose). За PT AF или балансировщиком — добавить его адрес.
  TRUSTED_PROXY_IPS: z.string().default('127.0.0.1,::1').superRefine(checkIpList),
  // Адреса настенных мониторов (IP и подсети через запятую). Пусто — вход киоска запрещён.
  MONITOR_ALLOWED_IPS: z.string().default('').superRefine(checkIpList),
  // Адреса рабочих мест администраторов: вход с правами settings.manage или users.manage только с них.
  // Пусто — без ограничения (ADR-0015).
  ADMIN_ALLOWED_IPS: z.string().default('').superRefine(checkIpList),
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
