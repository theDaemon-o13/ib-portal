import type { User } from '../../generated/prisma/client.js';
import { describe, expect, it } from 'vitest';
import { seedDocumentRoute } from '../../../prisma/seed/documents.js';
import { testDbConfig } from '../../../scripts/test-db.js';
import { createPrisma } from '../../lib/db.js';
import { MIME_BY_EXT } from '../../lib/file-type.js';
import { todayIso } from '../../lib/today.js';
import { actorFor, expectCode, inTx, makeFileRow, makeUser, must, type Tx } from '../../test/db.js';
import type { Actor } from '../settings/common.js';
import { runDocumentReviews } from './review.js';
import * as svc from './service.js';
import { addMonthsIso, FIXED_FILE, type DocAction } from './status.js';

const URL1 = 'https://office.example.local/products/files/doceditor.aspx?fileid=101';
const SIGNED_ON = '2026-10-20';

async function fixture(tx: Tx) {
  const type = await tx.catalogItem.create({ data: { catalogCode: 'document_types', value: `Политика ${Math.random().toString(36).slice(2)}` } });
  const admin = await makeUser(tx, ['super_admin'], { fullName: 'Администратор' });
  const chief = await makeUser(tx, ['ib_staff'], { fullName: 'Руководитель автора' });
  const owner = await makeUser(tx, ['ib_staff'], { fullName: 'Автор Документа', manager: { connect: { id: chief.id } } });
  const staff = await makeUser(tx, ['ib_staff'], { fullName: 'Сотрудник ИБ' });
  const head = await makeUser(tx, ['ib_staff', 'ib_head'], { fullName: 'Начальник ИБ' });
  const legal = await makeUser(tx, ['legal'], { fullName: 'Юрист' });
  const as = async (u: User): Promise<Actor> => actorFor(tx, u.id);
  const create = async (title = 'Политика информационной безопасности', ownerId = owner.id) =>
    svc.createDocument(tx, await as(admin), { title, typeId: type.id, ownerId, onlyofficeUrl: URL1, edition: '1.0' });
  return { type, admin, chief, owner, staff, head, legal, as, create };
}
type Fx = Awaited<ReturnType<typeof fixture>>;

/** Версия документа и этап рабочей версии — то, что пользователь видит на экране. */
async function cur(tx: Tx, id: string) {
  const d = await tx.document.findUniqueOrThrow({ where: { id }, include: { workingVersion: true } });
  return { version: d.version, stage: d.workingVersion?.stage ?? -1 };
}

const docxFile = (tx: Tx, u: User) => makeFileRow(tx, u.id, { name: 'Версия.docx', mime: MIME_BY_EXT.docx });

/** Действие маршрута; для 13 → 14 и 14 → 15 файл версии загружает тот, кто действует (если fileId не задан). */
async function move(tx: Tx, u: User, id: string, action: DocAction, opts: { comment?: string; fileId?: string | null } = {}) {
  const fileId = opts.fileId === null ? undefined : opts.fileId ?? (FIXED_FILE[action] ? (await docxFile(tx, u)).id : undefined);
  return svc.moveDocument(tx, await actorFor(tx, u.id), id, action, { ...(await cur(tx, id)), comment: opts.comment, fileId });
}

async function sign(tx: Tx, u: User, id: string, opts: { signedOn?: string; fileId?: string } = {}) {
  const fileId = opts.fileId ?? (await makeFileRow(tx, u.id, { name: 'Подписан.pdf' })).id;
  return svc.signDocument(tx, await actorFor(tx, u.id), id, { ...(await cur(tx, id)), fileId, signedOn: opts.signedOn ?? SIGNED_ON });
}

/** До этапа stage (11…16) полным маршрутом, с текущего этапа. */
async function moveTo(tx: Tx, x: Fx, id: string, stage: number) {
  const next: Record<number, [User, DocAction]> = {
    11: [x.owner, 'to_review'], 12: [x.owner, 'to_head'], 13: [x.head, 'approve'], 14: [x.head, 'ack_final'], 15: [x.head, 'to_signing'],
  };
  for (let s = (await cur(tx, id)).stage; s < stage; s = (await cur(tx, id)).stage) {
    const [u, a] = must(next[s], `шаг с этапа ${s}`);
    await move(tx, u, id, a);
  }
}

/** Подписать документ полным маршрутом. */
async function signAll(tx: Tx, x: Fx, id: string) {
  await moveTo(tx, x, id, 16);
  await sign(tx, x.owner, id);
}

/** Карточка глазами пользователя; history — как у пользователя с правом «История в карточках». */
const view = async (tx: Tx, u: User, id: string, opts: { history?: boolean } = { history: true }) => {
  const a = await svc.accessOf(tx, u.id);
  return svc.getDocument(tx, opts.history ? { ...a, perms: new Set([...a.perms, 'history.view']) } : a, id);
};
const list = async (tx: Tx, u: User) => (await svc.listDocuments(tx, await svc.accessOf(tx, u.id), { archived: false, limit: 500 })).items;

