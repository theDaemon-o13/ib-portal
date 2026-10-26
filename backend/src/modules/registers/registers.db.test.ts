import { describe, expect, it } from 'vitest';
import { expectCode, inTx, lastAudit, makeUser } from '../../test/db.js';
import { makeRegister } from '../../test/registers-fixture.js';
import { loadRegister } from './definition.js';
import * as records from './records.service.js';
import * as structure from './structure.service.js';

describe('реестры', () => {
  it('seed: стартовый «Реестр инцидентов» со структурой из прототипа', () =>
    inTx(async (tx) => {
      const list = await structure.listRegisters(tx, { includeArchived: false });
      const inc = list.find((r) => r.name === 'Реестр инцидентов');
      expect(inc).toMatchObject({ fieldCount: 6, recordCount: 0, archived: false });
      const reg = await loadRegister(tx, inc?.id as string);
      expect(reg.fields.map((f) => [f.label, f.type])).toEqual([
        ['Инцидент', 'text'], ['Тип', 'select'], ['Уровень', 'select'], ['Дата выявления', 'date'], ['Статус', 'select'], ['Ответственный', 'user'],
      ]);
      const status = reg.fields.find((f) => f.isStatus);
      expect(status?.options.filter((o) => o.isClosed).map((o) => o.label)).toEqual(['Закрыт']);
      expect(reg.fields.find((f) => f.isTitle)?.label).toBe('Инцидент');
    }));

  it('новый реестр сразу с заголовком и статусом; имя уникально; архив запрещает изменения', () =>
    inTx(async (tx) => {
      const x = await makeRegister(tx, 'Реестр доступов');
      expect(x.reg.fields.slice(0, 2).map((f) => [f.label, f.isTitle, f.isStatus])).toEqual([['Наименование', true, false], ['Статус', false, true]]);
      await expectCode(structure.createRegister(tx, x.actor, { name: 'реестр ДОСТУПОВ' }), 'DUPLICATE');
      const renamed = await structure.updateRegister(tx, x.actor, x.reg.id, { version: x.reg.version, name: 'Реестр прав доступа' });
      expect(renamed.name).toBe('Реестр прав доступа');
      const archived = await structure.setRegisterArchived(tx, x.actor, x.reg.id, renamed.version, true);
      expect(archived.archived).toBe(true);
      await expectCode(records.createRecord(tx, x.actor, x.reg.id, { values: { [x.f.title]: 'Х' } }), 'REGISTER_ARCHIVED');
      await expectCode(structure.addField(tx, x.actor, x.reg.id, { label: 'Ещё', type: 'text' }), 'REGISTER_ARCHIVED');
    }));
});

