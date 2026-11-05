// Однократно (отметка awareness.v1 в seed_markers): системные реестры «Сотрудники» и «Результаты INDIGO» без записей,
// ключ сравнения «Сотрудников» (табельный номер — для «Нет в файле» → «Уволен», ADR-0017) и строка порогов оценки
// awareness.grades (релиз 1.8.0, docs/specs/awareness.md, раздел 8). Плиток и автоматизаций нет (решения владельца 5 и 7).
// Данных банка нет: ни людей, ни подразделений. Удалённое или изменённое администратором seed не восстанавливает.
import type { Prisma } from '../../src/generated/prisma/client.js';
import {
  AWARENESS_EMPLOYEES_KEY, AWARENESS_RESULTS_KEY, EMPLOYEE_FIELDS, RESULT_FIELDS, type AwarenessFieldSpec,
} from '../../src/modules/awareness/definition.js';
import { AWARENESS_GRADES_KEY, DEFAULT_GRADES } from '../../src/modules/awareness/grades.js';
import {
  AWARENESS_MAILINGS_KEY, MAILING_FIELDS, MAILINGS_NAME, SIGNATURE_CODE, SIGNATURE_PLACEHOLDER,
} from '../../src/modules/awareness-letters/definition.js';
import { AWARENESS_LETTERS_KEY, DEFAULT_LETTERS_SETTINGS } from '../../src/modules/awareness-letters/settings.js';
import { once } from './registers.js';

type Tx = Prisma.TransactionClient;

export const EMPLOYEES_NAME = 'Сотрудники';
export const RESULTS_NAME = 'Результаты INDIGO';

/** Название, свободное от реестров администратора: как у системных реестров активов — с «(системный)». */
async function freeName(tx: Tx, name: string): Promise<string> {
  const clash = await tx.register.findFirst({ where: { archivedAt: null, name: { equals: name, mode: 'insensitive' } } });
  return clash ? `${name} (системный)` : name;
}

async function createRegister(tx: Tx, systemKey: string, name: string, description: string, specs: AwarenessFieldSpec[], regIds: Record<string, string>) {
  const reg = await tx.register.create({ data: { name: await freeName(tx, name), description, systemKey } });
  const fields: Record<string, string> = {};
  for (const [i, f] of specs.entries()) {
    const created = await tx.registerField.create({
      data: {
        registerId: reg.id, label: f.label, type: f.type, sortOrder: i + 1, systemKey: f.key,
        isTitle: f.isTitle ?? false, isStatus: f.isStatus ?? false, isImportKey: f.isImportKey ?? false,
        analyticsRole: f.analyticsRole ?? null,
        linkRegisterId: f.link ? regIds[f.link] ?? null : null,
        ...(f.hint ? { settings: { hint: f.hint } } : {}),
        options: f.options?.length
          ? { create: f.options.map((o, j) => ({ label: o.label, sortOrder: j + 1, isClosed: o.closed ?? false, systemKey: o.key })) }
          : undefined,
      },
    });
    fields[f.key] = created.id;
  }
  return { id: reg.id, name: reg.name, fields };
}

export async function seedAwareness(tx: Tx): Promise<void> {
  await once(tx, 'awareness.v1', async () => {
    // Реестры уже есть (повторная выкладка после отката, восстановление из копии без отметки) — ничего не создаём.
    const existing = await tx.register.findMany({ where: { systemKey: { in: [AWARENESS_EMPLOYEES_KEY, AWARENESS_RESULTS_KEY] } }, select: { name: true } });
    if (existing.length) return `Осведомлённость: реестры уже есть (${existing.map((r) => `«${r.name}»`).join(', ')}) — seed их не меняет`;

    const employees = await createRegister(
      tx, AWARENESS_EMPLOYEES_KEY, EMPLOYEES_NAME,
      'Сотрудники банка из выгрузки HR. Ключ импорта — табельный номер; тех, кого нет в новой выгрузке, «Сравнение» отмечает «Уволен». Записи не удаляются: на них ссылаются результаты тестов',
      EMPLOYEE_FIELDS, {},
    );
    const tabNo = employees.fields.tabNo;
    if (tabNo) await tx.register.update({ where: { id: employees.id }, data: { compareKeyFieldIds: [tabNo] } });
    const results = await createRegister(
      tx, AWARENESS_RESULTS_KEY, RESULTS_NAME,
      'Попытки тестирования на платформе INDIGO: одна запись — одна попытка. Загружается кнопкой «Импорт отчёта INDIGO»; поля, кроме «Сотрудника», ставит импорт',
      RESULT_FIELDS, { [AWARENESS_EMPLOYEES_KEY]: employees.id },
    );
    // Пороги оценки: строка со значениями по умолчанию; уже есть (изменили раньше) — не трогаем.
    const grades = await tx.appSetting.findUnique({ where: { key: AWARENESS_GRADES_KEY } });
    if (!grades) await tx.appSetting.create({ data: { key: AWARENESS_GRADES_KEY, value: { ...DEFAULT_GRADES } } });
    return `Осведомлённость: реестры «${employees.name}» (полей ${EMPLOYEE_FIELDS.length}) и «${results.name}» (полей ${RESULT_FIELDS.length}), пороги оценки`;
  });
}

/**
 * Однократно (отметка awareness.v2, релиз 1.9.0; docs/specs/awareness.md, раздел 11): реестр «Рассылки» без записей,
 * фрагмент «Подпись ИБ» с заглушкой и лимиты размера писем awareness.letters. Писем, шаблонов и правил seed не
 * создаёт. Категория задач «Осведомлённость» — системное значение справочника (SYSTEM_ITEMS, seedSystemItems):
 * одноимённое значение администратора становится системным с записью в журнал (ответ владельца 5).
 * Уже существующее (повторная выкладка после отката, восстановление из копии без отметки) не меняется.
 */
export async function seedAwarenessLetters(tx: Tx): Promise<void> {
  await once(tx, 'awareness.v2', async () => {
    const done: string[] = [];
    const existing = await tx.register.findUnique({ where: { systemKey: AWARENESS_MAILINGS_KEY }, select: { name: true } });
    if (existing) {
      done.push(`реестр «${existing.name}» уже есть — seed его не меняет`);
    } else {
      const reg = await createRegister(
        tx, AWARENESS_MAILINGS_KEY, MAILINGS_NAME,
        'Журнал отправок учебных писем: одна запись — одна отправка. Запись создаёт отметка «Отправлено» в карточке письма; историю прошлых рассылок можно ввести вручную или импортом Excel',
        MAILING_FIELDS, {},
      );
      done.push(`реестр «${reg.name}» (полей ${MAILING_FIELDS.length})`);
    }
    const fragment = await tx.awarenessFragment.findUnique({ where: { code: SIGNATURE_CODE } });
    if (!fragment) {
      await tx.awarenessFragment.create({ data: { code: SIGNATURE_CODE, ...SIGNATURE_PLACEHOLDER } });
      done.push('«Подпись ИБ» (заглушка)');
    }
    const limits = await tx.appSetting.findUnique({ where: { key: AWARENESS_LETTERS_KEY } });
    if (!limits) {
      await tx.appSetting.create({ data: { key: AWARENESS_LETTERS_KEY, value: { ...DEFAULT_LETTERS_SETTINGS } } });
      done.push('лимиты размера писем');
    }
    return `Учебные письма: ${done.join(', ')}`;
  });
}