/** Выполнить SQL, ожидая ошибку; транзакция теста остаётся рабочей (SAVEPOINT). */
async function sqlError(tx: Tx, sql: string): Promise<string> {
  await tx.$executeRawUnsafe('SAVEPOINT t_err');
  try {
    await tx.$executeRawUnsafe(sql);
  } catch (err) {
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT t_err');
    return (err as Error).message;
  }
  throw new Error(`ожидалась ошибка: ${sql}`);
}

/** Транзакция под владельцем схемы, всегда с откатом. */
async function inOwnerTx(client: ReturnType<typeof createPrisma>, fn: (tx: Tx) => Promise<void>) {
  class Rollback extends Error {}
  try {
    await client.$transaction(async (tx) => {
      await fn(tx);
      throw new Rollback();
    }, { timeout: 60_000 });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
}

describe('документы: маршрут 1.2.0 (ADR-0024)', () => {
  it('полный маршрут 11 → 16: кто что может, файлы версии, подписание, пересмотр от даты подписания', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      let d = await view(tx, x.owner, id);
      expect(d).toMatchObject({ status: 'draft', stage: 11, stageName: 'Драфт', waitingForMe: true });
      expect(d.can.actions).toEqual(['to_review']);

      // 11 → 12: только автор (владелец или docs.manage).
      await expectCode(move(tx, x.staff, id, 'to_review'), 'FORBIDDEN');
      await expectCode(move(tx, x.chief, id, 'to_review'), 'FORBIDDEN');
      await move(tx, x.owner, id, 'to_review');
      expect((await view(tx, x.owner, id)).status).toBe('in_approval');

      // 12 → 13: автор или старший над автором; сотрудник и начальник ИБ — нет.
      await expectCode(move(tx, x.staff, id, 'to_head'), 'FORBIDDEN');
      await expectCode(move(tx, x.head, id, 'to_head'), 'FORBIDDEN');
      expect((await view(tx, x.chief, id)).can.actions).toEqual(['to_head']);
      await move(tx, x.chief, id, 'to_head');

      // 13 → 14: начальник ИБ с файлом версии (pdf или docx).
      await expectCode(move(tx, x.owner, id, 'approve'), 'FORBIDDEN');
      await expectCode(move(tx, x.head, id, 'approve', { fileId: null }), 'FILE_REQUIRED');
      await expectCode(move(tx, x.head, id, 'approve', { fileId: (await makeFileRow(tx, x.head.id, { name: 'а.xlsx', mime: MIME_BY_EXT.xlsx })).id }), 'BAD_FILE_TYPE');
      expect((await view(tx, x.head, id)).waitingForMe).toBe(true);
      await move(tx, x.head, id, 'approve');

      // 14 → 15: начальник ИБ («Ознакомлен с финальной версией»), тоже с файлом.
      await expectCode(move(tx, x.owner, id, 'ack_final'), 'FORBIDDEN');
      await move(tx, x.head, id, 'ack_final', { fileId: (await makeFileRow(tx, x.head.id, { name: 'Финал.pdf' })).id });

      // 15 → 16: начальник ИБ или старший над автором.
      await expectCode(move(tx, x.owner, id, 'to_signing'), 'FORBIDDEN');
      await move(tx, x.chief, id, 'to_signing');

      // 16: автор или начальник ИБ — подписанный PDF и дата подписания.
      d = await view(tx, x.owner, id);
      expect(d).toMatchObject({ stage: 16, waitingForMe: true });
      expect(d.can).toMatchObject({ actions: [], sign: true });
      await expectCode(sign(tx, x.staff, id), 'FORBIDDEN');
      await expectCode(sign(tx, x.owner, id, { signedOn: '2099-01-01' }), 'BAD_DATE');
      await expectCode(sign(tx, x.owner, id, { signedOn: '2026-02-30' }), 'BAD_DATE');
      await expectCode(sign(tx, x.owner, id, { fileId: (await docxFile(tx, x.owner)).id }), 'BAD_FILE_TYPE');
      await sign(tx, x.owner, id);

      d = await view(tx, x.owner, id);
      expect(d).toMatchObject({ status: 'approved', approvedVersionNo: 1, signedOn: SIGNED_ON, working: null, stage: null });
      expect(d.reviewDue).toBe(addMonthsIso(SIGNED_ON, 12));
      expect(d.current).toMatchObject({ stage: 16, signedOn: SIGNED_ON, textFrozen: true });
      expect(d.current.pdf?.name).toBe('Подписан.pdf');
      expect(d.route.map((r) => [r.stage, r.state, r.actedBy])).toEqual([
        [11, 'done', 'Автор Документа'], [12, 'done', 'Руководитель автора'], [13, 'done', 'Начальник ИБ'],
        [14, 'done', 'Начальник ИБ'], [15, 'done', 'Руководитель автора'], [16, 'done', 'Автор Документа'],
      ]);
      // Все три зафиксированных файла видны в карточке.
      expect(d.files.map((f) => [f.kind, f.file.name])).toEqual([['head_approved', 'Версия.docx'], ['final', 'Финал.pdf']]);
      expect(d.history.map((h) => `${h.decision}:${h.stage}→${h.toStage ?? ''}`)).toEqual([
        'signed:16→', 'moved:15→16', 'approved:14→15', 'approved:13→14', 'moved:12→13', 'moved:11→12',
      ]);
      expect(d.history.find((h) => h.stage === 13)?.pdfSha256).toMatch(/^[0-9a-f]{64}$/);
      // После подписания маршрута нет.
      await expectCode(move(tx, x.head, id, 'return', { comment: 'x' }), 'NOT_IN_ROUTE');
      expect((await tx.auditLog.findFirstOrThrow({ where: { action: 'document.signed', entityId: id } })).diff).toMatchObject({ after: { signedOn: SIGNED_ON } });
    }));

  it('устаревший этап или версия на экране — 409; действие не своего этапа — 409', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await moveTo(tx, x, id, 13);
      const seen = await cur(tx, id);
      const file = async () => (await docxFile(tx, x.head)).id;
      await svc.moveDocument(tx, await x.as(x.head), id, 'approve', { ...seen, fileId: await file() });
      await expectCode(svc.moveDocument(tx, await x.as(x.head), id, 'approve', { ...seen, fileId: await file() }), 'VERSION_CONFLICT');
      await expectCode(svc.moveDocument(tx, await x.as(x.head), id, 'approve', { ...(await cur(tx, id)), stage: 13, fileId: await file() }), 'STAGE_CHANGED');
      await expectCode(move(tx, x.head, id, 'to_signing'), 'WRONG_STAGE');
    }));

  it('супер-администратор не согласует ни через какую роль, но действует за автора (docs.manage)', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const adminHead = await makeUser(tx, ['super_admin', 'ib_head'], { fullName: 'Админ с правом начальника' });
      const id = await x.create();
      await move(tx, adminHead, id, 'to_review');
      await move(tx, adminHead, id, 'to_head');
      await expectCode(move(tx, adminHead, id, 'approve'), 'SEPARATION_OF_DUTIES');
      await expectCode(move(tx, adminHead, id, 'return', { comment: 'замечание' }), 'SEPARATION_OF_DUTIES');
      const d = await view(tx, adminHead, id);
      expect(d.can.actions).toEqual([]);
      expect(d.route.find((r) => r.stage === 13)?.approvers).not.toContain('Админ с правом начальника');
      expect(d.route.find((r) => r.stage === 13)?.approvers).toContain('Начальник ИБ');
      expect((await svc.documentSummary(tx, await svc.accessOf(tx, adminHead.id))).waitingForMe).toBe(0);
    }));

  it('подробная история — только с правом «История в карточках»; кто прошёл этапы — видят все (ADR-0021)', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await signAll(tx, x, id);
      const plain = await view(tx, x.owner, id, { history: false });
      expect(plain.history).toEqual([]);
      expect(plain.route.map((r) => r.actedBy)).toEqual(['Автор Документа', 'Автор Документа', 'Начальник ИБ', 'Начальник ИБ', 'Начальник ИБ', 'Автор Документа']);
      expect((await view(tx, x.owner, id)).history).toHaveLength(6);
    }));
});