describe('поля', () => {
  it('значения хранятся по id поля: переименование поля и варианта ничего не ломает', () =>
    inTx(async (tx) => {
      const x = await makeRegister(tx);
      const rec = await records.createRecord(tx, x.actor, x.reg.id, { values: { [x.f.title]: 'CVE-1', [x.f.level]: x.opt('level', 'Высокий') } });
      const level = (await x.reload()).fields.find((f) => f.id === x.f.level);
      await structure.updateField(tx, x.actor, x.f.level, { version: level?.version ?? 0, label: 'Критичность' });
      const opt = (await x.reload()).fields.find((f) => f.id === x.f.level)?.options.find((o) => o.label === 'Высокий');
      await structure.updateOption(tx, x.actor, opt?.id as string, { version: opt?.version ?? 0, label: 'Критическая' });
      const after = await records.getRecord(tx, rec.id);
      expect(after.values[x.f.level]).toBe(x.opt('level', 'Высокий'));
      expect(after.display[x.f.level]).toBe('Критическая');
      // Поиск обновился после переименования варианта.
      const found = await records.listRecords(tx, x.reg.id, { q: 'критическая', limit: 10 });
      expect(found.items.map((r) => r.id)).toEqual([rec.id]);
    }));

  it('поле с данными не удаляется — только архив; без данных удаляется', () =>
    inTx(async (tx) => {
      const x = await makeRegister(tx);
      await records.createRecord(tx, x.actor, x.reg.id, { values: { [x.f.title]: 'А', [x.f.score]: 5 } });
      const score = (await x.reload()).fields.find((f) => f.id === x.f.score);
      await expectCode(structure.deleteField(tx, x.actor, x.f.score, score?.version ?? 0), 'HAS_DATA');
      const archived = await structure.setFieldArchived(tx, x.actor, x.f.score, score?.version ?? 0, true);
      expect(archived.fields.find((f) => f.id === x.f.score)?.archived).toBe(true);
      // Значение в записи сохранилось.
      const rows = await records.listRecords(tx, x.reg.id, { limit: 10 });
      expect(rows.items[0]?.values[x.f.score]).toBe(5);
      const empty = (await structure.addField(tx, x.actor, x.reg.id, { label: 'Пустое', type: 'text' })).fields.find((f) => f.label === 'Пустое');
      const del = await structure.deleteField(tx, x.actor, empty?.id as string, empty?.version ?? 0);
      expect(del.fields.some((f) => f.label === 'Пустое')).toBe(false);
    }));

  it('заголовок, статус и поля из правила вычисления защищены', () =>
    inTx(async (tx) => {
      const x = await makeRegister(tx);
      const r = await x.reload();
      const v = (id: string) => r.fields.find((f) => f.id === id)?.version ?? 0;
      await expectCode(structure.setFieldArchived(tx, x.actor, x.f.title, v(x.f.title), true), 'TITLE_FIELD');
      await expectCode(structure.setFieldArchived(tx, x.actor, x.f.status, v(x.f.status), true), 'STATUS_FIELD');
      await expectCode(structure.setFieldArchived(tx, x.actor, x.f.found, v(x.f.found), true), 'CALC_DEPENDENCY');
      await expectCode(structure.previewTypeChange(tx, x.f.level, 'text'), 'CALC_DEPENDENCY');
    }));

  it('правило вычисления и роль аналитики проверяются', () =>
    inTx(async (tx) => {
      const x = await makeRegister(tx);
      await expectCode(structure.addField(tx, x.actor, x.reg.id, {
        label: 'Плохой срок', type: 'calc', calcRule: { fromFieldId: x.f.score, byFieldId: x.f.level, days: {}, overrideFieldId: null },
      }), 'BAD_CALC_RULE');
      await expectCode(structure.addField(tx, x.actor, x.reg.id, { label: 'Текст-метрика', type: 'text', analyticsRole: 'metric' }), 'BAD_ANALYTICS_ROLE');
      await expectCode(structure.addField(tx, x.actor, x.reg.id, { label: 'Решение без вариантов', type: 'decision', options: ['Один'] }), 'NO_OPTIONS');
    }));

  it('вариант: используемый не удаляется, последний активный не архивируется, «закрыт» — только у статуса', () =>
    inTx(async (tx) => {
      const x = await makeRegister(tx);
      await records.createRecord(tx, x.actor, x.reg.id, { values: { [x.f.title]: 'А', [x.f.level]: x.opt('level', 'Средний') } });
      const r = await x.reload();
      const level = r.fields.find((f) => f.id === x.f.level);
      const sred = level?.options.find((o) => o.label === 'Средний');
      await expectCode(structure.deleteOption(tx, x.actor, sred?.id as string, sred?.version ?? 0), 'IN_USE');
      const high = level?.options.find((o) => o.label === 'Высокий');
      await expectCode(structure.deleteOption(tx, x.actor, high?.id as string, high?.version ?? 0), 'CALC_DEPENDENCY');
      await expectCode(structure.updateOption(tx, x.actor, high?.id as string, { version: high?.version ?? 0, isClosed: true }), 'NOT_STATUS');
      const st = r.fields.find((f) => f.isStatus);
      const done = st?.options.find((o) => o.label === 'В работе');
      const closed = await structure.updateOption(tx, x.actor, done?.id as string, { version: done?.version ?? 0, isClosed: true });
      expect(closed.fields.find((f) => f.isStatus)?.options.find((o) => o.label === 'В работе')?.isClosed).toBe(true);
    }));
});

