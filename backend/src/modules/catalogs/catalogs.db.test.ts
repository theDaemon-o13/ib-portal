import { afterEach, describe, expect, it } from 'vitest';
import { actorFor, expectCode, inTx, lastAudit, makeUser, type Tx } from '../../test/db.js';
import { catalogItemUsage } from '../settings/usage.js';
import * as svc from './service.js';

async function setup(tx: Tx) {
  const admin = await makeUser(tx, ['super_admin', 'ib_staff']);
  return { admin, actor: await actorFor(tx, admin.id) };
}

async function item(tx: Tx, code: string, value: string) {
  const found = (await svc.listItems(tx, code, { includeArchived: true })).find((i) => i.value === value);
  if (!found) throw new Error(`нет значения «${value}»`);
  return found;
}

let unregister: (() => void) | null = null;
afterEach(() => {
  unregister?.();
  unregister = null;
});

describe('справочники после seed', () => {
  it('семь справочников, системные и стартовые значения', () =>
    inTx(async (tx) => {
      const cats = await svc.listCatalogs(tx);
      expect(cats.map((c) => c.code)).toEqual([
        'task_categories', 'task_statuses', 'task_priorities', 'mail_rules', 'systems', 'document_types', 'notify_recipients',
      ]);
      const categories = await svc.listItems(tx, 'task_categories', { includeArchived: false });
      expect(categories.map((c) => [c.value, c.isSystem])).toEqual([
        ['Почта', true], ['Реестр', true], ['Документы', true], ['Доказательства', true], ['Проект', false], ['Оперплан', false],
      ]);
      expect(categories[0]?.systemReason).toBe('задачи из писем создаются с этой категорией');
      const statuses = await svc.listItems(tx, 'task_statuses', { includeArchived: false });
      expect(statuses.map((s) => s.value)).toEqual(['Backlog', 'Поставленные', 'В работе', 'На проверке', 'Выполнено']);
      expect(statuses.map((s) => [s.commentForward, s.commentReturn])).toEqual([[false, false], [false, false], [false, true], [true, false], [true, false]]);
    }));
});