describe('документы: автор — начальник ИБ (решение владельца 6)', () => {
  it('есть другой начальник ИБ — свой документ на этапе 13 согласует он', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const head2 = await makeUser(tx, ['ib_staff', 'ib_head'], { fullName: 'Второй начальник' });
      const id = await x.create('Свой документ', x.head.id);
      await move(tx, x.head, id, 'to_review');
      await move(tx, x.head, id, 'to_head');
      const d = await view(tx, x.head, id);
      expect(d.can.actions).toEqual(['return']);
      expect(d.waitingForMe).toBe(false);
      expect(d.blockedReason).toBeNull();
      await expectCode(move(tx, x.head, id, 'approve'), 'SEPARATION_OF_DUTIES');
      expect((await view(tx, head2, id)).waitingForMe).toBe(true);
      await move(tx, head2, id, 'approve');
      const after = await view(tx, x.head, id);
      expect(after.route.find((r) => r.stage === 13)).toMatchObject({ actedBy: 'Второй начальник', selfApproved: false });
    }));

  it('другого начальника ИБ нет — согласует сам, с отметкой «без независимого согласования» в истории и карточке', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      // Остальные начальники ИБ в тестовой базе (если есть) на время транзакции отключены.
      await tx.user.updateMany({
        where: { id: { not: x.head.id }, roles: { some: { role: { permissions: { some: { permissionCode: 'docs.approve.head' } } } } } },
        data: { isActive: false },
      });
      const id = await x.create('Свой документ', x.head.id);
      await move(tx, x.head, id, 'to_review');
      await move(tx, x.head, id, 'to_head');
      expect((await view(tx, x.head, id)).can.actions).toEqual(['approve', 'return']);
      await move(tx, x.head, id, 'approve');
      const d = await view(tx, x.head, id);
      expect(d.route.find((r) => r.stage === 13)).toMatchObject({ actedBy: 'Начальник ИБ', selfApproved: true });
      expect(d.history.find((h) => h.stage === 13)).toMatchObject({ decision: 'approved', selfApproved: true });
      const audit = await tx.auditLog.findFirstOrThrow({ where: { action: 'document.moved', entityId: id }, orderBy: { at: 'desc' } });
      expect((audit.diff as { summary: string }).summary).toMatch(/согласовано автором \(начальник ИБ\), без независимого согласования/);
      // Чужой документ тот же начальник ИБ согласует обычным порядком — без отметки.
      const other = await x.create();
      await moveTo(tx, x, other, 14);
      expect((await view(tx, x.head, other)).route.find((r) => r.stage === 13)?.selfApproved).toBe(false);
    }));
});

