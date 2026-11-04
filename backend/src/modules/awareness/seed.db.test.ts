// Seed «Осведомлённости» (релиз 1.8.0, docs/specs/awareness.md, раздел 8): два системных реестра без записей,
// ключ сравнения, пороги; однократно; плиток и автоматизаций нет. Каждый тест — в транзакции с откатом.
import { describe, expect, it } from 'vitest';
import { seedAwareness } from '../../../prisma/seed/awareness.js';
import { inTx, must, type Tx } from '../../test/db.js';
import { AWARENESS_EMPLOYEES_KEY, AWARENESS_RESULTS_KEY, EMPLOYEE_FIELDS, RESULT_FIELDS } from './definition.js';
import { AWARENESS_GRADES_KEY, DEFAULT_GRADES } from './grades.js';

const reg = async (tx: Tx, systemKey: string) => must(
  await tx.register.findUnique({ where: { systemKey }, include: { fields: { include: { options: true }, orderBy: { sortOrder: 'asc' } } } }),
  systemKey,
);

describe('seed «Осведомлённости»', () => {
  it('реестры с системными полями по описанию, связь, ключ сравнения, пороги; записей, плиток и автоматизаций нет', () =>
    inTx(async (tx) => {
      const emp = await reg(tx, AWARENESS_EMPLOYEES_KEY);
      const res = await reg(tx, AWARENESS_RESULTS_KEY);
      expect(emp.fields.map((f) => f.systemKey)).toEqual(EMPLOYEE_FIELDS.map((f) => f.key));
      expect(res.fields.map((f) => f.systemKey)).toEqual(RESULT_FIELDS.map((f) => f.key));

      const ef = (k: string) => must(emp.fields.find((f) => f.systemKey === k), k);
      const rf = (k: string) => must(res.fields.find((f) => f.systemKey === k), k);
      expect(ef('tabNo').isImportKey).toBe(true);
      expect(ef('fullName').isTitle).toBe(true);
      // Текстовое измерение — по миграции text_dimension.
      expect([ef('dept').type, ef('dept').analyticsRole]).toEqual(['text', 'dimension']);
      expect(ef('status').options.map((o) => [o.label, o.systemKey, o.isClosed])).toEqual([['Работает', 'working', false], ['Уволен', 'fired', true]]);
      expect(emp.compareKeyFieldIds).toEqual([ef('tabNo').id]);

      expect(rf('attemptKey').isImportKey).toBe(true);
      expect(rf('employee').linkRegisterId).toBe(emp.id);
      expect([rf('percent').type, rf('percent').analyticsRole]).toEqual(['number', 'metric']);
      expect([rf('dept').type, rf('dept').analyticsRole]).toEqual(['text', 'dimension']);
      expect(rf('grade').options.map((o) => o.label)).toEqual(['Отлично', 'Хорошо', 'Удовлетворительно', 'Провал']);
      expect(rf('match').options.map((o) => o.systemKey)).toEqual(['exact', 'manual', 'none']);

      const ids = [emp.id, res.id];
      expect(await tx.registerRecord.count({ where: { registerId: { in: ids } } })).toBe(0);
      expect(await tx.dashboardTile.count({ where: { registerId: { in: ids } } })).toBe(0);
      expect(await tx.registerAutomation.count({ where: { registerId: { in: ids } } })).toBe(0);
      expect((await tx.appSetting.findUnique({ where: { key: AWARENESS_GRADES_KEY } }))?.value).toEqual(DEFAULT_GRADES);
    }));

  it('однократно: повторный запуск ничего не создаёт; без отметки, но с реестрами — тоже', () =>
    inTx(async (tx) => {
      const count = await tx.register.count();
      const fields = await tx.registerField.count();
      await seedAwareness(tx);
      await tx.seedMarker.delete({ where: { key: 'awareness.v1' } });
      await seedAwareness(tx);
      expect(await tx.register.count()).toBe(count);
      expect(await tx.registerField.count()).toBe(fields);
    }));

  it('изменённые пороги seed не перезаписывает', () =>
    inTx(async (tx) => {
      const own = { excellent: 85, good: 65, satisfactory: 45, retakeBelow: 60 };
      await tx.appSetting.update({ where: { key: AWARENESS_GRADES_KEY }, data: { value: own } });
      await tx.seedMarker.delete({ where: { key: 'awareness.v1' } });
      // Реестров «нет» (ключи сняты) — seed создаёт их заново, но пороги оставляет.
      await tx.register.updateMany({ where: { systemKey: { in: [AWARENESS_EMPLOYEES_KEY, AWARENESS_RESULTS_KEY] } }, data: { systemKey: null } });
      await seedAwareness(tx);
      expect((await tx.appSetting.findUnique({ where: { key: AWARENESS_GRADES_KEY } }))?.value).toEqual(own);
    }));

  it('свой реестр администратора с тем же названием — системный получает «(системный)»', () =>
    inTx(async (tx) => {
      // Прежние системные реестры становятся «своими» (ключ снят) и занимают названия.
      const before = await tx.register.findMany({ where: { systemKey: { in: [AWARENESS_EMPLOYEES_KEY, AWARENESS_RESULTS_KEY] } }, select: { name: true } });
      await tx.register.updateMany({ where: { systemKey: { in: [AWARENESS_EMPLOYEES_KEY, AWARENESS_RESULTS_KEY] } }, data: { systemKey: null } });
      await tx.seedMarker.delete({ where: { key: 'awareness.v1' } });
      await seedAwareness(tx);
      const emp = await reg(tx, AWARENESS_EMPLOYEES_KEY);
      const res = await reg(tx, AWARENESS_RESULTS_KEY);
      expect(before.map((r) => r.name).sort()).toEqual(['Результаты INDIGO', 'Сотрудники']);
      expect([emp.name, res.name]).toEqual(['Сотрудники (системный)', 'Результаты INDIGO (системный)']);
      // Связь — на новый реестр сотрудников, а не на прежний.
      expect(must(res.fields.find((f) => f.systemKey === 'employee')).linkRegisterId).toBe(emp.id);
    }));
});
