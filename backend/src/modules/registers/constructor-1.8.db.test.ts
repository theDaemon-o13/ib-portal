// Доработки конструктора 1.8.0 (docs/specs/awareness.md, раздел 7) на обычных реестрах — правила общие:
// текстовое измерение (виджет и фильтр f=), фильтр lopen=, метка закрывающего статуса у связи, выгрузка и обратный импорт.
// И «существующие реестры не меняются»: связи без закрывающего статуса, фильтр по списку. Каждый тест — в транзакции.
import { describe, expect, it } from 'vitest';
import { expectCode, inTx, must, type Tx } from '../../test/db.js';
import { makeRegister, type Fixture } from '../../test/registers-fixture.js';
import { widgetData } from '../dashboard/service.js';
import { registerAnalytics } from './analytics.service.js';
import { loadRegister, type RegisterDef } from './definition.js';
import * as excel from './excel.service.js';
import { countRecords, parseRecordFilter, RecordFilterQuery } from './filter.js';
import * as records from './records.service.js';
import * as structure from './structure.service.js';

/** Фильтр из ссылки виджета и число записей по нему — тем же кодом, что total списка. */
async function countByLink(tx: Tx, reg: RegisterDef, link: string): Promise<{ count: number; total: number }> {
  const params = Object.fromEntries(new URLSearchParams(link.slice(link.indexOf('?') + 1, link.indexOf('#'))));
  const filter = parseRecordFilter(reg, RecordFilterQuery.parse(params));
  const list = await records.listRecords(tx, reg.id, { limit: 1000, filter });
  return { count: await countRecords(tx, reg, filter), total: list.total };
}

async function withText(tx: Tx, fx: Fixture, extra: Parameters<typeof structure.addField>[3] = { label: 'Подразделение', type: 'text', analyticsRole: 'dimension' }) {
  const reg = await structure.addField(tx, fx.actor, fx.reg.id, extra);
  return must(reg.fields.find((f) => f.label === extra.label)).id;
}

const make = (tx: Tx, fx: Fixture, values: Record<string, unknown>) => records.createRecord(tx, fx.actor, fx.reg.id, { values });