describe('документы: возврат на доработку', () => {
  it('только начальник ИБ, только с комментарием, с этапов 13–15; новый круг; задача владельцу; 11 → 12 закрывает её', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await moveTo(tx, x, id, 12);
      await expectCode(move(tx, x.head, id, 'return', { comment: 'рано' }), 'WRONG_STAGE');
      await moveTo(tx, x, id, 14);
      await expectCode(move(tx, x.head, id, 'return'), 'EMPTY_COMMENT');
      await expectCode(move(tx, x.owner, id, 'return', { comment: 'сам' }), 'FORBIDDEN');
      await move(tx, x.head, id, 'return', { comment: 'Уточнить раздел 3' });

      const d = await view(tx, x.owner, id);
      expect(d.current).toMatchObject({ stage: 11, round: 2 });
      expect(d.returned).toMatchObject({ actor: 'Начальник ИБ', stageName: 'Согласование с ответственными лицами', comment: 'Уточнить раздел 3' });
      expect(d.route.every((r) => r.state !== 'done')).toBe(true);
      const task = await tx.task.findFirstOrThrow({ where: { documentId: id, documentReason: 'returned' } });
      expect(task).toMatchObject({ assigneeId: x.owner.id, completedAt: null });

      // Второй круг: снова до 15, повторный возврат — комментарий в открытую задачу.
      await moveTo(tx, x, id, 11);
      await move(tx, x.owner, id, 'to_review');
      expect((await tx.task.findUniqueOrThrow({ where: { id: task.id } })).completedAt).not.toBeNull();
      await moveTo(tx, x, id, 15);
      // Файлы фиксируются в каждом круге заново: по одному на круг.
      expect((await view(tx, x.owner, id)).files.filter((f) => f.kind === 'head_approved').map((f) => f.round)).toEqual([1, 2]);
      await move(tx, x.head, id, 'return', { comment: 'Перевод не нужен' });
      expect((await tx.task.findFirstOrThrow({ where: { documentId: id, documentReason: 'returned', completedAt: null } })).id).not.toBe(task.id);
    }));
});