describe('смена типа поля', () => {
  it('А: поле без данных — любой допустимый тип', () =>
    inTx(async (tx) => {
      const x = await makeRegister(tx);
      const preview = await structure.previewTypeChange(tx, x.f.score, 'date');
      expect(preview).toMatchObject({ kind: 'empty', affected: 0 });
      const r = (await x.reload()).fields.find((f) => f.id === x.f.score);
      const after = await structure.applyTypeChange(tx, x.actor, x.f.score, { version: r?.version ?? 0, to: 'date' });
      expect(after.fields.find((f) => f.id === x.f.score)?.type).toBe('date');
    }));

  it('Б: число и сотрудник → текст с предпросмотром, историей записей и журналом', () =>
    inTx(async (tx) => {
      const x = await makeRegister(tx);
      const rec = await records.createRecord(tx, x.actor, x.reg.id, { values: { [x.f.title]: 'А', [x.f.score]: 12.5, [x.f.owner]: x.adminId } });
      await records.createRecord(tx, x.actor, x.reg.id, { values: { [x.f.title]: 'Б' } });
      const p = await structure.previewTypeChange(tx, x.f.score, 'text');
      expect(p).toMatchObject({ kind: 'to_text', affected: 1, errors: [] });
      expect(p.samples[0]).toMatchObject({ from: '12,5', to: '12,5' });
      const v = (await x.reload()).fields.find((f) => f.id === x.f.score)?.version ?? 0;
      await structure.applyTypeChange(tx, x.actor, x.f.score, { version: v, to: 'text' });
      expect((await records.getRecord(tx, rec.id)).values[x.f.score]).toBe('12,5');
      expect((await lastAudit(tx)).diff).toMatchObject({ summary: expect.stringContaining('изменено записей: 1') });
      const hist = await records.recordHistory(tx, rec.id);
      expect(hist[0]).toMatchObject({ via: 'type_change', changes: [{ label: 'Баллы', from: '12,5', to: '12,5' }] });

      const pu = await structure.previewTypeChange(tx, x.f.owner, 'text');
      expect(pu.affected).toBe(1);
    }));

  it('В: текст → число/дата/список только если все значения распознаны', () =>
    inTx(async (tx) => {
      const x = await makeRegister(tx);
      let reg = await structure.addField(tx, x.actor, x.reg.id, { label: 'Кол-во', type: 'text' });
      const qty = reg.fields.find((f) => f.label === 'Кол-во')?.id as string;
      reg = await structure.addField(tx, x.actor, x.reg.id, { label: 'Источник', type: 'text' });
      const src = reg.fields.find((f) => f.label === 'Источник')?.id as string;
      await records.createRecord(tx, x.actor, x.reg.id, { values: { [x.f.title]: 'А', [qty]: '1 200,5', [src]: 'Сканер' } });
      const bad = await records.createRecord(tx, x.actor, x.reg.id, { values: { [x.f.title]: 'Б', [qty]: 'много', [src]: 'сканер' } });

      const p = await structure.previewTypeChange(tx, qty, 'number');
      expect(p.errors).toEqual([{ number: bad.number, value: 'много' }]);
      const v = () => x.reload().then((r) => r.fields.find((f) => f.id === qty)?.version ?? 0);
      await expectCode(structure.applyTypeChange(tx, x.actor, qty, { version: await v(), to: 'number' }), 'TYPE_CHANGE_VALUES');
      // Ничего не изменилось.
      expect((await records.getRecord(tx, bad.id)).values[qty]).toBe('много');

      const ps = await structure.previewTypeChange(tx, src, 'select');
      expect(ps).toMatchObject({ kind: 'from_text', affected: 2, newOptions: ['Сканер'] });
      const vs = (await x.reload()).fields.find((f) => f.id === src)?.version ?? 0;
      const after = await structure.applyTypeChange(tx, x.actor, src, { version: vs, to: 'select' });
      const optId = after.fields.find((f) => f.id === src)?.options[0]?.id;
      expect((await records.getRecord(tx, bad.id)).values[src]).toBe(optId);
    }));

  it('запрещено: в вычисляемое и решение, между типами с данными кроме текста', () =>
    inTx(async (tx) => {
      const x = await makeRegister(tx);
      await records.createRecord(tx, x.actor, x.reg.id, { values: { [x.f.title]: 'А', [x.f.score]: 1 } });
      await expectCode(structure.previewTypeChange(tx, x.f.score, 'date'), 'TYPE_CHANGE_FORBIDDEN');
      await expectCode(structure.previewTypeChange(tx, x.f.score, 'calc'), 'TYPE_CHANGE_FORBIDDEN');
      await expectCode(structure.previewTypeChange(tx, x.f.decision, 'select'), 'TYPE_CHANGE_FORBIDDEN');
      await expectCode(structure.previewTypeChange(tx, x.f.title, 'number'), 'TITLE_FIELD');
    }));
});

