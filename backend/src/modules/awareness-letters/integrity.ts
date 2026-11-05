// Проверки целостности учебных писем и расписания (1.9.0; docs/specs/awareness.md, раздел 21) для check-integrity.
// Только чтение. Возвращает список «проверка → ок / подсказка»: скрипт печатает, DB-тест проверяет на своих данных.
// Большая часть правил закреплена триггерами и ограничениями в БД — здесь вторая линия и то, что триггером не выразить.
import type { Db } from '../../lib/db.js';
import { workRolesWhere } from '../../lib/work-users.js';
import { AWARENESS_MAILINGS_KEY, MAILING_FIELDS, SIGNATURE_CODE } from './definition.js';
import { AWARENESS_LETTERS_KEY, LetterLimitsSchema } from './settings.js';

export interface IntegrityCheck {
  ok: boolean;
  label: string;
  hint: string;
}

const LIMIT = 20;
const nums = (rows: { number: number }[]) => rows.map((r) => `№ ${r.number}`).join(', ');

export async function letterIntegrity(db: Db): Promise<IntegrityCheck[]> {
  const out: IntegrityCheck[] = [];
  const check = (ok: boolean, label: string, hint = '') => out.push({ ok, label, hint: ok ? '' : hint });

  // Триггеры: версии и события только пополняются, замороженное письмо меняется только в части архива.
  const triggers = await db.$queryRaw<{ tgname: string }[]>`
    SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname IN (
      'awareness_letter_versions_append_only', 'awareness_letter_events_append_only',
      'awareness_letter_versions_guard', 'awareness_letters_guard')`;
  check(triggers.length === 4, 'учебные письма: триггеры версий, событий и заморозки на месте', `найдено ${triggers.length} из 4`);

  // Текущая, утверждённая и отправленная версии принадлежат письму.
  const foreign = await db.$queryRaw<{ number: number }[]>`
    SELECT l.number FROM awareness_letters l
    WHERE EXISTS (
      SELECT 1 FROM unnest(ARRAY[l.current_version_id, l.approved_version_id, l.sent_version_id]) AS v(id)
      WHERE v.id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM awareness_letter_versions x WHERE x.id = v.id AND x.letter_id = l.id))
    ORDER BY l.number LIMIT ${LIMIT}`;
  check(foreign.length === 0, 'учебные письма: текущая, утверждённая и отправленная версии — своего письма', nums(foreign));

  // У каждого письма есть текущая версия.
  const noCurrent = await db.$queryRaw<{ number: number }[]>`
    SELECT number FROM awareness_letters WHERE current_version_id IS NULL ORDER BY number LIMIT ${LIMIT}`;
  check(noCurrent.length === 0, 'учебные письма: у каждого есть текущая версия', nums(noCurrent));

  // Номера версий без пропусков: 1..N.
  const gaps = await db.$queryRaw<{ number: number }[]>`
    SELECT l.number FROM awareness_letters l JOIN awareness_letter_versions v ON v.letter_id = l.id
    GROUP BY l.id, l.number HAVING min(v.no) <> 1 OR max(v.no) <> count(*)
    ORDER BY l.number LIMIT ${LIMIT}`;
  check(gaps.length === 0, 'учебные письма: номера версий без пропусков', nums(gaps));

  // Замороженное письмо: версия sent и событие sent.
  const frozen = await db.$queryRaw<{ number: number }[]>`
    SELECT l.number FROM awareness_letters l
    WHERE l.frozen AND (
      NOT EXISTS (SELECT 1 FROM awareness_letter_versions v WHERE v.id = l.sent_version_id AND v.reason = 'sent')
      OR NOT EXISTS (SELECT 1 FROM awareness_letter_events e WHERE e.letter_id = l.id AND e.action = 'sent'))
    ORDER BY l.number LIMIT ${LIMIT}`;
  check(frozen.length === 0, 'учебные письма: у отправленного есть версия sent и событие «Отправлено»', nums(frozen));

  // Запись «Рассылок» из события отправки существует и не удалена.
  const lostRecords = await db.$queryRaw<{ number: number }[]>`
    SELECT DISTINCT l.number FROM awareness_letter_events e JOIN awareness_letters l ON l.id = e.letter_id
    LEFT JOIN register_records r ON r.id = e.record_id
    WHERE e.record_id IS NOT NULL AND (r.id IS NULL OR r.deleted_at IS NOT NULL)
    ORDER BY l.number LIMIT ${LIMIT}`;
  check(lostRecords.length === 0, 'учебные письма: записи «Рассылок» из отметок «Отправлено» на месте', `письма ${nums(lostRecords)} — запись удалена; восстановите её из корзины`);

  // Роль неархивного правила участвует в работе.
  const rules = await db.awarenessScheduleRule.findMany({ where: { archivedAt: null }, select: { title: true, roleId: true } });
  const work = new Set((await db.role.findMany({ where: workRolesWhere(), select: { id: true } })).map((r) => r.id));
  const badRules = rules.filter((r) => !work.has(r.roleId));
  check(badRules.length === 0, 'расписание: роль-исполнитель правил участвует в работе (ib.work, не служебная)',
    `правила ${badRules.slice(0, LIMIT).map((r) => `«${r.title}»`).join(', ')} — выберите другую роль`);

  // У каждого запуска есть задача, и она не удалена.
  const runs = await db.$queryRaw<{ title: string; d: Date }[]>`
    SELECT r.title, x.planned_date AS d FROM awareness_schedule_runs x JOIN awareness_schedule_rules r ON r.id = x.rule_id
    LEFT JOIN tasks t ON t.id = x.task_id WHERE t.id IS NULL OR t.deleted_at IS NOT NULL ORDER BY x.planned_date LIMIT ${LIMIT}`;
  check(runs.length === 0, 'расписание: у каждого запуска есть задача',
    runs.map((r) => `«${r.title}» на ${r.d.toISOString().slice(0, 10)}`).join(', '));

  // Письмо запуска привязано к той же задаче.
  const mismatched = await db.$queryRaw<{ number: number }[]>`
    SELECT l.number FROM awareness_schedule_runs x JOIN awareness_letters l ON l.id = x.letter_id
    WHERE l.task_id IS DISTINCT FROM x.task_id ORDER BY l.number LIMIT ${LIMIT}`;
  check(mismatched.length === 0, 'расписание: письмо запуска привязано к задаче запуска', nums(mismatched));

  // Системные поля «Рассылок» и «Подпись ИБ».
  const reg = await db.register.findUnique({
    where: { systemKey: AWARENESS_MAILINGS_KEY },
    select: { name: true, fields: { where: { deletedAt: null, archivedAt: null }, select: { systemKey: true } } },
  });
  const have = new Set(reg?.fields.map((f) => f.systemKey) ?? []);
  const missing = MAILING_FIELDS.filter((f) => !have.has(f.key)).map((f) => f.label);
  check(!!reg && missing.length === 0, `учебные письма: системные поля реестра «${reg?.name ?? 'Рассылки'}»`,
    reg ? `нет полей: ${missing.join(', ')}` : 'реестра нет — выполните migrate (seed awareness.v2)');
  const signature = await db.awarenessFragment.findUnique({ where: { code: SIGNATURE_CODE }, select: { code: true } });
  check(!!signature, 'учебные письма: «Подпись ИБ» на месте', 'выполните migrate (seed awareness.v2)');

  const limits = await db.appSetting.findUnique({ where: { key: AWARENESS_LETTERS_KEY } });
  const parsed = limits ? LetterLimitsSchema.safeParse(limits.value) : null;
  check(!limits || parsed?.success === true, 'учебные письма: лимиты размера проходят проверку',
    parsed && !parsed.success ? parsed.error.issues.map((i) => i.message).join('; ') : '');

  return out;
}

