// «Найти цепочки среди старых задач» (релиз 1.7.0, ADR-0035): предпросмотр ничего не меняет, группы — от двух задач
// по точному ключу (включая выполненные и архивные), системные источники не участвуют, открытая цепочка с тем же
// ключом дополняется, повторный запуск безопасен, изменение после предпросмотра — BULK_CHANGED, право — tasks.assign
// или settings.manage.
import { describe, expect, it } from 'vitest';
import { actorFor, expectCode, inTx, makeUser, must, type Tx } from '../../test/db.js';
import { createDocument } from '../documents/service.js';
import { discoverApply, discoverPreview, type DiscoverGroup } from './chain-discover.js';
import * as chains from './chains.js';
import { statusIdOf } from './flow.js';
import * as svc from './service.js';

async function setup(tx: Tx) {
  const head = await makeUser(tx, ['ib_staff', 'ib_head'], { fullName: 'Сидорова С.С.' });
  const staff = await makeUser(tx, ['ib_staff'], { fullName: 'Иванов И.И.' });
  const project = await tx.catalogItem.findFirstOrThrow({ where: { catalogCode: 'task_categories', value: 'Проект' } });
  const a = { head: await actorFor(tx, head.id), staff: await actorFor(tx, staff.id) };
  const tag = `омега${Math.random().toString(36).slice(2, 8)}`;
  const task = (title: string) => svc.createTask(tx, a.staff, { title: title.replace('ТЕГ', tag), categoryId: project.id });
  return { head, staff, project, a, tag, task };
}
const mine = (groups: DiscoverGroup[], tag: string) => groups.filter((g) => g.key.includes(tag));
const toApply = (g: DiscoverGroup) => ({ key: g.key, tasks: g.tasks.map((t) => ({ id: t.id, version: t.version })), chainId: g.target?.id ?? null });

