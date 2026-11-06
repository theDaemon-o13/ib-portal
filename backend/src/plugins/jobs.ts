// Фоновые задачи внутри backend (без отдельного сервиса): проверка правил автоматизации раз в час (с релиза 1.2.0 —
// и уведомления о сроках задач, очистка старых уведомлений)
// и извлечение текста загруженных PDF для поиска (этап 8б) — раз в 20 секунд, если есть очередь.
// Повторный запуск безопасен: события уникальны по (правило, запись, trigger_key), а одновременный
// прогон из второго экземпляра отсекает advisory-блокировка в БД.
import type { FastifyInstance } from 'fastify';
import type { Db } from '../lib/db.js';
import type { FileStore } from '../lib/file-store.js';
import { runAutomations } from '../modules/automations/service.js';
import { runAwarenessSchedule } from '../modules/awareness-letters/schedule.service.js';
import { runControlAutomations } from '../modules/documents/automations.js';
import { processPendingTexts } from '../modules/files/text.js';
import { notifyReassessment } from '../modules/assessments/service.js';
import { notifyPartyDeadlines, notifyTranslationDeadlines } from '../modules/documents/notify.js';
import { cleanupNotifications, notifyDeadlines } from '../modules/notifications/service.js';

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
        // Расписание рассылок (1.9.0, ADR-0040): своя транзакция и блокировка — ошибка не откатывает автоматизации.
        try {
          const s = await runAwarenessSchedule(opts.db, { now: opts.now?.() });
          if (!s.ran) app.log.info('расписание рассылок: прогон уже идёт в другом процессе — пропуск');
          else if (s.created || s.escalated || s.candidatesUpdated) app.log.info(s, 'расписание рассылок проверено');
        } catch (err) {
          app.log.error({ err }, 'расписание рассылок: прогон не выполнен');
        }
        // Автоматизации механизмов контроля документов (1.11.0, ADR-0043): своя транзакция и блокировка.
        try {
          const c = await runControlAutomations(opts.db, { now: opts.now?.() });
          if (!c.ran) app.log.info('автоматизации контроля документов: прогон уже идёт в другом процессе — пропуск');
          else if (c.created || c.skipped || c.noAssignee) app.log.info(c, 'автоматизации контроля документов проверены');
        } catch (err) {
          app.log.error({ err }, 'автоматизации контроля документов: прогон не выполнен');
        }
        // Уведомления (этап В): «срок завтра» и «просрочено» без дублей (уникальный dedupe_key), очистка — раз в сутки.
        const now = opts.now?.() ?? new Date();
        const d = await notifyDeadlines(opts.db, now);
        // Документы (Г5): «срок ответственного лица завтра» и «просрочен» — автору.
        const p = await notifyPartyDeadlines(opts.db, now);
        // Маршрут 1.11.0: «срок перевода завтра» и «просрочен» — автору.
        const tr = await notifyTranslationDeadlines(opts.db, now);
        // Самооценка (этап Д): за 30 дней до годовщины последней зафиксированной — «Пора провести самооценку».
        const reassessment = await notifyReassessment(opts.db, now);
        const cleaned = await cleanupNotifications(opts.db, now);
        if (d.dueTomorrow || d.overdue || d.overdueSummary || p.dueTomorrow || p.overdue || tr.dueTomorrow || tr.overdue || reassessment || cleaned) {
          app.log.info({ ...d, partyDueTomorrow: p.dueTomorrow, partyOverdue: p.overdue, translationDueTomorrow: tr.dueTomorrow, translationOverdue: tr.overdue, reassessment, cleaned }, 'уведомления о сроках');
        }
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