describe('текстовое измерение (7.1)', () => {
  it('роль у однострочного текста можно, у многострочного — нет (создание и правка)', () =>
    inTx(async (tx) => {
      const fx = await makeRegister(tx);
      expect(await withText(tx, fx)).toBeTruthy();
      await expectCode(structure.addField(tx, fx.actor, fx.reg.id, { label: 'Описание', type: 'text', analyticsRole: 'dimension', settings: { text: { multiline: true } } }), 'BAD_ANALYTICS_ROLE');
      const multi = must((await structure.addField(tx, fx.actor, fx.reg.id, { label: 'Заметки', type: 'text', settings: { text: { multiline: true } } })).fields.find((f) => f.label === 'Заметки'));
      await expectCode(structure.updateField(tx, fx.actor, multi.id, { version: multi.version, analyticsRole: 'dimension' }), 'BAD_ANALYTICS_ROLE');
      const dim = must((await loadRegister(tx, fx.reg.id)).fields.find((f) => f.label === 'Подразделение'));
      await expectCode(structure.updateField(tx, fx.actor, dim.id, { version: dim.version, settings: { text: { multiline: true } } }), 'BAD_ANALYTICS_ROLE');
    }));

  it('виджет: группы по нормализованному значению, подпись — частое написание; числа = total списка по ссылке', () =>
    inTx(async (tx) => {
      const fx = await makeRegister(tx);
      const dept = await withText(tx, fx);
      // Написание группы — самое частое: «Отдел Ёлок» дважды против одного «отдел елок».
      const values = ['Отдел тестирования', 'отдел  тестирования', 'Отдел тестирования', 'ОТДЕЛ ТЕСТИРОВАНИЯ', 'Отдел Ёлок', 'отдел елок', 'Отдел Ёлок', 'Отдел\u00a0проверки, связи', ' '];
      for (const [i, v] of values.entries()) await make(tx, fx, { [fx.f.title]: `З${i}`, [dept]: v });
      await make(tx, fx, { [fx.f.title]: 'Без отдела' });
      const reg = await loadRegister(tx, fx.reg.id);
      const w = await widgetData(tx, `field:${dept}`);
      expect(w.rows.map((r) => [r.label, r.count])).toEqual([
        ['Отдел тестирования', 4], ['Отдел Ёлок', 3], ['Отдел проверки, связи', 1], ['Не заполнено', 2],
      ]);
      expect(w.total).toBe(10);
      for (const r of w.rows) {
        const n = await countByLink(tx, reg, must(r.link));
        expect([r.label, n.count, n.total]).toEqual([r.label, r.count, r.count]);
      }
      // Предпросмотр «Попадёт на дашборд» — те же группы.
      const preview = must((await registerAnalytics(tx, fx.reg.id)).find((x) => x.fieldId === dept));
      expect(preview.rows.map((r) => [r.label, r.count])).toEqual([['Отдел тестирования', 4], ['Отдел Ёлок', 3], ['Отдел проверки, связи', 1]]);
      expect(preview.empty).toBe(2);
    }));

  it('12 самых частых, затем «Остальные: N» без ссылки', () =>
    inTx(async (tx) => {
      const fx = await makeRegister(tx);
      const dept = await withText(tx, fx);
      for (let d = 0; d < 14; d++) {
        for (let k = 0; k <= 14 - d; k++) await make(tx, fx, { [fx.f.title]: `${d}-${k}`, [dept]: `Отдел ${String(d).padStart(2, '0')}` });
      }
      const w = await widgetData(tx, `field:${dept}`);
      expect(w.rows).toHaveLength(13);
      expect(w.rows[0]).toMatchObject({ label: 'Отдел 00', count: 15 });
      expect(w.rows[12]).toMatchObject({ label: 'Остальные: 2', count: 3 + 2, link: null });
    }));

  it('фильтр f= по тексту: целиком (с запятыми), без регистра, пробелов и «ё»; без роли — 400', () =>
    inTx(async (tx) => {
      const fx = await makeRegister(tx);
      const dept = await withText(tx, fx);
      const plain = await withText(tx, fx, { label: 'Комментарий', type: 'text' });
      await make(tx, fx, { [fx.f.title]: 'а', [dept]: 'Отдел проверки, связи' });
      await make(tx, fx, { [fx.f.title]: 'б', [dept]: 'ОТДЕЛ  ПРОВЕРКИ, СВЯЗИ' });
      await make(tx, fx, { [fx.f.title]: 'в', [dept]: 'Отдел проверки' });
      const reg = await loadRegister(tx, fx.reg.id);
      const count = (f: string) => countRecords(tx, reg, parseRecordFilter(reg, { f }));
      expect(await count(`${dept}:отдел проверки,  связи`)).toBe(2);
      expect(await count(`${dept}:Отдел проверки`)).toBe(1);
      expect(await count(`${dept}:empty`)).toBe(0);
      expect(() => parseRecordFilter(reg, { f: `${plain}:x` })).toThrow(/фильтр по значению недоступен/);
      expect(() => parseRecordFilter(reg, { f: `${dept}:   ` })).toThrow(/укажите значение/);
    }));
});

/** Реестр «Люди» со статусом и реестр «Попытки» со связью на него. */
async function linked(tx: Tx) {
  const people = await makeRegister(tx, `Люди ${Date.now().toString(36)}`);
  const attempts = await makeRegister(tx, `Попытки ${Date.now().toString(36)}`);
  const reg = await structure.addField(tx, attempts.actor, attempts.reg.id, { label: 'Человек', type: 'link', linkRegisterId: people.reg.id });
  const link = must(reg.fields.find((f) => f.label === 'Человек')).id;
  const person = async (title: string, status: string) => (await records.createRecord(tx, people.actor, people.reg.id, { values: { [people.f.title]: title, [people.f.status]: people.opt('status', status) } })).id;
  const attempt = async (title: string, ids: string[] | null) => records.createRecord(tx, attempts.actor, attempts.reg.id, { values: { [attempts.f.title]: title, ...(ids ? { [link]: ids } : {}) } });
  return { people, attempts, link, person, attempt };
}