describe('поиск цепочек среди старых задач (1.7.0)', () => {
  it('предпросмотр: точный ключ, от двух задач, выполненные и архивные тоже; системные — нет; ничего не меняет', () =>
    inTx(async (tx) => {
      const x = await setup(tx);
      const t1 = await x.task('Тестовая тема ТЕГ');
      const t2 = await x.task('RE: тестовая тема ТЕГ');
      const t3 = await x.task('FW: Тестовая  тема ТЕГ');
      await x.task('Одиночная тема ТЕГ');
      await x.task('Тестовая тема ТЕГ расширенная');
      await tx.task.update({ where: { id: t2.id }, data: { statusId: await statusIdOf(tx, 'done'), completedAt: new Date() } });
      await svc.setTaskArchived(tx, x.a.staff, t3.id, t3.version, true);
      // Системная задача с той же темой не участвует.
      const sys = await x.task('Отв: Тестовая тема ТЕГ');
      const admin = await makeUser(tx, ['super_admin']);
      const type = await tx.catalogItem.create({ data: { catalogCode: 'document_types', value: `Тип ${x.tag}` } });
      const docId = await createDocument(tx, await actorFor(tx, admin.id), {
        title: 'Положение о доступе', typeId: type.id, ownerId: x.staff.id, onlyofficeUrl: 'https://office.example.local/doc?id=2', edition: '1.0',
      });
      await tx.task.update({ where: { id: sys.id }, data: { source: 'document', documentId: docId, documentReason: 'review' } });

      const before = await tx.task.count({ where: { chainId: { not: null } } });
      const p = await discoverPreview(tx, x.a.head);
      const g = mine(p.groups, x.tag);
      expect(g.map((y) => [y.title, y.tasks.map((t) => t.id)])).toEqual([[`Тестовая тема ${x.tag}`, [t1.id, t2.id, t3.id]]]);
      expect(g[0]?.tasks.map((t) => [t.completed, t.archived])).toEqual([[false, false], [true, false], [false, true]]);
      expect(await tx.task.count({ where: { chainId: { not: null } } })).toBe(before);
    }));

  it('применение: цепочка создана, задачи привязаны, журнал; повторный запуск ничего не находит; без tasks.assign и settings.manage — 403', () =>
    inTx(async (tx) => {
      const x = await setup(tx);
      await x.task('Тестовая тема ТЕГ');
      await x.task('RE: Тестовая тема ТЕГ');
      await expectCode(discoverPreview(tx, x.a.staff), 'FORBIDDEN');
      const g = must(mine((await discoverPreview(tx, x.a.head)).groups, x.tag)[0], 'группа');
      await expectCode(discoverApply(tx, x.a.staff, { groups: [toApply(g)] }), 'FORBIDDEN');
      const r = await discoverApply(tx, x.a.head, { groups: [toApply(g)] });
      expect(r).toEqual({ created: 1, attached: 0, tasks: 2 });
      const chainId = must((await tx.task.findUniqueOrThrow({ where: { id: must(g.tasks[0]).id } })).chainId, 'цепочка');
      const c = await chains.getChain(tx, x.a.head, chainId);
      expect([c.title, c.counts.total]).toEqual([`Тестовая тема ${x.tag}`, 2]);
      const log = await tx.auditLog.findFirstOrThrow({ where: { action: 'task_chain.discovered' }, orderBy: { id: 'desc' } });
      expect((log.diff as { after: unknown }).after).toEqual({ created: 1, attached: 0, tasks: 2 });
      expect(mine((await discoverPreview(tx, x.a.head)).groups, x.tag)).toEqual([]);
    }));

  it('администратор с settings.manage (без tasks.assign) — может; создатель цепочки — он', () =>
    inTx(async (tx) => {
      const x = await setup(tx);
      const admin = await makeUser(tx, ['super_admin'], { fullName: 'Администратор Тестов' });
      const actor = await actorFor(tx, admin.id);
      expect([actor.perms.has('settings.manage'), actor.perms.has('tasks.assign')]).toEqual([true, false]);
      await x.task('Тестовая тема ТЕГ');
      await x.task('RE: Тестовая тема ТЕГ');
      const g = must(mine((await discoverPreview(tx, actor)).groups, x.tag)[0], 'группа');
      expect(await discoverApply(tx, actor, { groups: [toApply(g)] })).toEqual({ created: 1, attached: 0, tasks: 2 });
      const chainId = must((await tx.task.findUniqueOrThrow({ where: { id: must(g.tasks[0]).id } })).chainId, 'цепочка');
      expect((await tx.taskChain.findUniqueOrThrow({ where: { id: chainId } })).createdBy).toBe(admin.id);
    }));

  it('открытая цепочка с тем же ключом дополняется; изменение после предпросмотра — BULK_CHANGED, ничего не применено', () =>
    inTx(async (tx) => {
      const x = await setup(tx);
      const seed = await x.task('Тестовая тема ТЕГ');
      const c = await chains.createChain(tx, x.a.staff, { title: `Тестовая тема ${x.tag}`, tasks: [{ id: seed.id, version: seed.version }] });
      const t1 = await x.task('RE: Тестовая тема ТЕГ');
      await x.task('FW: Тестовая тема ТЕГ');
      const other1 = await x.task('Вторая тема ТЕГ');
      await x.task('RE: Вторая тема ТЕГ');
      const groups = mine((await discoverPreview(tx, x.a.head)).groups, x.tag);
      const first = must(groups.find((y) => y.key.startsWith('тестовая')), 'группа 1');
      expect(first.target?.id).toBe(c.id);

      // Задача второй группы изменилась после предпросмотра: не применяется ничего, и первая группа тоже.
      await svc.updateTask(tx, x.a.staff, other1.id, { version: other1.version, description: 'Правка после предпросмотра' });
      await expectCode(discoverApply(tx, x.a.head, { groups: groups.map(toApply) }), 'BULK_CHANGED');
      expect((await tx.task.findUniqueOrThrow({ where: { id: t1.id } })).chainId).toBeNull();

      const r = await discoverApply(tx, x.a.head, { groups: [toApply(first)] });
      expect(r).toEqual({ created: 0, attached: 1, tasks: 2 });
      expect((await chains.getChain(tx, x.a.head, c.id)).counts.total).toBe(3);
    }));
});
