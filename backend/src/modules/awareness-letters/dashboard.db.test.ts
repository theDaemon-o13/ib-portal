// «Ближайшая рассылка», счётчики и показатели монитора с настоящей БД (1.9.0, шаг 9; docs/specs/awareness.md, раздел 20).
// 2041 год: календаря нет; 15.01.2041 — вторник. Всё вымышленное.
import { describe, expect, it } from 'vitest';
import { actorFor, inTx, makeUser, type Tx } from '../../test/db.js';
import { computeKpis, DASHBOARD_KPIS, listWidgets, widgetData } from '../dashboard/service.js';
import { awarenessKpis, nextMailingWidget, sentThisYear, whenText } from './dashboard.js';
import * as letters from './letters.service.js';
import * as rules from './rules.service.js';
import { runAwarenessSchedule } from './schedule.service.js';
import { SIGNATURE_BLOCK } from './variables.js';

const NOW = new Date('2041-01-04T06:00:00Z');
const both = { subjectRu: 'Тема', subjectTj: 'Мавзӯъ', htmlRu: `<p>Текст</p>${SIGNATURE_BLOCK}`, htmlTj: `<p>Матн</p>${SIGNATURE_BLOCK}` };

async function setup(tx: Tx) {
  const worker = await actorFor(tx, (await makeUser(tx, ['ib_staff'])).id);
  const head = await actorFor(tx, (await makeUser(tx, ['ib_staff', 'ib_head'], { isIbHead: true })).id);
  const role = await tx.role.create({ data: { name: 'Рассылки дашборд', permissions: { create: [{ permissionCode: 'ib.work' }] } } });
  await tx.userRole.create({ data: { userId: worker.id, roleId: role.id } });
  return { worker, head, role };
}

describe('дашборд и монитор: учебные письма', () => {
  it('нет открытых запусков — «Запланированных рассылок нет»; показатель пустой', () =>
    inTx(async (tx) => {
      const w = await nextMailingWidget(tx, '2041-01-04');
      expect([w.stats[0]?.label, w.stats[0]?.value, w.items, w.total]).toEqual(['Запланированных рассылок нет', null, [], null]);
      const k = await awarenessKpis(tx, '2041-01-04');
      expect(k.map((x) => [x.key, x.value, x.tone])).toEqual([['awareness_next', null, null], ['awareness_overdue', 0, null]]);
      expect(whenText(0)).toBe('сегодня');
      expect(whenText(-2)).toBe('просрочено на 2 дн.');
    }));

  it('ближайшая рассылка: «через N дн.», три этапа; просроченный этап — красным и в счётчике; отправлено — запуск закрыт', () =>
    inTx(async (tx) => {
      const { worker, head, role } = await setup(tx);
      await rules.createRule(tx, worker, { title: 'Ежемесячная', cadence: { kind: 'monthly', day: 15 }, startsOn: '2041-01-01', roleId: role.id, leadDays: 14 }, NOW);
      await runAwarenessSchedule(tx, { now: NOW });
      const run = await tx.awarenessScheduleRun.findFirstOrThrow({ where: { rule: { title: 'Ежемесячная' } } });

      const w = await nextMailingWidget(tx, '2041-01-04');
      expect([w.stats[0]?.label, w.stats[0]?.value, w.stats[0]?.tone, w.link]).toEqual(['Ежемесячная, через 11 дн.', 11, null, `/tasks?task=${run.taskId}`]);
      expect(w.items.map((i) => [i.title, i.sub])).toEqual([['Черновик', 'до 08.01.2041'], ['Согласование', 'до 11.01.2041'], ['Отправка', 'до 15.01.2041']]);

      // 12.01: черновик (08.01) и согласование (11.01) не выполнены — просрочены.
      const late = await nextMailingWidget(tx, '2041-01-12');
      expect([late.stats[0]?.tone, late.stats[3]?.value, late.stats[3]?.tone, late.items[0]?.sub]).toEqual(['crit', 1, 'crit', 'просрочен · до 08.01.2041']);
      const k = await awarenessKpis(tx, '2041-01-12');
      expect(k.map((x) => [x.key, x.value, x.tone])).toEqual([['awareness_next', 3, 'bad'], ['awareness_overdue', 1, 'bad']]);
      expect(k[0]?.source).toBe('Ежемесячная — 15.01.2041');

      // Письмо отправлено — запуск больше не открыт.
      const { letter } = await letters.createLetter(tx, worker, { title: 'Январь', kind: 'planned', ...both }, {}, { taskId: run.taskId });
      const s = await letters.submitLetter(tx, worker, letter.id, { version: letter.version });
      const a = await letters.approveLetter(tx, head, letter.id, { version: s.version });
      await letters.sendLetter(tx, worker, letter.id, { version: a.version, sentOn: '2041-01-04', audience: 'Все сотрудники' }, { now: () => NOW });
      expect((await nextMailingWidget(tx, '2041-01-12')).stats[0]?.label).toBe('Запланированных рассылок нет');
    }));

  it('«Отправлено писем за год»: каждая отметка по дате отправки, по типу; прошлый год не считается', () =>
    inTx(async (tx) => {
      const { worker, head } = await setup(tx);
      const send = async (kind: 'planned' | 'urgent', sentOn: string) => {
        if (kind === 'urgent') {
          const u = await letters.urgentMailing(tx, worker, { title: 'Срочно', reason: 'Инцидент' }, { now: () => NOW });
          const f = await letters.saveLetter(tx, worker, u.letter.id, { version: u.letter.version, ...both });
          return letters.sendLetter(tx, worker, u.letter.id, { version: f.letter.version, sentOn, audience: 'Все сотрудники', comment: 'Отправлено без согласования: срочно' }, { now: () => NOW });
        }
        const { letter } = await letters.createLetter(tx, worker, { title: 'План', kind: 'planned', ...both });
        const s = await letters.submitLetter(tx, worker, letter.id, { version: letter.version });
        const a = await letters.approveLetter(tx, head, letter.id, { version: s.version });
        return letters.sendLetter(tx, worker, letter.id, { version: a.version, sentOn, audience: 'Все сотрудники' }, { now: () => NOW });
      };
      const p = await send('planned', '2041-01-04');
      await letters.sendLetter(tx, worker, p.id, { version: p.version, sentOn: '2041-01-04', audience: 'Отдел кадров' }, { now: () => NOW });
      await send('urgent', '2041-01-03');
      await send('planned', '2040-12-31');
      expect(await sentThisYear(tx, '2041-01-04')).toEqual({ year: 2041, planned: 2, urgent: 1 });
      const w = await nextMailingWidget(tx, '2041-01-04');
      expect(w.stats.slice(1, 3).map((x) => [x.label, x.value])).toEqual([['Отправлено писем за 2041: плановых', 2], ['Отправлено писем за 2041: срочных', 1]]);
    }));

  it('виджет в списке дашборда; показатели монитора — в KPI, но не в KPI дашборда', () =>
    inTx(async (tx) => {
      expect((await listWidgets(tx)).find((w) => w.key === 'awareness.next')).toMatchObject({ kind: 'list', registerId: null });
      expect((await widgetData(tx, 'awareness.next')).title).toBe('Ближайшая рассылка');
      const keys = (await computeKpis(tx)).map((k) => k.key);
      expect(keys).toEqual(expect.arrayContaining(['awareness_next', 'awareness_overdue']));
      expect(DASHBOARD_KPIS).not.toContain('awareness_next');
      expect(DASHBOARD_KPIS.length).toBe(8);
    }));
});