describe('записи', () => {
  it('создание: заголовок обязателен, статус по умолчанию, номер по порядку, история', () =>
    inTx(async (tx) => {
      const x = await makeRegister(tx);
      await expectCode(records.createRecord(tx, x.actor, x.reg.id, { values: {} }), 'TITLE_REQUIRED');
      const a = await records.createRecord(tx, x.actor, x.reg.id, { values: { [x.f.title]: 'Первая' } });
      const b = await records.createRecord(tx, x.actor, x.reg.id, { values: { [x.f.title]: 'Вторая' } });
      expect([a.number, b.number]).toEqual([1, 2]);
      expect(a.display[x.f.status]).toBe('Новый');
      expect(a.display[x.f.decision]).toBe('Ожидает решения');
      expect((await records.recordHistory(tx, a.id))[0]).toMatchObject({ action: 'register_record.created' });
    }));

  it('вычисляемое поле: дата + срок по списку, переопределение; только чтение', () =>
    inTx(async (tx) => {
      const x = await makeRegister(tx);
      const r = await records.createRecord(tx, x.actor, x.reg.id, {
        values: { [x.f.title]: 'А', [x.f.found]: '2026-10-01', [x.f.level]: x.opt('level', 'Высокий') },
      });
      expect(r.calc[x.f.due]).toBe('2026-10-15');
      expect(r.display[x.f.due]).toBe('15.10.2026');
      const o = await records.updateRecord(tx, x.actor, r.id, { version: r.version, values: { [x.f.newDue]: '2027-01-31' } });
      expect(o.calc[x.f.due]).toBe('2027-01-31');
      await expectCode(records.updateRecord(tx, x.actor, r.id, { version: o.version, values: { [x.f.due]: '2026-01-01' } }), 'INVALID_VALUES');
      await expectCode(records.updateRecord(tx, x.actor, r.id, { version: o.version, values: { [x.f.decision]: x.opt('decision', 'Принят') } }), 'INVALID_VALUES');
      expect((await records.getRecord(tx, r.id)).values[x.f.due]).toBeUndefined();
    }));

  it('правка: частичная, очистка null, версия и 409, архивное поле нельзя менять', () =>
    inTx(async (tx) => {
      const x = await makeRegister(tx);
      const r = await records.createRecord(tx, x.actor, x.reg.id, { values: { [x.f.title]: 'А', [x.f.score]: 3 } });
      const u = await records.updateRecord(tx, x.actor, r.id, { version: r.version, values: { [x.f.score]: null, [x.f.owner]: x.adminId } });
      expect(u.values[x.f.score]).toBeUndefined();
      expect(u.values[x.f.owner]).toBe(x.adminId);
      expect(u.version).toBe(r.version + 1);
      await expectCode(records.updateRecord(tx, x.actor, r.id, { version: r.version, values: { [x.f.score]: 1 } }), 'VERSION_CONFLICT');
      const h = await records.recordHistory(tx, r.id);
      expect(h[0]?.changes.map((c) => [c.label, c.from, c.to])).toEqual([['Баллы', '3', ''], ['Ответственный', '', expect.any(String)]]);
      const disabled = await makeUser(tx, ['ib_staff'], { isActive: false });
      await expectCode(records.updateRecord(tx, x.actor, r.id, { version: u.version, values: { [x.f.owner]: disabled.id } }), 'INVALID_VALUES');
    }));

  it('архив и мягкое удаление со снимком в журнале', () =>
    inTx(async (tx) => {
      const x = await makeRegister(tx);
      const r = await records.createRecord(tx, x.actor, x.reg.id, { values: { [x.f.title]: 'Удаляемая', [x.f.score]: 7 } });
      const a = await records.setRecordArchived(tx, x.actor, r.id, r.version, true);
      expect((await records.listRecords(tx, x.reg.id, { limit: 10 })).total).toBe(0);
      expect((await records.listRecords(tx, x.reg.id, { limit: 10, includeArchived: true })).total).toBe(1);
      await expectCode(records.updateRecord(tx, x.actor, r.id, { version: a.version, values: { [x.f.score]: 1 } }), 'RECORD_ARCHIVED');
      await records.deleteRecord(tx, x.actor, r.id, a.version);
      expect((await tx.registerRecord.findUniqueOrThrow({ where: { id: r.id } })).deletedAt).not.toBeNull();
      expect((await lastAudit(tx)).diff).toMatchObject({ before: { values: { 'Наименование': 'Удаляемая', 'Баллы': '7' } } });
      await expectCode(records.getRecord(tx, r.id), 'NOT_FOUND');
    }));

  it('поиск по отображаемым значениям и сортировка, пагинация', () =>
    inTx(async (tx) => {
      const x = await makeRegister(tx);
      const owner = await makeUser(tx, ['ib_staff'], { fullName: 'Зарина Поисковая' });
      for (const [t, s, lvl] of [['Бета', 2, 'Средний'], ['Альфа', 10, 'Высокий'], ['Гамма', 1, 'Низкий']] as const) {
        await records.createRecord(tx, x.actor, x.reg.id, { values: { [x.f.title]: t, [x.f.score]: s, [x.f.level]: x.opt('level', lvl), ...(t === 'Гамма' ? { [x.f.owner]: owner.id } : {}) } });
      }
      const title = (q: Awaited<ReturnType<typeof records.listRecords>>) => q.items.map((r) => r.display[x.f.title]);
      expect(title(await records.listRecords(tx, x.reg.id, { limit: 10, q: 'поисков' }))).toEqual(['Гамма']);
      expect(title(await records.listRecords(tx, x.reg.id, { limit: 10, q: 'высокий' }))).toEqual(['Альфа']);
      expect(title(await records.listRecords(tx, x.reg.id, { limit: 10, sort: x.f.score, dir: 'asc' }))).toEqual(['Гамма', 'Бета', 'Альфа']);
      expect(title(await records.listRecords(tx, x.reg.id, { limit: 10, sort: x.f.level, dir: 'asc' }))).toEqual(['Альфа', 'Бета', 'Гамма']);
      expect(title(await records.listRecords(tx, x.reg.id, { limit: 10, sort: x.f.title, dir: 'asc' }))).toEqual(['Альфа', 'Бета', 'Гамма']);
      const p1 = await records.listRecords(tx, x.reg.id, { limit: 2 });
      const p2 = await records.listRecords(tx, x.reg.id, { limit: 2, cursor: p1.nextCursor ?? undefined });
      expect([p1.items.length, p2.items.length, p2.nextCursor, p1.total]).toEqual([2, 1, null, 3]);
      await expectCode(records.listRecords(tx, x.reg.id, { limit: 10, sort: x.f.due }), 'BAD_SORT');
    }));
});