describe('документы: файлы драфта и комментарии', () => {
  it('файлы драфта — автор на этапе 11; зафиксированные файлы не снимаются (триггер)', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      const add = async (u: User, fileIds: string[]) => svc.addDraftFiles(tx, await x.as(u), id, { ...(await cur(tx, id)), fileIds });
      await expectCode(add(x.staff, [(await docxFile(tx, x.staff)).id]), 'FORBIDDEN');
      await expectCode(add(x.owner, [(await makeFileRow(tx, x.owner.id, { name: 'а.png', mime: MIME_BY_EXT.png })).id]), 'BAD_FILE_TYPE');
      await add(x.owner, [(await docxFile(tx, x.owner)).id, (await makeFileRow(tx, x.owner.id)).id]);
      let d = await view(tx, x.owner, id);
      expect(d.files.map((f) => [f.kind, f.removable])).toEqual([['draft', true], ['draft', true]]);
      const first = must(d.files[0]);
      await svc.removeDraftFile(tx, await x.as(x.owner), id, first.id, await cur(tx, id));
      expect((await tx.file.findUniqueOrThrow({ where: { id: first.file.id } })).deletedAt).not.toBeNull();
      d = await view(tx, x.owner, id);
      expect(d.files).toHaveLength(1);

      await moveTo(tx, x, id, 14);
      d = await view(tx, x.owner, id);
      expect(d.files.map((f) => [f.kind, f.removable])).toEqual([['draft', false], ['head_approved', false]]);
      await expectCode(add(x.owner, [(await docxFile(tx, x.owner)).id]), 'FORBIDDEN');
      await expectCode(svc.removeDraftFile(tx, await x.as(x.owner), id, must(d.files[0]).id, await cur(tx, id)), 'FORBIDDEN');
      const fixed = must(d.files[1]);
      expect(await sqlError(tx, `UPDATE document_files SET removed_at = now() WHERE id = '${fixed.id}'`)).toMatch(/document_files_removed_check/);
      expect(await sqlError(tx, `DELETE FROM document_files WHERE id = '${fixed.id}'`)).toMatch(/permission denied/);
      expect(await sqlError(tx, `UPDATE files SET deleted_at = now() WHERE id = '${fixed.file.id}'`)).toMatch(/есть ссылки/);
    }));

  it('комментарии — сотрудники ИБ на этапе 12; не правятся и не удаляются', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      const say = async (u: User, body: string) => svc.addDocumentComment(tx, await x.as(u), id, { body });
      await expectCode(say(x.staff, 'рано'), 'WRONG_STAGE');
      await moveTo(tx, x, id, 12);
      expect((await view(tx, x.staff, id)).can.comment).toBe(true);
      await expectCode(say(x.staff, '   '), 'EMPTY_COMMENT');
      await expectCode(say(x.legal, 'без доступа'), 'FORBIDDEN');
      await say(x.staff, 'В п. 4 не хватает срока');
      await say(x.owner, 'Добавил');
      expect((await view(tx, x.owner, id)).comments.map((c) => [c.author, c.body])).toEqual([['Сотрудник ИБ', 'В п. 4 не хватает срока'], ['Автор Документа', 'Добавил']]);
      expect(await sqlError(tx, `UPDATE document_comments SET body = 'x' WHERE document_id = '${id}'`)).toMatch(/permission denied/);
      expect(await sqlError(tx, `DELETE FROM document_comments WHERE document_id = '${id}'`)).toMatch(/permission denied/);
      await moveTo(tx, x, id, 13);
      await expectCode(say(x.staff, 'поздно'), 'WRONG_STAGE');
    }));
});

describe('документы: новая версия и отмена пересмотра', () => {
  it('правка подписанного — новая версия на «Драфт» через маршрут заново; подписанная версия не меняется', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await signAll(tx, x, id);
      const v1 = await tx.documentVersion.findFirstOrThrow({ where: { documentId: id, no: 1 } });

      await expectCode(svc.updateDocument(tx, await x.as(x.owner), id, { ...(await cur(tx, id)), title: 'Новое название' }), 'DOC_APPROVED');
      await expectCode(svc.reviseDocument(tx, await x.as(x.head), id, { version: (await cur(tx, id)).version }), 'FORBIDDEN');
      await svc.reviseDocument(tx, await x.as(x.owner), id, { version: (await cur(tx, id)).version, edition: '2.0', changeNote: 'Раздел 5 переписан' });
      await expectCode(svc.reviseDocument(tx, await x.as(x.owner), id, { version: (await cur(tx, id)).version }), 'HAS_WORKING');

      let d = await view(tx, x.owner, id);
      expect(d.status).toBe('in_review');
      expect(d.current).toMatchObject({ no: 2, stage: 11, round: 1, edition: '2.0', approvedAt: null });
      expect(d.approved?.no).toBe(1);
      await svc.updateDocument(tx, await x.as(x.owner), id, { ...(await cur(tx, id)), title: 'Политика ИБ, ред. 2' });
      // Без ib.work видна действующая версия 1.
      expect((await view(tx, x.legal, id)).current.no).toBe(1);

      await signAll(tx, x, id);
      d = await view(tx, x.owner, id);
      expect(d).toMatchObject({ status: 'approved', approvedVersionNo: 2, title: 'Политика ИБ, ред. 2' });
      expect(d.versions.map((v) => [v.no, v.approvedAt !== null])).toEqual([[2, true], [1, true]]);
      expect(d.history.some((h) => h.decision === 'revision_started' && h.versionNo === 2)).toBe(true);
      expect(await tx.documentVersion.findUniqueOrThrow({ where: { id: v1.id } })).toEqual(v1);
    }));

  it('«Отменить пересмотр»: автор или начальник ИБ, с комментарием; версия — в истории как отменённая', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      const cancel = async (u: User, comment: string) => svc.cancelRevision(tx, await x.as(u), id, { version: (await cur(tx, id)).version, comment });
      await expectCode(cancel(x.owner, 'нечего'), 'NO_REVISION');
      await signAll(tx, x, id);
      await expectCode(cancel(x.owner, 'нечего'), 'NO_REVISION');
      await svc.reviseDocument(tx, await x.as(x.owner), id, { version: (await cur(tx, id)).version });
      await moveTo(tx, x, id, 13);
      expect((await view(tx, x.head, id)).can.cancelRevision).toBe(true);
      expect((await view(tx, x.staff, id)).can.cancelRevision).toBe(false);
      await expectCode(cancel(x.staff, 'чужой'), 'FORBIDDEN');
      await expectCode(cancel(x.head, '  '), 'EMPTY_COMMENT');
      await cancel(x.head, 'Изменения не нужны');

      const d = await view(tx, x.owner, id);
      expect(d).toMatchObject({ status: 'approved', approvedVersionNo: 1, working: null, stage: null });
      expect(d.current.no).toBe(1);
      expect(d.versions.map((v) => [v.no, v.approvedAt !== null, v.cancelledAt !== null])).toEqual([[2, false, true], [1, true, false]]);
      expect(d.history[0]).toMatchObject({ decision: 'cancelled', versionNo: 2, stage: 13, comment: 'Изменения не нужны' });
      // Новый пересмотр — версия 3.
      await svc.reviseDocument(tx, await x.as(x.owner), id, { version: (await cur(tx, id)).version });
      expect((await view(tx, x.owner, id)).current).toMatchObject({ no: 3, stage: 11 });
    }));
});

