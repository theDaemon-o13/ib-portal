import { describe, expect, it } from 'vitest';
import { addWorkingDays, isoDate, parseIsoDate } from '../../lib/working-days.js';
import { actorFor, expectCode, inTx, lastAudit, makeUser } from '../../test/db.js';
import * as svc from './service.js';

describe('производственный календарь', () => {
  it('seed: постоянные праздники РТ на 2026 и 2027, пятидневка', () =>
    inTx(async (tx) => {
      for (const year of [2026, 2027]) {
        const days = await svc.listDays(tx, year);
        expect(days.map((d) => d.day.slice(5))).toEqual([
          '01-01', '03-08', '03-21', '03-22', '03-23', '03-24', '05-01', '05-09', '06-27', '09-09', '11-06',
        ]);
        expect(days.every((d) => d.kind === 'holiday')).toBe(true);
      }
      expect((await svc.getWorkWeek(tx)).weekendDays).toEqual([6, 7]);
    }));

  it('Иди Рамазон и перенос добавляет администратор; срок считается по календарю', () =>
    inTx(async (tx) => {
      const actor = await actorFor(tx, (await makeUser(tx, ['super_admin'])).id);
      await svc.createDay(tx, actor, { day: '2026-03-20', kind: 'holiday', title: 'Иди Рамазон' });
      await svc.createDay(tx, actor, { day: '2026-03-28', kind: 'workday', title: 'Перенос рабочего дня' });
      await expectCode(svc.createDay(tx, actor, { day: '2026-03-20', kind: 'holiday', title: 'Ещё' }), 'DUPLICATE');
      await expectCode(svc.createDay(tx, actor, { day: '2026-02-30', kind: 'holiday', title: 'Нет такой даты' }), 'BAD_DATE');

      const cal = await svc.loadWorkCalendar(tx, parseIsoDate('2026-03-01'), parseIsoDate('2026-04-30'));
      // чт 19.03 + 1 рабочий день: пт 20.03 — Иди Рамазон, 21–24.03 — Навруз → ср 25.03
      expect(isoDate(addWorkingDays(parseIsoDate('2026-03-19'), 1, cal))).toBe('2026-03-25');
      // пт 27.03 + 1: суббота 28.03 — рабочая по переносу
      expect(isoDate(addWorkingDays(parseIsoDate('2026-03-27'), 1, cal))).toBe('2026-03-28');
    }));

  it('выходные дни недели — настройка с защитой от одновременной правки', () =>
    inTx(async (tx) => {
      const actor = await actorFor(tx, (await makeUser(tx, ['super_admin'])).id);
      const week = await svc.getWorkWeek(tx);
      const six = await svc.setWorkWeek(tx, actor, { weekendDays: [7], version: week.version });
      expect(six.weekendDays).toEqual([7]);
      expect((await lastAudit(tx)).diff).toMatchObject({ summary: expect.stringContaining('сб, вс → вс') });
      await expectCode(svc.setWorkWeek(tx, actor, { weekendDays: [6, 7], version: week.version }), 'VERSION_CONFLICT');
      await expectCode(svc.setWorkWeek(tx, actor, { weekendDays: [1, 2, 3, 4, 5, 6, 7], version: six.version }), 'NO_WORKDAYS');
    }));

  it('запись можно исправить и удалить (мягко)', () =>
    inTx(async (tx) => {
      const actor = await actorFor(tx, (await makeUser(tx, ['super_admin'])).id);
      const d = await svc.createDay(tx, actor, { day: '2026-05-27', kind: 'holiday', title: 'Иди Курбон' });
      const moved = await svc.updateDay(tx, actor, d.id, { version: d.version, day: '2026-05-26' });
      expect(moved.day).toBe('2026-05-26');
      await svc.deleteDay(tx, actor, d.id, moved.version);
      expect((await svc.listDays(tx, 2026)).map((x) => x.title)).not.toContain('Иди Курбон');
      expect((await tx.workCalendarDay.findUniqueOrThrow({ where: { id: d.id } })).deletedAt).not.toBeNull();
    }));
});
