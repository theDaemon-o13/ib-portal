// Подсказка цепочек (релиз 1.7.0, ADR-0035): порядок групп, выполненные задачи, закрытые цепочки, похожесть из
// app_settings, задачи без цепочки, системные источники, создание задачи сразу в цепочке. Заголовки вымышленные.
import { describe, expect, it } from 'vitest';
import { actorFor, inTx, makeUser, must, type Tx } from '../../test/db.js';
import { createDocument } from '../documents/service.js';
import { CHAIN_SUGGEST_KEY } from './chain-settings.js';
import { suggestChains, type Suggestion } from './chain-suggest.js';
import * as chains from './chains.js';
import { statusIdOf } from './flow.js';
import * as svc from './service.js';

async function setup(tx: Tx) {
  const author = await makeUser(tx, ['ib_staff'], { fullName: 'Иванов И.И.' });
  const other = await makeUser(tx, ['ib_staff'], { fullName: 'Петров П.П.' });
  const reader = await makeUser(tx, ['doc_reader'], { fullName: 'Читатель Тестов' });
  const project = await tx.catalogItem.findFirstOrThrow({ where: { catalogCode: 'task_categories', value: 'Проект' } });
  const a = { author: await actorFor(tx, author.id), other: await actorFor(tx, other.id), reader: await actorFor(tx, reader.id) };
  // Уникальная метка: подсказка смотрит на все задачи базы, а в dev-базе могут быть свои «тестовые темы».
  const tag = `зета${Math.random().toString(36).slice(2, 8)}`;
  const task = (title: string, extra: Partial<svc.NewTaskInput> = {}) => svc.createTask(tx, a.author, { title: title.replace('ТЕГ', tag), categoryId: project.id, ...extra });
  return { author, other, project, a, task, tag };
}
const ref = async (tx: Tx, id: string) => ({ id, version: (await tx.task.findUniqueOrThrow({ where: { id } })).version });
async function markDone(tx: Tx, id: string) {
  await tx.task.update({ where: { id }, data: { statusId: await statusIdOf(tx, 'done'), completedAt: new Date(), version: { increment: 1 } } });
}
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
const brief = (items: Suggestion[]) => items.map((i) => (i.kind === 'chain' ? `${i.group}:${i.chain.title}` : `tasks:${i.total}`));