describe('документы: удаление (docs.delete)', () => {
  it('неподписанный — мягко, пропадает отовсюду, в журнале; подписанный — только в архив', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const signed = await x.create('Подписанный');
      await signAll(tx, x, signed);
      await expectCode(svc.deleteDocument(tx, await x.as(x.head), signed, { version: (await cur(tx, signed)).version }), 'DOC_SIGNED');
      expect((await view(tx, x.head, signed)).can.delete).toBe(false);

      const draft = await x.create('Ненужный драфт');
      await moveTo(tx, x, draft, 13);
      expect((await view(tx, x.head, draft)).can.delete).toBe(true);
      expect((await view(tx, x.owner, draft)).can.delete).toBe(false);
      await svc.deleteDocument(tx, await x.as(x.head), draft, { version: (await cur(tx, draft)).version, comment: 'Дубль' });

      const row = await tx.document.findUniqueOrThrow({ where: { id: draft } });
      expect(row.deletedAt).not.toBeNull();
      expect(row.archivedAt).not.toBeNull();
      expect(row.deletedBy).toBe(x.head.id);
      await expectCode(view(tx, x.head, draft), 'NOT_FOUND');
      expect((await list(tx, x.head)).some((d) => d.id === draft)).toBe(false);
      expect((await svc.listDocuments(tx, await svc.accessOf(tx, x.head.id), { archived: true, limit: 500 })).items.some((d) => d.id === draft)).toBe(false);
      await expectCode(svc.setDocumentArchived(tx, await x.as(x.admin), draft, row.version, false), 'NOT_FOUND');
      await expectCode(move(tx, x.head, draft, 'approve'), 'NOT_FOUND');
      expect((await tx.auditLog.findFirstOrThrow({ where: { action: 'document.deleted', entityId: draft } })).diff).toMatchObject({ summary: 'Документ #' + row.number + ' «Ненужный драфт» удалён: Дубль' });
      // Удалить подписанный нельзя и SQL-запросом.
      expect(await sqlError(tx, `UPDATE documents SET deleted_at = now(), archived_at = now() WHERE id = '${signed}'`)).toMatch(/documents_deleted_check/);
    }));
});

describe('документы: перенос при обновлении на 1.2.0 (seed docs.route.v1_2)', () => {
  it('рабочие версии 0 → 11, 1 → 13, 2 и 3 → 14; подписанные не трогаются; повторный запуск ничего не меняет', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const ids: string[] = [];
      for (const stage of [0, 1, 2, 3]) {
        const id = await x.create(`Старый на этапе ${stage}`);
        const v = must((await tx.document.findUniqueOrThrow({ where: { id } })).workingVersionId);
        await tx.documentVersion.update({ where: { id: v }, data: { stage } });
        ids.push(id);
      }
      const signed = await x.create('Подписанный');
      await signAll(tx, x, signed);
      const before = await tx.documentVersion.findFirstOrThrow({ where: { documentId: signed } });

      await seedDocumentRoute(tx);
      const stages = await Promise.all(ids.map(async (id) => (await cur(tx, id)).stage));
      expect(stages).toEqual([11, 13, 14, 14]);
      expect(await tx.documentVersion.findFirstOrThrow({ where: { documentId: signed } })).toEqual(before);
      const h = (await view(tx, x.owner, must(ids[1]))).history;
      expect(h[0]).toMatchObject({ decision: 'migrated', actor: 'Система', stage: 1, stageName: 'Начальник ИБ', toStage: 13, toStageName: 'Согласование начальника ИБ' });
      expect(await tx.auditLog.count({ where: { action: 'document.route_migrated' } })).toBeGreaterThanOrEqual(1);

      const decisions = await tx.documentApproval.count({ where: { decision: 'migrated', documentId: { in: ids } } });
      await seedDocumentRoute(tx);
      expect(await tx.documentApproval.count({ where: { decision: 'migrated', documentId: { in: ids } } })).toBe(decisions);
      // Перенесённый документ дальше идёт по новому маршруту.
      await move(tx, x.head, must(ids[1]), 'approve');
      expect((await cur(tx, must(ids[1]))).stage).toBe(14);
    }));
});

