// Проверки целостности учебных писем (1.9.0, шаг 10): на корректных данных — все зелёные, на испорченных —
// срабатывает каждая. Портят тесты только то, что разрешено роли приложения (триггеры их не запрещают).
import { describe, expect, it } from 'vitest';
import { actorFor, inTx, makeUser, must, type Tx } from '../../test/db.js';
import { letterIntegrity } from './integrity.js';
import * as letters from './letters.service.js';
import * as rules from './rules.service.js';
import { runAwarenessSchedule } from './schedule.service.js';
import { SIGNATURE_BLOCK } from './variables.js';

const NOW = new Date('2041-01-04T06:00:00Z');
const both = { subjectRu: 'Тема', subjectTj: 'Мавзӯъ', htmlRu: `<p>Текст</p>${SIGNATURE_BLOCK}`, htmlTj: `<p>Матн</p>${SIGNATURE_BLOCK}` };

async function failing(tx: Tx): Promise<string[]> {
  return (await letterIntegrity(tx)).filter((c) => !c.ok).map((c) => c.label);
}

describe('check-integrity: учебные письма', () => {
  it('корректные данные — все проверки проходят; испорченные — срабатывает своя проверка', () =>
    inTx(async (tx) => {
      const worker = await actorFor(tx, (await makeUser(tx, ['ib_staff'])).id);
      const head = await actorFor(tx, (await makeUser(tx, ['ib_staff', 'ib_head'], { isIbHead: true })).id);
      const role = await tx.role.create({ data: { name: 'Рассылки целостность', permissions: { create: [{ permissionCode: 'ib.work' }] } } });
      await tx.userRole.create({ data: { userId: worker.id, roleId: role.id } });
      await rules.createRule(tx, worker, { title: 'Проверка', cadence: { kind: 'monthly', day: 15 }, startsOn: '2041-01-01', roleId: role.id, leadDays: 14 }, NOW);
      await runAwarenessSchedule(tx, { now: NOW });
      const run = await tx.awarenessScheduleRun.findFirstOrThrow({ where: { rule: { title: 'Проверка' } } });
      const { letter } = await letters.createLetter(tx, worker, { title: 'Целостность', kind: 'planned', ...both }, {}, { taskId: run.taskId });
      const s = await letters.submitLetter(tx, worker, letter.id, { version: letter.version });
      const a = await letters.approveLetter(tx, head, letter.id, { version: s.version });
      const sent = await letters.sendLetter(tx, worker, letter.id, { version: a.version, sentOn: '2041-01-04', audience: 'Все сотрудники' }, { now: () => NOW });

      const all = await letterIntegrity(tx);
      expect(all.length).toBeGreaterThanOrEqual(11);
      expect(all.filter((c) => !c.ok)).toEqual([]);

      // Запись «Рассылок» удалили в обход портала.
      await tx.registerRecord.update({ where: { id: must(must(sent.events[0]).record).id }, data: { deletedAt: new Date() } });
      // Роль правила потеряла ib.work.
      await tx.rolePermission.deleteMany({ where: { roleId: role.id } });
      // Пропуск в номерах версий (у незамороженного письма вставка разрешена).
      const { letter: draft } = await letters.createLetter(tx, worker, { title: 'С пропуском', kind: 'planned', ...both });
      await tx.awarenessLetterVersion.create({ data: { letterId: draft.id, no: 5, reason: 'edit', createdBy: worker.id, ...both } });
      // Задача запуска удалена в обход портала.
      await tx.task.update({ where: { id: run.taskId }, data: { deletedAt: new Date() } });

      expect((await failing(tx)).sort()).toEqual([
        'расписание: роль-исполнитель правил участвует в работе (ib.work, не служебная)',
        'расписание: у каждого запуска есть задача',
        'учебные письма: записи «Рассылок» из отметок «Отправлено» на месте',
        'учебные письма: номера версий без пропусков',
      ].sort());
      const gap = must((await letterIntegrity(tx)).find((c) => c.label === 'учебные письма: номера версий без пропусков'));
      expect(gap.hint).toBe(`№ ${draft.number}`);
    }));
});