describe('правила значений', () => {
  it('системное значение нельзя переименовать, архивировать и удалить; цвет менять можно', () =>
    inTx(async (tx) => {
      const { actor } = await setup(tx);
      const mail = await item(tx, 'task_categories', 'Почта');
      await expectCode(svc.updateItem(tx, actor, mail.id, { version: mail.version, value: 'Письма' }), 'SYSTEM_VALUE');
      await expectCode(svc.archiveItem(tx, actor, mail.id, mail.version), 'SYSTEM_VALUE');
      await expectCode(svc.deleteItem(tx, actor, mail.id, mail.version), 'SYSTEM_VALUE');
      const recolored = await svc.updateItem(tx, actor, mail.id, { version: mail.version, color: 'accent' });
      expect(recolored).toMatchObject({ value: 'Почта', color: 'accent' });
    }));

  it('колонки задач: системные — переименовать и признаки, порядок не меняется; свою — добавить на место, в архив только пустую (ADR-0022)', () =>
    inTx(async (tx) => {
      const { actor } = await setup(tx);
      const done = await item(tx, 'task_statuses', 'Выполнено');
      const renamed = await svc.updateItem(tx, actor, done.id, { version: done.version, value: 'Сделано', commentForward: false });
      expect([renamed.value, renamed.commentForward]).toEqual(['Сделано', false]);
      await expectCode(svc.archiveItem(tx, actor, done.id, renamed.version), 'SYSTEM_VALUE');
      await expectCode(svc.updateItem(tx, actor, done.id, { version: renamed.version, afterId: null }), 'SYSTEM_ORDER');

      const work = await item(tx, 'task_statuses', 'В работе');
      const waiting = await svc.createItem(tx, actor, 'task_statuses', { value: 'Ждём ответа', commentForward: true, afterId: work.id });
      expect(waiting.commentForward).toBe(true);
      const order = (await svc.listItems(tx, 'task_statuses', { includeArchived: false })).map((s) => s.value);
      expect(order).toEqual(['Backlog', 'Поставленные', 'В работе', 'Ждём ответа', 'На проверке', 'Сделано']);
      await expectCode(svc.createItem(tx, actor, 'task_categories', { value: 'X', commentForward: true }), 'NOT_STATUSES');

      // Задача в колонке: в архив нельзя, удалить нельзя; пустую — можно в архив.
      const category = await item(tx, 'task_categories', 'Проект');
      const user = await tx.user.findFirstOrThrow();
      const task = await tx.task.create({ data: { title: 'В колонке', statusId: waiting.id, priorityId: (await item(tx, 'task_priorities', 'Обычный')).id, categoryId: category.id, source: 'manual', createdBy: user.id } });
      await expectCode(svc.archiveItem(tx, actor, waiting.id, waiting.version), 'COLUMN_NOT_EMPTY');
      await expectCode(svc.deleteItem(tx, actor, waiting.id, waiting.version), 'IN_USE');
      await tx.task.update({ where: { id: task.id }, data: { archivedAt: new Date() } });
      expect((await svc.archiveItem(tx, actor, waiting.id, waiting.version)).archived).toBe(true);
    }));

  it('используемое значение не удаляется — только в архив', () =>
    inTx(async (tx) => {
      const { actor } = await setup(tx);
      const project = await item(tx, 'task_categories', 'Проект');
      // Так будущий модуль задач сообщит, что на значение ссылаются 3 задачи.
      unregister = catalogItemUsage.register('test', async (_db, ids) => new Map(ids.map((id) => [id, id === project.id ? 3 : 0])));
      expect((await item(tx, 'task_categories', 'Проект')).usage).toBe(3);
      await expectCode(svc.deleteItem(tx, actor, project.id, project.version), 'IN_USE');
      const archived = await svc.archiveItem(tx, actor, project.id, project.version);
      expect(archived.archived).toBe(true);
      // Архивное значение пропадает из списков выбора, но остаётся в настройках.
      expect((await svc.listItems(tx, 'task_categories', { includeArchived: false })).map((i) => i.value)).not.toContain('Проект');
      const restored = await svc.restoreItem(tx, actor, project.id, archived.version);
      expect(restored.archived).toBe(false);
    }));

  it('неиспользуемое несистемное значение удаляется мягко и пишется в журнал', () =>
    inTx(async (tx) => {
      const { actor } = await setup(tx);
      const abs = await item(tx, 'systems', 'АБС');
      await svc.deleteItem(tx, actor, abs.id, abs.version);
      const row = await tx.catalogItem.findUniqueOrThrow({ where: { id: abs.id } });
      expect(row.deletedAt).not.toBeNull();
      expect((await lastAudit(tx)).diff).toMatchObject({ summary: '«Системы»: удалено «АБС»' });
      // После удаления то же значение можно завести снова.
      const again = await svc.createItem(tx, actor, 'systems', { value: 'АБС' });
      expect(again.value).toBe('АБС');
    }));

  it('значение уникально без учёта регистра; переименование ничего не ломает — ссылки по id', () =>
    inTx(async (tx) => {
      const { actor } = await setup(tx);
      await expectCode(svc.createItem(tx, actor, 'systems', { value: '  абс ' }), 'DUPLICATE');
      const created = await svc.createItem(tx, actor, 'systems', { value: '  Карточный   модуль ' });
      expect(created.value).toBe('Карточный модуль');
      const renamed = await svc.updateItem(tx, actor, created.id, { version: created.version, value: 'Карточный процессинг' });
      expect(renamed.id).toBe(created.id);
      await expectCode(svc.updateItem(tx, actor, created.id, { version: created.version, value: 'Х' }), 'VERSION_CONFLICT');
    }));

  it('цвет только у справочников с цветом; новое значение категории — серое по умолчанию', () =>
    inTx(async (tx) => {
      const { actor } = await setup(tx);
      await expectCode(svc.createItem(tx, actor, 'systems', { value: 'CRM', color: 'crit' }), 'NO_COLOR');
      expect((await svc.createItem(tx, actor, 'task_categories', { value: 'Аудит' })).color).toBe('muted');
    }));

  it('правила почты: ключевые слова нормализуются, ответственный — активный сотрудник ИБ', () =>
    inTx(async (tx) => {
      const { admin, actor } = await setup(tx);
      const docsOnly = await makeUser(tx, ['doc_reader']);
      await expectCode(svc.createItem(tx, actor, 'mail_rules', { value: 'Сеть', keywords: [] }), 'NO_KEYWORDS');
      await expectCode(
        svc.createItem(tx, actor, 'mail_rules', { value: 'Сеть', keywords: ['vpn'], ownerUserId: docsOnly.id }),
        'BAD_OWNER',
      );
      const rule = await svc.createItem(tx, actor, 'mail_rules', {
        value: 'Сеть', keywords: [' VPN ', 'vpn', 'Шлюз', ''], ownerUserId: admin.id,
      });
      expect(rule).toMatchObject({ keywords: ['vpn', 'шлюз'], owner: { id: admin.id } });
      await expectCode(svc.createItem(tx, actor, 'systems', { value: 'Х', keywords: ['a'] }), 'NOT_MAIL_RULE');
    }));
});