describe('документы: неизменность истории и подписанных версий', () => {
  it('роль приложения не правит и не удаляет историю и версии; подписанную версию не меняет триггер', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await signAll(tx, x, id);
      const v1 = await tx.documentVersion.findFirstOrThrow({ where: { documentId: id, no: 1 } });
      expect(await sqlError(tx, `UPDATE document_approvals SET comment = 'x' WHERE document_id = '${id}'`)).toMatch(/permission denied/);
      expect(await sqlError(tx, `DELETE FROM document_approvals WHERE document_id = '${id}'`)).toMatch(/permission denied/);
      expect(await sqlError(tx, 'TRUNCATE document_approvals')).toMatch(/permission denied/);
      expect(await sqlError(tx, `DELETE FROM document_versions WHERE id = '${v1.id}'`)).toMatch(/permission denied/);
      expect(await sqlError(tx, `UPDATE document_versions SET title = 'подмена' WHERE id = '${v1.id}'`)).toMatch(/утверждённая версия не меняется/);
      expect((await tx.documentVersion.findUniqueOrThrow({ where: { id: v1.id } })).title).toBe(v1.title);
    }));

  it('триггеры и ограничения срабатывают и для владельца схемы', async () => {
    const owner = createPrisma(testDbConfig().ownerUrl);
    try {
      await inOwnerTx(owner, async (tx) => {
        const x = await fixture(tx);
        const id = await x.create();
        await signAll(tx, x, id);
        const v1 = await tx.documentVersion.findFirstOrThrow({ where: { documentId: id, no: 1 } });
        expect(await sqlError(tx, `UPDATE document_approvals SET comment = 'x' WHERE document_id = '${id}'`)).toMatch(/только пополняется/);
        expect(await sqlError(tx, `UPDATE document_versions SET title = 'подмена' WHERE id = '${v1.id}'`)).toMatch(/утверждённая версия не меняется/);
        expect(await sqlError(tx, `DELETE FROM document_versions WHERE id = '${v1.id}'`)).toMatch(/версии не удаляются/);
        const draft = await x.create('Без PDF');
        const dv = must((await tx.document.findUniqueOrThrow({ where: { id: draft } })).workingVersionId);
        // Утвердить можно только подписанием на этапе 16 с датой и PDF.
        expect(await sqlError(tx, `UPDATE document_versions SET approved_at = now() WHERE id = '${dv}'`)).toMatch(/только с итоговым PDF/);
        const pdf = (await makeFileRow(tx, x.owner.id)).id;
        expect(await sqlError(tx, `UPDATE document_versions SET approved_at = now(), pdf_file_id = '${pdf}' WHERE id = '${dv}'`)).toMatch(/document_versions_approved_check/);
        expect(await sqlError(tx, `UPDATE document_versions SET stage = 16, approved_at = now(), pdf_file_id = '${pdf}', cancelled_at = now(), signed_on = '2026-10-01' WHERE id = '${dv}'`)).toMatch(/document_versions_cancelled_check/);
        expect(await sqlError(tx, `UPDATE document_versions SET stage = 7 WHERE id = '${dv}'`)).toMatch(/document_versions_stage_check/);
        // Привязки файлов не удаляются и для владельца схемы.
        const link = await tx.documentFile.findFirstOrThrow({ where: { documentId: id } });
        expect(await sqlError(tx, `DELETE FROM document_files WHERE id = '${link.id}'`)).toMatch(/не удаляется/);
      });
    } finally {
      await owner.$disconnect();
    }
  });

  it('утверждённая до 1.2.0 версия без PDF — «текст не зафиксирован», маршрут — старые этапы', async () => {
    const owner = createPrisma(testDbConfig().ownerUrl);
    try {
      await inOwnerTx(owner, async (tx) => {
        const x = await fixture(tx);
        const old = await x.create('Старая политика');
        const vid = must((await tx.document.findUniqueOrThrow({ where: { id: old } })).workingVersionId);
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
        await tx.documentVersion.update({ where: { id: vid }, data: { stage: 3, approvedAt: new Date() } });
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin');
        await tx.document.update({ where: { id: old }, data: { approvedVersionId: vid, workingVersionId: null, reviewDue: new Date('2027-10-27T00:00:00Z') } });
        const card = await view(tx, x.owner, old);
        expect(card.current.textFrozen).toBe(false);
        expect(card.route.map((r) => r.name)).toEqual(['Автор', 'Начальник ИБ', 'Юридический отдел', 'Утверждение правлением']);
        expect(card.can.revise).toBe(true);
      });
    } finally {
      await owner.$disconnect();
    }
  });
});

