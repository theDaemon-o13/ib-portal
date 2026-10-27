// Фоновые задачи внутри backend (без отдельного сервиса): проверка правил автоматизации раз в час
// и извлечение текста загруженных PDF для поиска (этап 8б) — раз в 20 секунд, если есть очередь.
// Повторный запуск безопасен: события уникальны по (правило, запись, trigger_key), а одновременный
// прогон из второго экземпляра отсекает advisory-блокировка в БД.
import type { FastifyInstance } from 'fastify';
import type { Db } from '../lib/db.js';
import type { FileStore } from '../lib/file-store.js';
import { runAutomations } from '../modules/automations/service.js';
import { processPendingTexts } from '../modules/files/text.js';

export interface JobsOptions {
  db: Db;
  intervalMs: number;
  now?: () => Date;
  /** Хранилище файлов: без него текст PDF не извлекается. */
  store?: FileStore;
  textIntervalMs?: number;
}

/** Текст PDF: очередь file_texts разбирается в фоне, по одному файлу, вне транзакций. */
function installTextJob(app: FastifyInstance, db: Db, store: FileStore, intervalMs: number): void {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | null = null;
  const tick = () => {
    if (running) return;
    running = (async () => {
      try {
        const r = await processPendingTexts(db, store);
        if (r.processed) app.log.info(r, 'текст PDF извлечён');
      } catch (err) {
        app.log.error({ err }, 'текст PDF: прогон не выполнен');
      } finally {
        running = null;
      }
    })();
  };
  app.addHook('onReady', async () => {
    timer = setInterval(tick, intervalMs);
    timer.unref();
    tick();
  });
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
    await running;
  });
}

export function installJobs(app: FastifyInstance, opts: JobsOptions): void {
  if (opts.store) installTextJob(app, opts.db, opts.store, opts.textIntervalMs ?? 20_000);
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