describe('подсказка цепочек (1.7.0)', () => {
  it('«RE: …» → открытая цепочка с тем же ключом → задача создаётся сразу в ней, запись в истории', () =>
    inTx(async (tx) => {
      const x = await setup(tx);
      const t1 = await x.task('Тестовая тема ТЕГ');
      const c = await chains.createChain(tx, x.a.author, { title: `Тестовая тема ${x.tag}`, tasks: [await ref(tx, t1.id)] });
      const s = await suggestChains(tx, x.a.other, `RE: FW: тестовая  тема ${x.tag.toUpperCase()}`);
      expect(s.key).toBe(`тестовая тема ${x.tag}`);
      expect(brief(s.items)).toEqual([`open_exact:Тестовая тема ${x.tag}`]);

      const t2 = await svc.createTask(tx, x.a.other, { title: `RE: Тестовая тема ${x.tag}`, categoryId: x.project.id, chain: { id: c.id } });
      expect(t2.chain?.id).toBe(c.id);
      const hist = await svc.taskHistory(tx, t2.id);
      expect(hist.map((h) => h.action)).toEqual(['task.chain_linked', 'task.created']);
      // Задача уже в цепочке: при её правке своя цепочка не предлагается.
      expect((await suggestChains(tx, x.a.other, t2.title, { taskId: t2.id })).items).toEqual([]);
    }));

  it('цепочка, где все задачи выполнены (одна в архиве), остаётся в подсказке и хронологии', () =>
    inTx(async (tx) => {
      const x = await setup(tx);
      const t1 = await x.task('Тестовая тема ТЕГ');
      const t2 = await x.task('RE: Тестовая тема ТЕГ');
      const c = await chains.createChain(tx, x.a.author, { title: `Тестовая тема ${x.tag}`, tasks: [await ref(tx, t1.id), await ref(tx, t2.id)] });
      await markDone(tx, t1.id);
      await markDone(tx, t2.id);
      await svc.setTaskArchived(tx, x.a.author, t2.id, (await ref(tx, t2.id)).version, true);
      const s = await suggestChains(tx, x.a.author, `Ответ: Тестовая тема ${x.tag}`);
      const item = must(s.items[0], 'вариант');
      expect(item.kind === 'chain' && [item.group, item.chain.counts]).toEqual(['open_exact', { total: 2, done: 2 }]);
      const detail = await chains.getChain(tx, x.a.author, c.id);
      expect([detail.counts, detail.allDone, detail.tasks.map((t) => t.archived)]).toEqual([{ total: 2, done: 2 }, true, [false, true]]);
    }));

  it('порядок: открытые точные, закрытые с незавершёнными (любой давности), похожие, недавно закрытые; старые закрытые — нет', () =>
    inTx(async (tx) => {
      const x = await setup(tx);
      const mk = async (title: string, opts: { closedDaysAgo?: number; done?: boolean } = {}) => {
        const t = await x.task(title);
        if (opts.done) await markDone(tx, t.id);
        const c = await chains.createChain(tx, x.a.author, { title: title.replace('ТЕГ', x.tag), tasks: [await ref(tx, t.id)] });
        if (opts.closedDaysAgo !== undefined) await tx.taskChain.update({ where: { id: c.id }, data: { status: 'closed', closedAt: daysAgo(opts.closedDaysAgo) } });
        return c;
      };
      await mk('ТЕГ доступ к vpn отдела', { closedDaysAgo: 10, done: true }); // недавно закрытая, всё выполнено
      await mk('ТЕГ доступ к vpn отдела', { closedDaysAgo: 400 }); // давно закрыта, но задача не выполнена
      await mk('ТЕГ доступ к vpn отдела', { closedDaysAgo: 90, done: true }); // давно закрыта, всё выполнено — не предлагается
      await mk('Доступ в vpn отдела ТЕГ'); // похожая: общие «доступ», «vpn», «отдела», метка
      await mk('ТЕГ доступ к vpn отдела'); // открытая точная
      await mk('ТЕГ доступ к vpn иванова'); // 3 общих из 5 — 0,6: похожая
      const loose = await x.task('RE: ТЕГ доступ к VPN отдела'); // задача без цепочки, тот же ключ
      const s = await suggestChains(tx, x.a.other, `${x.tag} Доступ к VPN отдела`);
      expect(s.items.map((i) => (i.kind === 'chain' ? i.group : 'tasks'))).toEqual(['open_exact', 'closed_unfinished', 'open_similar', 'open_similar', 'closed_recent']);
      // Пятый вариант занят — задачи без цепочки не поместились; при меньшем числе цепочек они последние.
      const s2 = await suggestChains(tx, x.a.other, `FW: ${x.tag} доступ к vpn отдела`, { taskId: undefined });
      expect(s2.items).toHaveLength(5);
      await svc.deleteTask(tx, x.a.author, (await tx.task.findFirstOrThrow({ where: { chain: { title: `Доступ в vpn отдела ${x.tag}` } } })).id, (await tx.task.findFirstOrThrow({ where: { chain: { title: `Доступ в vpn отдела ${x.tag}` } } })).version);
      const s3 = await suggestChains(tx, x.a.other, `${x.tag} доступ к vpn отдела`);
      const last = must(s3.items.at(-1), 'последний вариант');
      expect(last.kind === 'tasks' && last.tasks.map((t) => t.id)).toEqual([loose.id]);
    }));

  it('похожесть и срок — из app_settings; слова из двух букв не считаются', () =>
    inTx(async (tx) => {
      const x = await setup(tx);
      const t = await x.task('ТЕГ доступ к vpn иванов');
      await chains.createChain(tx, x.a.author, { title: `${x.tag} доступ к vpn иванов`, tasks: [await ref(tx, t.id)] });
      // {метка, доступ, vpn, иванов} и {метка, доступ, vpn, петров}: 3 из 5 = 0,6 — похожи при пороге 0,6; «к» не считается.
      expect(brief((await suggestChains(tx, x.a.other, `${x.tag} доступ к vpn петров`)).items)).toEqual([`open_similar:${x.tag} доступ к vpn иванов`]);
      await tx.appSetting.upsert({ where: { key: CHAIN_SUGGEST_KEY }, create: { key: CHAIN_SUGGEST_KEY, value: { minJaccard: 0.7, minCommonWords: 2, closedDays: 30 } }, update: { value: { minJaccard: 0.7, minCommonWords: 2, closedDays: 30 } } });
      expect((await suggestChains(tx, x.a.other, `${x.tag} доступ к vpn петров`)).items).toEqual([]);
      await tx.appSetting.update({ where: { key: CHAIN_SUGGEST_KEY }, data: { value: { minJaccard: 0.5, minCommonWords: 4, closedDays: 30 } } });
      expect((await suggestChains(tx, x.a.other, `${x.tag} доступ к vpn петров`)).items).toEqual([]);
    }));

  it('задачи без цепочки: ручные и из письма, в том числе выполненные; системные не участвуют; создать цепочку из них', () =>
    inTx(async (tx) => {
      const x = await setup(tx);
      const t1 = await x.task('Тестовая тема ТЕГ');
      const t2 = await x.task('FW: Тестовая тёма ТЕГ'.replace('тёма', 'тема'));
      await markDone(tx, t2.id);
      const sys = await x.task('RE: Тестовая тема ТЕГ');
      // Системная задача (по документу): участвовать не должна.
      const admin = await makeUser(tx, ['super_admin']);
      const type = await tx.catalogItem.create({ data: { catalogCode: 'document_types', value: `Тип ${x.tag}` } });
      const docId = await createDocument(tx, await actorFor(tx, admin.id), {
        title: 'Положение о доступе', typeId: type.id, ownerId: x.author.id, onlyofficeUrl: 'https://office.example.local/doc?id=1', edition: '1.0',
      });
      await tx.task.update({ where: { id: sys.id }, data: { source: 'document', documentId: docId, documentReason: 'review' } });
      const s = await suggestChains(tx, x.a.other, `Re[2]: тестовая тема ${x.tag}`);
      const item = must(s.items[0], 'вариант');
      expect(item.kind === 'tasks' && new Set(item.tasks.map((t) => t.id))).toEqual(new Set([t1.id, t2.id]));

      const created = await svc.createTask(tx, x.a.other, {
        title: `RE: Тестовая тема ${x.tag}`, categoryId: x.project.id,
        chain: { withTasks: [await ref(tx, t1.id), await ref(tx, t2.id)] },
      });
      const c = await chains.getChain(tx, x.a.other, must(created.chain, 'цепочка').id);
      expect([c.title, c.counts]).toEqual([`Тестовая тема ${x.tag}`, { total: 3, done: 1 }]);
      expect((await tx.task.findUniqueOrThrow({ where: { id: sys.id } })).chainId).toBeNull();
    }));

  it('видимость: без ib.work подсказок нет; пустой ключ — подсказки нет', () =>
    inTx(async (tx) => {
      const x = await setup(tx);
      const t = await x.task('Тестовая тема ТЕГ');
      await chains.createChain(tx, x.a.author, { title: `Тестовая тема ${x.tag}`, tasks: [await ref(tx, t.id)] });
      await x.task('RE: Тестовая тема ТЕГ');
      expect((await suggestChains(tx, x.a.reader, `Тестовая тема ${x.tag}`)).items).toEqual([]);
      expect(await suggestChains(tx, x.a.author, 'RE: FW: ...')).toEqual({ key: null, items: [] });
    }));
});
