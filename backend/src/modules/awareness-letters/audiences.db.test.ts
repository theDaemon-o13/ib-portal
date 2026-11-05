// Подсказки аудитории (1.9.0, шаг 12.0; docs/specs/awareness.md, раздел 13.4): «Все сотрудники», подразделения
// работающих сотрудников, прежние аудитории; одно написание на значение. Подразделения вымышленные, с меткой прогона.
import { describe, expect, it } from 'vitest';
import { actorFor, inTx, makeUser, must, type Tx } from '../../test/db.js';
import { AWARENESS_EMPLOYEES_KEY } from '../awareness/definition.js';
import { createRecord } from '../registers/records.service.js';
import { audienceSuggestions } from './audiences.js';
import * as letters from './letters.service.js';
import { SIGNATURE_BLOCK } from './variables.js';

const TAG = `Т${Date.now().toString(36)}`;
const both = { subjectRu: 'Тема', subjectTj: 'Мавзӯъ', htmlRu: `<p>Текст</p>${SIGNATURE_BLOCK}`, htmlTj: `<p>Матн</p>${SIGNATURE_BLOCK}` };

async function employee(tx: Tx, actor: Awaited<ReturnType<typeof actorFor>>, n: number, dept: string, fired = false) {
  const reg = await tx.register.findUniqueOrThrow({ where: { systemKey: AWARENESS_EMPLOYEES_KEY }, include: { fields: { include: { options: true } } } });
  const f = (k: string) => must(reg.fields.find((x) => x.systemKey === k));
  const status = f('status');
  await createRecord(tx, actor, reg.id, {
    values: {
      [f('tabNo').id]: `${TAG}-${n}`, [f('fullName').id]: `Сотрудник${TAG} ${n} Тестович`, [f('dept').id]: dept,
      [status.id]: must(status.options.find((o) => o.systemKey === (fired ? 'fired' : 'working'))).id,
    },
  });
}

describe('подсказки аудитории', () => {
  it('«Все сотрудники» первым; подразделения работающих — одно написание; прежние аудитории; поиск без регистра и «ё»', () =>
    inTx(async (tx) => {
      const admin = await actorFor(tx, (await makeUser(tx, ['super_admin'])).id);
      const head = await actorFor(tx, (await makeUser(tx, ['ib_staff', 'ib_head'], { isIbHead: true })).id);
      await employee(tx, admin, 1, `Отдел кадров ${TAG}`);
      await employee(tx, admin, 2, `отдел  кадров ${TAG}`);
      await employee(tx, admin, 3, `Отдел кадров ${TAG}`);
      await employee(tx, admin, 4, `Казначейство ${TAG}`);
      await employee(tx, admin, 5, `Уволенный отдел ${TAG}`, true);

      const { letter } = await letters.createLetter(tx, head, { title: 'Для аудитории', kind: 'planned', ...both });
      const s = await letters.submitLetter(tx, head, letter.id, { version: letter.version });
      const a = await letters.approveLetter(tx, head, letter.id, { version: s.version });
      const now = new Date('2041-01-04T06:00:00Z');
      const sent = await letters.sendLetter(tx, head, letter.id, { version: a.version, sentOn: '2041-01-04', audience: `Филиал Ёлки ${TAG}` }, { now: () => now });
      await letters.sendLetter(tx, head, letter.id, { version: sent.version, sentOn: '2041-01-04', audience: `ОТДЕЛ КАДРОВ ${TAG}` }, { now: () => now });

      const all = (await audienceSuggestions(tx)).items;
      expect(all[0]).toEqual({ value: 'Все сотрудники', source: 'all', count: 0 });
      const mine = all.filter((x) => x.value.includes(TAG));
      expect(mine).toEqual([
        { value: `Отдел кадров ${TAG}`, source: 'dept', count: 3 },
        { value: `Казначейство ${TAG}`, source: 'dept', count: 1 },
        { value: `Филиал Ёлки ${TAG}`, source: 'previous', count: 1 },
      ]);
      expect((await audienceSuggestions(tx, `филиал елки ${TAG.toLowerCase()}`)).items.map((x) => x.value)).toEqual([`Филиал Ёлки ${TAG}`]);
      expect((await audienceSuggestions(tx, 'все')).items.map((x) => x.value)).toContain('Все сотрудники');
    }));
});
