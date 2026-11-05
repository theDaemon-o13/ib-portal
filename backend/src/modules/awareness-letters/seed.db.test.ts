// Seed учебных писем (1.9.0, отметка awareness.v2; docs/specs/awareness.md, раздел 11): реестр «Рассылки» без записей,
// «Подпись ИБ» с заглушкой, лимиты awareness.letters, системная категория «Осведомлённость». Однократно.
// Каждый тест — в транзакции с откатом.
import { describe, expect, it } from 'vitest';
import { seedAwarenessLetters } from '../../../prisma/seed/awareness.js';
import { seedSystemItems } from '../../../prisma/seed/system-items.js';
import { inTx, must, type Tx } from '../../test/db.js';
import { AWARENESS_CATEGORY_KEY, AWARENESS_MAILINGS_KEY, MAILING_FIELDS, SIGNATURE_PLACEHOLDER } from './definition.js';
import { AWARENESS_LETTERS_KEY, DEFAULT_LETTERS_SETTINGS } from './settings.js';

const mailings = async (tx: Tx) => must(
  await tx.register.findUnique({ where: { systemKey: AWARENESS_MAILINGS_KEY }, include: { fields: { include: { options: true }, orderBy: { sortOrder: 'asc' } } } }),
  AWARENESS_MAILINGS_KEY,
);

describe('seed учебных писем', () => {
  it('реестр «Рассылки» по описанию, без записей; подпись — заглушка; лимиты по умолчанию; писем, шаблонов и правил нет', () =>
    inTx(async (tx) => {
      const reg = await mailings(tx);
      expect(reg.name).toBe('Рассылки');
      expect(reg.fields.map((f) => f.systemKey)).toEqual(MAILING_FIELDS.map((f) => f.key));
      const f = (k: string) => must(reg.fields.find((x) => x.systemKey === k), k);
      expect([f('sentOn').type, f('sentOn').analyticsRole]).toEqual(['date', 'date']);
      expect([f('subject').type, f('subject').isTitle]).toEqual(['text', true]);
      expect([f('audience').type, f('audience').analyticsRole]).toEqual(['text', 'dimension']);
      expect(f('preparedBy').type).toBe('user');
      expect([f('letter').type, f('task').type, f('reason').type]).toEqual(['text', 'text', 'text']);
      expect(f('kind').options.map((o) => [o.label, o.systemKey])).toEqual([['Плановое', 'planned'], ['Срочное', 'urgent']]);
      expect(reg.fields.some((x) => x.isImportKey || x.isStatus)).toBe(false);
      expect(await tx.registerRecord.count({ where: { registerId: reg.id } })).toBe(0);

      expect(await tx.awarenessFragment.findUnique({ where: { code: 'signature' } })).toMatchObject({ ...SIGNATURE_PLACEHOLDER, version: 1, updatedBy: null });
      expect((await tx.appSetting.findUnique({ where: { key: AWARENESS_LETTERS_KEY } }))?.value).toEqual({ maxImageKb: 1024, maxLetterKb: 2048, warnLetterKb: 1024 });
      expect(await tx.awarenessLetter.count()).toBe(0);
      expect(await tx.awarenessTemplate.count()).toBe(0);
      expect(await tx.awarenessScheduleRule.count()).toBe(0);
    }));

  it('категория задач «Осведомлённость» — системное значение', () =>
    inTx(async (tx) => {
      const c = await tx.catalogItem.findUniqueOrThrow({ where: { catalogCode_systemKey: { catalogCode: 'task_categories', systemKey: AWARENESS_CATEGORY_KEY } } });
      expect(c).toMatchObject({ value: 'Осведомлённость', isSystem: true, archivedAt: null });
    }));

  it('одноимённая категория администратора становится системной — с записью в журнале, без дубля (ответ 5)', () =>
    inTx(async (tx) => {
      // Как будто администратор завёл «Осведомлённость» сам до 1.9.0.
      const item = await tx.catalogItem.findUniqueOrThrow({ where: { catalogCode_systemKey: { catalogCode: 'task_categories', systemKey: AWARENESS_CATEGORY_KEY } } });
      await tx.catalogItem.update({ where: { id: item.id }, data: { systemKey: null, isSystem: false } });
      const before = await tx.catalogItem.count({ where: { catalogCode: 'task_categories' } });
      await seedSystemItems(tx);
      expect(await tx.catalogItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ systemKey: AWARENESS_CATEGORY_KEY, isSystem: true });
      expect(await tx.catalogItem.count({ where: { catalogCode: 'task_categories' } })).toBe(before);
      const audit = await tx.auditLog.findFirstOrThrow({ where: { action: 'catalog.item_made_system', entityId: item.id } });
      expect((audit.diff as { summary: string }).summary).toMatch(/«Осведомлённость».*учебных писем/);
    }));

  it('однократно: повторный запуск ничего не создаёт; без отметки, но с реестром, подписью и лимитами — тоже не меняет', () =>
    inTx(async (tx) => {
      const counts = async () => [await tx.register.count(), await tx.registerField.count(), await tx.awarenessFragment.count(), await tx.appSetting.count()];
      const before = await counts();
      await tx.awarenessFragment.update({ where: { code: 'signature' }, data: { htmlRu: '<p>Своя подпись</p>', version: { increment: 1 } } });
      const own = { maxImageKb: 512, maxLetterKb: 1536, warnLetterKb: 768 };
      await tx.appSetting.update({ where: { key: AWARENESS_LETTERS_KEY }, data: { value: own } });
      await seedAwarenessLetters(tx);
      await tx.seedMarker.delete({ where: { key: 'awareness.v2' } });
      await seedAwarenessLetters(tx);
      expect(await counts()).toEqual(before);
      expect((await tx.awarenessFragment.findUniqueOrThrow({ where: { code: 'signature' } })).htmlRu).toBe('<p>Своя подпись</p>');
      expect((await tx.appSetting.findUniqueOrThrow({ where: { key: AWARENESS_LETTERS_KEY } })).value).toEqual(own);
    }));

  it('свой реестр администратора «Рассылки» — системный получает «(системный)»', () =>
    inTx(async (tx) => {
      await tx.register.update({ where: { systemKey: AWARENESS_MAILINGS_KEY }, data: { systemKey: null } });
      await tx.seedMarker.delete({ where: { key: 'awareness.v2' } });
      await seedAwarenessLetters(tx);
      expect((await mailings(tx)).name).toBe('Рассылки (системный)');
      expect(await tx.register.count({ where: { name: 'Рассылки', systemKey: null } })).toBe(1);
    }));

  it('лимиты: значения по умолчанию — из DEFAULT_LETTERS_SETTINGS', () => {
    expect(DEFAULT_LETTERS_SETTINGS).toEqual({ maxImageKb: 1024, maxLetterKb: 2048, warnLetterKb: 1024 });
  });
});