describe('предпросмотр «Попадёт на дашборд»', () => {
  it('распределение по значениям, показатель, сроки; архивные записи не считаются', async () => {
    const { registerAnalytics } = await import('./analytics.service.js');
    await inTx(async (tx) => {
      const x = await makeRegister(tx);
      const score = (await x.reload()).fields.find((f) => f.id === x.f.score);
      await structure.updateField(tx, x.actor, x.f.score, { version: score?.version ?? 0, analyticsRole: 'metric' });
      for (const [lvl, s] of [['Высокий', 9], ['Высокий', 7], ['Средний', 2]] as const) {
        await records.createRecord(tx, x.actor, x.reg.id, { values: { [x.f.title]: `${lvl}${s}`, [x.f.level]: x.opt('level', lvl), [x.f.score]: s } });
      }
      const extra = await records.createRecord(tx, x.actor, x.reg.id, { values: { [x.f.title]: 'Без уровня', [x.f.score]: 100 } });
      await records.setRecordArchived(tx, x.actor, extra.id, extra.version, true);
      await records.createRecord(tx, x.actor, x.reg.id, { values: { [x.f.title]: 'Пусто' } });
      const w = await registerAnalytics(tx, x.reg.id);
      const level = w.find((i) => i.fieldId === x.f.level);
      expect(level).toMatchObject({ kind: 'distribution', empty: 1, rows: [{ label: 'Высокий', count: 2 }, { label: 'Средний', count: 1 }, { label: 'Низкий', count: 0 }] });
      expect(w.find((i) => i.fieldId === x.f.score)).toMatchObject({ kind: 'metric', avg: 6, max: 9, filled: 3 });
      expect(w.find((i) => i.fieldId === x.f.due)).toMatchObject({ kind: 'deadline' });
      expect(w.find((i) => i.fieldId === x.f.status)?.rows[0]).toEqual({ label: 'Новый', count: 4 });
    });
  });
});
