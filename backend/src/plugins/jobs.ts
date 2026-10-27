// Фоновые задачи внутри backend (без отдельного сервиса): проверка правил автоматизации раз в час.
// Повторный запуск безопасен: события уникальны по (правило, запись, trigger_key), а одновременный
// прогон из второго экземпляра отсекает advisory-блокировка в БД.
import type { FastifyInstance } from 'fastify';
import type { Db } from '../lib/db.js';
import { runAutomations } from '../modules/automations/service.js';

export interface JobsOptions {
  db: Db;
  intervalMs: number;
  now?: () => Date;
}

export function installJobs(app: FastifyInstance, opts: JobsOptions): void {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | null = null;

  const tick = () => {
    if (running) return;
    running = (async () => {
      try {
        const r = await runAutomations(opts.db, { now: opts.now?.() });
        if (r.ran) app.log.info({ today: r.today, rules: r.rules, checked: r.checked, created: r.created }, 'автоматизации проверены');
        else app.log.info('автоматизации: прогон уже идёт в другом процессе — пропуск');
      } catch (err) {
        // Ошибка прогона не роняет backend: следующий прогон — по расписанию.
        app.log.error({ err }, 'автоматизации: прогон не выполнен');
      } finally {
        running = null;
      }
    })();
  };

  app.addHook('onReady', async () => {
    tick();
    timer = setInterval(tick, opts.intervalMs);
    timer.unref();
  });
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
    // Дождаться идущего прогона: после onClose отключается БД.
    await running;
  });
}