describe('lopen= и метка закрывающего статуса (7.5, 7.6)', () => {
  it('lopen: пустая связь, открытая и удалённая закрытая — в списке; живая закрытая — нет; число = total', () =>
    inTx(async (tx) => {
      const x = await linked(tx);
      const open = await x.person('Иванов Иван Иванович', 'В работе');
      const closed = await x.person('Петров Пётр Петрович', 'Закрыт');
      const gone = await x.person('Сидоров Сергей Сергеевич', 'Закрыт');
      await x.attempt('без связи', null);
      await x.attempt('открытый', [open]);
      await x.attempt('закрытый', [closed]);
      await x.attempt('удалённый', [gone]);
      // Удалённая связанная запись (мягкое удаление): закрытой она не считается.
      await tx.registerRecord.update({ where: { id: gone }, data: { deletedAt: new Date() } });
      const reg = await loadRegister(tx, x.attempts.reg.id);
      const filter = parseRecordFilter(reg, { lopen: x.link });
      const list = await records.listRecords(tx, reg.id, { limit: 100, filter });
      expect(list.items.map((r) => r.values[x.attempts.f.title]).sort()).toEqual(['без связи', 'открытый', 'удалённый']);
      expect(await countRecords(tx, reg, filter)).toBe(3);
      expect(list.total).toBe(3);
      expect(() => parseRecordFilter(reg, { lopen: x.attempts.f.title })).toThrow(/не связь/);
    }));

  it('связь на закрытую запись — с меткой статуса; на открытую — как раньше', () =>
    inTx(async (tx) => {
      const x = await linked(tx);
      const open = await x.person('Иванов Иван Иванович', 'В работе');
      const closed = await x.person('Петров Пётр Петрович', 'Закрыт');
      const a = await records.getRecord(tx, (await x.attempt('а', [open, closed])).id);
      const [o, c] = a.links[x.link] ?? [];
      expect(o).toMatchObject({ title: 'Иванов Иван Иванович', closedLabel: null });
      expect(c).toMatchObject({ title: 'Петров Пётр Петрович', closedLabel: 'закрыт' });
      const n = (id: string) => a.links[x.link]?.find((l) => l.id === id)?.number;
      expect(a.display[x.link]).toBe(`#${n(open)} Иванов Иван Иванович; #${n(closed)} Петров Пётр Петрович (закрыт)`);
    }));

  it('выгрузка подписывает закрытую запись меткой; обратный импорт находит обе — ничего не меняется', () =>
    inTx(async (tx) => {
      const x = await linked(tx);
      const open = await x.person('Иванов Иван Иванович', 'В работе');
      const closed = await x.person('Петров Пётр Петрович', 'Закрыт');
      await x.attempt('а', [open]);
      await x.attempt('б', [closed]);
      const file = await excel.exportRegister(tx, x.attempts.reg.id);
      const wb = await excel.readWorkbook(file.buffer);
      const ws = must(wb.worksheets[0]);
      const col = (ws.getRow(1).values as unknown[]).findIndex((v) => v === 'Человек');
      const cells = (ws.getColumn(col).values ?? []).slice(2).map(String).sort();
      expect(cells).toEqual(['Иванов Иван Иванович', 'Петров Пётр Петрович (закрыт)']);
      const pre = await excel.previewImport(tx, x.attempts.actor, x.attempts.reg.id, file.buffer, file.fileName);
      expect(pre.summary.errors).toEqual([]);
      expect([pre.summary.added, pre.summary.updated, pre.summary.unchanged]).toEqual([0, 0, 2]);
    }));
});

describe('существующие реестры не меняются', () => {
  it('фильтр f= по списку и виджет списка — как раньше', () =>
    inTx(async (tx) => {
      const fx = await makeRegister(tx);
      await make(tx, fx, { [fx.f.title]: 'а', [fx.f.level]: fx.opt('level', 'Высокий') });
      await make(tx, fx, { [fx.f.title]: 'б', [fx.f.level]: fx.opt('level', 'Средний') });
      await make(tx, fx, { [fx.f.title]: 'в' });
      const reg = await loadRegister(tx, fx.reg.id);
      expect(await countRecords(tx, reg, parseRecordFilter(reg, { f: `${fx.f.level}:${fx.opt('level', 'Высокий')},empty` }))).toBe(2);
      const w = await widgetData(tx, `field:${fx.f.level}`);
      expect(w.rows.map((r) => [r.label, r.count])).toEqual([['Высокий', 1], ['Средний', 1], ['Низкий', 0], ['Не заполнено', 1]]);
      // Текстовое поле без роли — без виджета.
      await withText(tx, fx, { label: 'Комментарий', type: 'text' });
      const comment = must((await loadRegister(tx, fx.reg.id)).fields.find((f) => f.label === 'Комментарий'));
      expect((await registerAnalytics(tx, fx.reg.id)).some((x) => x.fieldId === comment.id)).toBe(false);
    }));
});