describe('документы: пересмотр', () => {
  const setDue = (tx: Tx, id: string, iso: string) => tx.document.update({ where: { id }, data: { reviewDue: new Date(`${iso}T00:00:00Z`) } });

  it('задача владельцу за 30 дней до пересмотра; повторный прогон дублей не даёт; новая дата — комментарий; подписание закрывает', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await signAll(tx, x, id);
      const today = '2027-03-01';

      await setDue(tx, id, '2027-04-01'); // через 31 день
      expect(await runDocumentReviews(tx, { today })).toEqual({ events: 0, tasksCreated: 0, tasksCommented: 0 });
      await setDue(tx, id, '2027-03-31'); // через 30 дней
      expect(await runDocumentReviews(tx, { today })).toEqual({ events: 1, tasksCreated: 1, tasksCommented: 0 });
      expect(await runDocumentReviews(tx, { today })).toEqual({ events: 0, tasksCreated: 0, tasksCommented: 0 });

      const task = must((await tx.task.findMany({ where: { documentId: id, documentReason: 'review' } }))[0]);
      expect(task).toMatchObject({ assigneeId: x.owner.id, source: 'document' });
      expect(task.dueDate?.toISOString().slice(0, 10)).toBe('2027-03-31');

      await setDue(tx, id, '2027-03-20');
      expect(await runDocumentReviews(tx, { today })).toEqual({ events: 1, tasksCreated: 0, tasksCommented: 1 });

      await svc.reviseDocument(tx, await x.as(x.owner), id, { version: (await cur(tx, id)).version });
      await setDue(tx, id, '2027-03-10');
      expect((await runDocumentReviews(tx, { today })).events).toBe(0);

      await signAll(tx, x, id);
      expect((await tx.task.findUniqueOrThrow({ where: { id: task.id } })).completedAt).not.toBeNull();
    }));

  it('цикл пересмотра меняется — дата от даты подписания', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await signAll(tx, x, id);
      await svc.updateDocument(tx, await x.as(x.admin), id, { version: (await cur(tx, id)).version, reviewMonths: 6 });
      expect((await view(tx, x.owner, id)).reviewDue).toBe(addMonthsIso(SIGNED_ON, 6));
    }));

  it('просроченный пересмотр виден в реестре и в счётчике сотрудников ИБ; архивный не контролируется', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await signAll(tx, x, id);
      await setDue(tx, id, '2020-01-01');
      expect((await view(tx, x.owner, id)).status).toBe('review_overdue');
      expect((await svc.documentSummary(tx, await svc.accessOf(tx, x.legal.id))).reviewOverdue).toBe(0);
      const before = (await svc.documentSummary(tx, await svc.accessOf(tx, x.owner.id))).reviewOverdue;
      expect(before).toBeGreaterThanOrEqual(1);
      await svc.setDocumentArchived(tx, await x.as(x.admin), id, (await cur(tx, id)).version, true);
      expect((await svc.documentSummary(tx, await svc.accessOf(tx, x.owner.id))).reviewOverdue).toBe(before - 1);
      expect((await runDocumentReviews(tx, { today: todayIso() })).events).toBe(0);
    }));
});

describe('документы: пользователи без ib.work', () => {
  it('видят только подписанные; маршрут, черновики и архив — нет', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const signed = await x.create('Подписанный');
      await signAll(tx, x, signed);
      const draft = await x.create('Черновик');
      const atHead = await x.create('У начальника ИБ');
      await moveTo(tx, x, atHead, 13);
      const archived = await x.create('Архивный');
      await signAll(tx, x, archived);
      await svc.setDocumentArchived(tx, await x.as(x.admin), archived, (await cur(tx, archived)).version, true);

      const titles = async (u: User) => (await list(tx, u)).filter((d) => [signed, draft, atHead, archived].includes(d.id)).map((d) => d.title).sort();
      expect(await titles(x.legal)).toEqual(['Подписанный']);
      await expectCode(view(tx, x.legal, draft), 'NOT_FOUND');
      await expectCode(view(tx, x.legal, atHead), 'NOT_FOUND');
      expect((await svc.listDocuments(tx, await svc.accessOf(tx, x.legal.id), { archived: true, limit: 50 })).items).toEqual([]);
      expect(await titles(x.staff)).toEqual(['Подписанный', 'У начальника ИБ', 'Черновик']);
      await expectCode(x.create('Чужой', x.legal.id), 'BAD_OWNER');
    }));

  it('ссылка OnlyOffice — только http(s)', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      await expectCode(svc.createDocument(tx, await x.as(x.admin), { title: 'X', typeId: x.type.id, ownerId: x.owner.id, onlyofficeUrl: 'javascript:alert(1)' }), 'BAD_URL');
    }));
});
