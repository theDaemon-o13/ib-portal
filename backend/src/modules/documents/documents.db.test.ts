import type { User } from '../../generated/prisma/client.js';
import { describe, expect, it } from 'vitest';
import { testDbConfig } from '../../../scripts/test-db.js';
import { createPrisma } from '../../lib/db.js';
import { todayIso } from '../../lib/today.js';
import { actorFor, expectCode, inTx, makeFileRow, makeUser, must, type Tx } from '../../test/db.js';
import type { Actor } from '../settings/common.js';
import { runDocumentReviews } from './review.js';
import * as svc from './service.js';
import { addMonthsIso } from './status.js';

const URL1 = 'https://office.example.local/products/files/doceditor.aspx?fileid=101';

async function fixture(tx: Tx) {
  const type = await tx.catalogItem.create({ data: { catalogCode: 'document_types', value: `Политика ${Math.random().toString(36).slice(2)}` } });
  const admin = await makeUser(tx, ['super_admin'], { fullName: 'Администратор' });
  const owner = await makeUser(tx, ['ib_staff'], { fullName: 'Автор Документа' });
  const head = await makeUser(tx, ['ib_staff', 'ib_head'], { fullName: 'Начальник ИБ' });
  const legal = await makeUser(tx, ['legal'], { fullName: 'Юрист' });
  const board = await makeUser(tx, ['board'], { fullName: 'Правление' });
  const as = async (u: User): Promise<Actor> => actorFor(tx, u.id);
  const create = async (title = 'Политика информационной безопасности', ownerId = owner.id) =>
    svc.createDocument(tx, await as(admin), { title, typeId: type.id, ownerId, onlyofficeUrl: URL1, edition: '1.0' });
  return { type, admin, owner, head, legal, board, as, create };
}
type Fx = Awaited<ReturnType<typeof fixture>>;

/** Версия документа и этап рабочей версии — то, что пользователь видит на экране. */
async function cur(tx: Tx, id: string) {
  const d = await tx.document.findUniqueOrThrow({ where: { id }, include: { workingVersion: true } });
  return { version: d.version, stage: d.workingVersion?.stage ?? -1 };
}

async function act(tx: Tx, fn: typeof svc.approveDocument, u: User, id: string, comment?: string) {
  // Отправка на согласование — с итоговым PDF (этап 7): файл загружает тот, кто отправляет.
  const pdfFileId = fn === svc.submitDocument ? (await makeFileRow(tx, u.id)).id : undefined;
  return fn(tx, await actorFor(tx, u.id), id, { ...(await cur(tx, id)), comment, pdfFileId });
}

/** Карточка глазами пользователя; history — как у пользователя с правом «История в карточках» (проверки маршрута ниже). */
const view = async (tx: Tx, u: User, id: string, opts: { history?: boolean } = { history: true }) => {
  const a = await svc.accessOf(tx, u.id);
  return svc.getDocument(tx, opts.history ? { ...a, perms: new Set([...a.perms, 'history.view']) } : a, id);
};
const list = async (tx: Tx, u: User) => (await svc.listDocuments(tx, await svc.accessOf(tx, u.id), { archived: false, limit: 500 })).items;

/** Утвердить документ полным маршрутом. */
async function approveAll(tx: Tx, x: Fx, id: string) {
  await act(tx, svc.submitDocument, x.owner, id);
  await act(tx, svc.approveDocument, x.head, id);
  await act(tx, svc.approveDocument, x.legal, id);
  await act(tx, svc.approveDocument, x.board, id);
}

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

describe('документы: маршрут согласования', () => {
  it('подробная история — только с правом «История в карточках»; кто согласовал этапы — видят все (ADR-0021)', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await approveAll(tx, x, id);
      const plain = await view(tx, x.owner, id, { history: false });
      expect(plain.history).toEqual([]);
      expect(plain.route.map((r) => r.actedBy)).toEqual(['Автор Документа', 'Начальник ИБ', 'Юрист', 'Правление']);
      expect((await view(tx, x.owner, id)).history).toHaveLength(4);
    }));

  it('каждый этап согласует только пользователь с правом этапа; после правления версия утверждена', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      expect((await view(tx, x.owner, id)).status).toBe('draft');

      // Этап «Автор»: не владелец и без docs.manage — нельзя.
      await expectCode(act(tx, svc.submitDocument, x.head, id), 'FORBIDDEN');
      await act(tx, svc.submitDocument, x.owner, id);
      expect((await view(tx, x.owner, id)).status).toBe('in_approval');

      // Этап «Начальник ИБ»: автор без права этапа за следующий этап не согласует; юрист и правление — тоже.
      await expectCode(act(tx, svc.approveDocument, x.owner, id), 'FORBIDDEN');
      await expectCode(act(tx, svc.approveDocument, x.legal, id), 'FORBIDDEN');
      await expectCode(act(tx, svc.approveDocument, x.board, id), 'FORBIDDEN');
      await act(tx, svc.approveDocument, x.head, id);

      // Этап «Юридический отдел».
      await expectCode(act(tx, svc.approveDocument, x.board, id), 'FORBIDDEN');
      await expectCode(act(tx, svc.approveDocument, x.head, id), 'FORBIDDEN');
      await act(tx, svc.approveDocument, x.legal, id);

      // Этап «Утверждение правлением».
      await expectCode(act(tx, svc.approveDocument, x.legal, id), 'FORBIDDEN');
      await act(tx, svc.approveDocument, x.board, id);

      const d = await view(tx, x.owner, id);
      expect(d.status).toBe('approved');
      expect(d.approvedVersionNo).toBe(1);
      expect(d.working).toBeNull();
      expect(d.reviewDue).toBe(addMonthsIso(todayIso(), 12));
      expect(d.route.every((r) => r.state === 'done')).toBe(true);
      expect(d.route.map((r) => r.actedBy)).toEqual(['Автор Документа', 'Начальник ИБ', 'Юрист', 'Правление']);
      expect(d.history.map((h) => `${h.decision}:${h.stage}`)).toEqual(['approved:3', 'approved:2', 'approved:1', 'submitted:0']);
      // После утверждения маршрута нет — согласовывать нечего.
      await expectCode(svc.approveDocument(tx, await x.as(x.board), id, { version: d.version, stage: 3 }), 'NOT_IN_ROUTE');
    }));

  it('устаревший этап или версия на экране — 409: двойной щелчок не согласует следующий этап', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await act(tx, svc.submitDocument, x.owner, id);
      const seen = await cur(tx, id);
      await svc.approveDocument(tx, await x.as(x.head), id, seen);
      await expectCode(svc.approveDocument(tx, await x.as(x.head), id, seen), 'VERSION_CONFLICT');
      await expectCode(svc.approveDocument(tx, await x.as(x.legal), id, { ...(await cur(tx, id)), stage: 1 }), 'STAGE_CHANGED');
    }));

  it('супер-администратор не согласует этапы ни через какую роль, но отправляет на согласование за автора (docs.manage)', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const adminHead = await makeUser(tx, ['super_admin', 'ib_head', 'legal', 'board'], { fullName: 'Админ с правами этапов' });
      const id = await x.create();
      await act(tx, svc.submitDocument, adminHead, id);
      await expectCode(act(tx, svc.approveDocument, adminHead, id), 'SEPARATION_OF_DUTIES');
      await expectCode(act(tx, svc.returnDocument, adminHead, id, 'замечание'), 'SEPARATION_OF_DUTIES');
      const d = await view(tx, adminHead, id);
      expect(d.can.approve).toBe(false);
      expect(d.blockedReason).toMatch(/Супер-администратор не согласует/);
      // В списке «кто может согласовать» его нет.
      expect(d.route.find((r) => r.stage === 1)?.approvers).not.toContain('Админ с правами этапов');
      expect(d.route.find((r) => r.stage === 1)?.approvers).toContain('Начальник ИБ');
      expect((await svc.documentSummary(tx, await svc.accessOf(tx, adminHead.id))).waitingForMe).toBe(0);
    }));

  it('один человек не согласует два этапа одной версии', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const multi = await makeUser(tx, ['ib_staff', 'ib_head', 'legal'], { fullName: 'Два права' });
      const id = await x.create();
      await act(tx, svc.submitDocument, x.owner, id);
      await act(tx, svc.approveDocument, multi, id);
      await expectCode(act(tx, svc.approveDocument, multi, id), 'SEPARATION_OF_DUTIES');
      expect((await view(tx, multi, id)).blockedReason).toMatch(/уже согласовали этап «Начальник ИБ»/);
      await act(tx, svc.approveDocument, x.legal, id);
    }));
});

describe('документы: владелец и этапы своего документа', () => {
  it('владелец с правом этапа при наличии другого согласующего не согласует — даже если отправил другой (docs.manage)', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const headOwner = await makeUser(tx, ['ib_staff', 'ib_head'], { fullName: 'Начальник-владелец' });
      const id = await x.create('Регламент', headOwner.id);
      await act(tx, svc.submitDocument, x.admin, id); // отправил не владелец
      const d = await view(tx, headOwner, id);
      expect(d.current.stage).toBe(1); // этап не пропущен: есть другой начальник ИБ
      expect(d.route[1]?.skipped).toBeNull();
      expect(d.route[1]?.approvers).toEqual(['Начальник ИБ']); // владельца в списке согласующих нет
      expect(d.can.approve).toBe(false);
      expect(d.blockedReason).toMatch(/Владелец не согласует этапы своего документа/);
      expect(d.waitingForMe).toBe(false);
      await expectCode(act(tx, svc.approveDocument, headOwner, id), 'SEPARATION_OF_DUTIES');
      await expectCode(act(tx, svc.returnDocument, headOwner, id, 'сам себе'), 'SEPARATION_OF_DUTIES');
      await act(tx, svc.approveDocument, x.head, id);
      expect((await view(tx, headOwner, id)).current.stage).toBe(2);
    }));

  it('владелец — единственный начальник ИБ: этап «Начальник ИБ» пропущен с записью в истории; юрист и правление обязательны', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      await tx.user.update({ where: { id: x.head.id }, data: { isActive: false } }); // другого начальника ИБ нет
      const headOwner = await makeUser(tx, ['ib_staff', 'ib_head'], { fullName: 'Единственный начальник' });
      const id = await x.create('Политика', headOwner.id);
      await act(tx, svc.submitDocument, headOwner, id);

      const d = await view(tx, headOwner, id);
      expect(d.current.stage).toBe(2); // сразу у юриста
      expect(d.route.map((r) => r.state)).toEqual(['done', 'done', 'current', 'todo']);
      expect(d.route[1]?.skipped).toMatch(/^Не требуется: автор — Начальник ИБ\. Владелец документа Единственный начальник/);
      expect(d.route[1]?.actedBy).toBeNull();
      const skip = must(d.history.find((h) => h.decision === 'skipped'));
      expect(skip).toMatchObject({ stage: 1, actor: 'Единственный начальник', versionNo: 1, round: 1 });
      expect(skip.comment).toMatch(/других согласующих нет/);
      const audit = await tx.auditLog.findFirstOrThrow({ where: { entity: 'document', entityId: id, action: 'document.stage_skipped' } });
      expect((audit.diff as { after: { ownerId: string } }).after.ownerId).toBe(headOwner.id);

      // Юрист и правление обязательны: владелец за них не согласует, документ ждёт их.
      await expectCode(act(tx, svc.approveDocument, headOwner, id), 'FORBIDDEN');
      expect((await view(tx, x.legal, id)).waitingForMe).toBe(true);
      await act(tx, svc.approveDocument, x.legal, id);
      expect((await view(tx, headOwner, id)).status).toBe('in_approval');
      await act(tx, svc.approveDocument, x.board, id);
      expect((await view(tx, headOwner, id)).status).toBe('approved');

      // Возврат и повторная отправка: этап снова пропускается в новом круге.
      await svc.reviseDocument(tx, await x.as(headOwner), id, { version: (await cur(tx, id)).version });
      await act(tx, svc.submitDocument, headOwner, id);
      await act(tx, svc.returnDocument, x.legal, id, 'Уточните раздел 2');
      await act(tx, svc.submitDocument, headOwner, id);
      const again = await view(tx, headOwner, id);
      expect(again.current).toMatchObject({ no: 2, round: 2, stage: 2 });
      expect(again.history.filter((h) => h.decision === 'skipped' && h.versionNo === 2).map((h) => h.round)).toEqual([2, 1]);
    }));

  it('пропуск последнего этапа утверждает документ; без права этапа у владельца этап не пропускается', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      await tx.user.update({ where: { id: x.board.id }, data: { isActive: false } });
      const boardOwner = await makeUser(tx, ['ib_staff', 'board'], { fullName: 'Владелец из правления' });
      const id = await x.create('Стратегия', boardOwner.id);
      await act(tx, svc.submitDocument, boardOwner, id);
      await act(tx, svc.approveDocument, x.head, id);
      await act(tx, svc.approveDocument, x.legal, id);
      const d = await view(tx, boardOwner, id);
      expect(d.status).toBe('approved');
      expect(d.route[3]?.skipped).toMatch(/Не требуется: автор — Утверждение правлением/);

      // Правления нет совсем, а у владельца права нет — этап не пропускается: документ ждёт, «никто не назначен».
      await tx.user.update({ where: { id: boardOwner.id }, data: { isActive: false } });
      const plain = await x.create('Без правления');
      await act(tx, svc.submitDocument, x.owner, plain);
      await act(tx, svc.approveDocument, x.head, plain);
      await act(tx, svc.approveDocument, x.legal, plain);
      const p = await view(tx, x.owner, plain);
      expect(p.current.stage).toBe(3);
      expect(p.route[3]).toMatchObject({ state: 'current', skipped: null, approvers: [] });
    }));
});

describe('документы: возврат на доработку', () => {
  it('только с комментарием; маршрут заново; владельцу задача, повтор — комментарий; отправка закрывает задачу', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await act(tx, svc.submitDocument, x.owner, id);
      await act(tx, svc.approveDocument, x.head, id);

      await expectCode(act(tx, svc.returnDocument, x.legal, id, '   '), 'EMPTY_COMMENT');
      await expectCode(act(tx, svc.returnDocument, x.board, id, 'не мой этап'), 'FORBIDDEN');
      await act(tx, svc.returnDocument, x.legal, id, 'Нет ссылки на закон о персональных данных');

      const d = await view(tx, x.owner, id);
      expect(d.status).toBe('draft');
      expect(d.current.stage).toBe(0);
      expect(d.current.round).toBe(2);
      expect(d.route.every((r) => r.state !== 'done')).toBe(true);
      expect(d.history[0]).toMatchObject({ decision: 'returned', stage: 2, actor: 'Юрист', comment: 'Нет ссылки на закон о персональных данных' });
      // Замечание возврата — в карточке и без права на историю.
      const plain = await view(tx, x.owner, id, { history: false });
      expect(plain.history).toEqual([]);
      expect(plain.returned).toMatchObject({ actor: 'Юрист', comment: 'Нет ссылки на закон о персональных данных' });

      const tasks = await tx.task.findMany({ where: { documentId: id }, include: { category: true } });
      expect(tasks).toHaveLength(1);
      const task = must(tasks[0]);
      expect(task).toMatchObject({ assigneeId: x.owner.id, source: 'document', documentReason: 'returned', completedAt: null });
      expect(task.category.systemKey).toBe('documents');
      expect(task.description).toContain('Нет ссылки на закон');
      // Юристу (без ib.work) задач не ставится.
      expect(await tx.task.count({ where: { assigneeId: x.legal.id } })).toBe(0);

      // Новый круг: начальник ИБ снова согласует свой этап, юрист снова возвращает — комментарий в ту же задачу.
      await act(tx, svc.submitDocument, x.owner, id);
      expect((await tx.task.findUniqueOrThrow({ where: { id: task.id } })).completedAt).not.toBeNull();
      await act(tx, svc.approveDocument, x.head, id);
      await act(tx, svc.returnDocument, x.legal, id, 'Ещё раз: раздел 4');
      const after = await tx.task.findMany({ where: { documentId: id, documentReason: 'returned' }, orderBy: { number: 'asc' } });
      // Первая задача закрыта при отправке, поэтому повторный возврат создал новую.
      expect(after).toHaveLength(2);
      expect(after.filter((t) => t.completedAt === null)).toHaveLength(1);
    }));

  it('повторный возврат при открытой задаче — комментарий в неё', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await act(tx, svc.submitDocument, x.admin, id); // за автора: задача доработки не закрывается — её не было
      await act(tx, svc.returnDocument, x.head, id, 'Первое замечание');
      // Администратор отправляет за автора — задача доработки закрывается; чтобы проверить повтор, задачу откроем вручную.
      const t = await tx.task.findFirstOrThrow({ where: { documentId: id } });
      await act(tx, svc.submitDocument, x.admin, id);
      await tx.task.update({ where: { id: t.id }, data: { completedAt: null } });
      await act(tx, svc.returnDocument, x.head, id, 'Второе замечание');
      expect(await tx.task.count({ where: { documentId: id } })).toBe(1);
      const comments = await tx.taskComment.findMany({ where: { taskId: t.id }, orderBy: { createdAt: 'asc' } });
      expect(comments.at(-1)?.body).toMatch(/Повторный возврат.*Второе замечание/);
    }));
});

describe('документы: неизменность истории и утверждённых версий', () => {
  it('роль приложения не правит и не удаляет историю и версии; утверждённую версию не меняет триггер', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await approveAll(tx, x, id);
      const v1 = await tx.documentVersion.findFirstOrThrow({ where: { documentId: id, no: 1 } });
      expect(await sqlError(tx, `UPDATE document_approvals SET comment = 'x' WHERE document_id = '${id}'`)).toMatch(/permission denied/);
      expect(await sqlError(tx, `DELETE FROM document_approvals WHERE document_id = '${id}'`)).toMatch(/permission denied/);
      expect(await sqlError(tx, 'TRUNCATE document_approvals')).toMatch(/permission denied/);
      expect(await sqlError(tx, `DELETE FROM document_versions WHERE id = '${v1.id}'`)).toMatch(/permission denied/);
      // UPDATE версий у роли есть (черновик правится), но утверждённую версию останавливает триггер.
      expect(await sqlError(tx, `UPDATE document_versions SET title = 'подмена' WHERE id = '${v1.id}'`)).toMatch(/утверждённая версия не меняется/);
      expect((await tx.documentVersion.findUniqueOrThrow({ where: { id: v1.id } })).title).toBe(v1.title);
    }));

  it('триггеры срабатывают и для владельца схемы', async () => {
    const owner = createPrisma(testDbConfig().ownerUrl);
    try {
      await inOwnerTx(owner, async (tx) => {
        const x = await fixture(tx);
        const id = await x.create();
        await approveAll(tx, x, id);
        const v1 = await tx.documentVersion.findFirstOrThrow({ where: { documentId: id, no: 1 } });
        expect(await sqlError(tx, `UPDATE document_approvals SET comment = 'x' WHERE document_id = '${id}'`)).toMatch(/только пополняется/);
        expect(await sqlError(tx, `DELETE FROM document_approvals WHERE document_id = '${id}'`)).toMatch(/только пополняется/);
        expect(await sqlError(tx, `UPDATE document_versions SET title = 'подмена' WHERE id = '${v1.id}'`)).toMatch(/утверждённая версия не меняется/);
        expect(await sqlError(tx, `DELETE FROM document_versions WHERE id = '${v1.id}'`)).toMatch(/версии не удаляются/);
        // «Утверждение только с PDF» — и для владельца схемы, и при вставке готовой утверждённой версии.
        const draft = await x.create('Без PDF');
        const dv = must((await tx.document.findUniqueOrThrow({ where: { id: draft } })).workingVersionId);
        expect(await sqlError(tx, `UPDATE document_versions SET approved_at = now() WHERE id = '${dv}'`)).toMatch(/только с итоговым PDF/);
        expect(await sqlError(tx, `INSERT INTO document_versions (id, document_id, no, title, edition, onlyoffice_url, change_note, created_by, approved_at)
          SELECT gen_random_uuid(), document_id, 99, title, edition, onlyoffice_url, '', created_by, now() FROM document_versions WHERE id = '${dv}'`)).toMatch(/только с итоговым PDF/);
        // Обнулить PDF у утверждённой версии нельзя: запрещает guard, а без него — и эта проверка.
        expect(await sqlError(tx, `UPDATE document_versions SET pdf_file_id = NULL WHERE id = '${v1.id}'`)).toMatch(/утверждённая версия не меняется/);
        await tx.$executeRawUnsafe('ALTER TABLE document_versions DISABLE TRIGGER document_versions_guard');
        expect(await sqlError(tx, `UPDATE document_versions SET pdf_file_id = NULL WHERE id = '${v1.id}'`)).toMatch(/только с итоговым PDF/);
        await tx.$executeRawUnsafe('ALTER TABLE document_versions ENABLE TRIGGER document_versions_guard');
        expect((await tx.documentVersion.findUniqueOrThrow({ where: { id: v1.id } })).pdfFileId).toBe(v1.pdfFileId);
      });
    } finally {
      await owner.$disconnect();
    }
  });
});

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

describe('документы: новая версия', () => {
  it('правка утверждённого — новая версия через маршрут заново; утверждённая версия остаётся в истории', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await approveAll(tx, x, id);
      const v1 = await tx.documentVersion.findFirstOrThrow({ where: { documentId: id, no: 1 } });

      // Утверждённую версию напрямую не правят.
      await expectCode(svc.updateDocument(tx, await x.as(x.owner), id, { ...(await cur(tx, id)), title: 'Новое название' }), 'DOC_APPROVED');
      // Новую версию создаёт владелец или docs.manage.
      await expectCode(svc.reviseDocument(tx, await x.as(x.head), id, { version: (await cur(tx, id)).version }), 'FORBIDDEN');
      await svc.reviseDocument(tx, await x.as(x.owner), id, { version: (await cur(tx, id)).version, edition: '2.0', changeNote: 'Раздел 5 переписан' });
      await expectCode(svc.reviseDocument(tx, await x.as(x.owner), id, { version: (await cur(tx, id)).version }), 'HAS_WORKING');

      let d = await view(tx, x.owner, id);
      expect(d.status).toBe('in_review');
      expect(d.current).toMatchObject({ no: 2, stage: 0, round: 1, edition: '2.0', approvedAt: null });
      expect(d.approved?.no).toBe(1);
      await svc.updateDocument(tx, await x.as(x.owner), id, { ...(await cur(tx, id)), title: 'Политика ИБ, ред. 2' });

      // Юрист видит действующую версию 1, пока версия 2 не дошла до него.
      expect((await view(tx, x.legal, id)).current.no).toBe(1);

      await approveAll(tx, x, id);
      d = await view(tx, x.owner, id);
      expect(d.status).toBe('approved');
      expect(d.approvedVersionNo).toBe(2);
      expect(d.title).toBe('Политика ИБ, ред. 2');
      expect(d.versions.map((v) => [v.no, v.approvedAt !== null])).toEqual([[2, true], [1, true]]);
      expect(d.history.some((h) => h.decision === 'revision_started' && h.versionNo === 2)).toBe(true);
      const v1After = await tx.documentVersion.findUniqueOrThrow({ where: { id: v1.id } });
      expect(v1After).toEqual(v1);
    }));

  it('пересмотр без изменений — тоже новая версия через полный маршрут', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await approveAll(tx, x, id);
      await svc.reviseDocument(tx, await x.as(x.admin), id, { version: (await cur(tx, id)).version });
      const d = await view(tx, x.owner, id);
      expect(d.current).toMatchObject({ no: 2, stage: 0, title: 'Политика информационной безопасности', onlyofficeUrl: URL1, edition: '1.0' });
      await approveAll(tx, x, id);
      expect((await view(tx, x.owner, id)).approvedVersionNo).toBe(2);
    }));
});

describe('документы: пересмотр', () => {
  const setDue = (tx: Tx, id: string, iso: string) => tx.document.update({ where: { id }, data: { reviewDue: new Date(`${iso}T00:00:00Z`) } });

  it('задача владельцу за 30 дней до пересмотра; повторный прогон дублей не даёт; новая дата — комментарий; утверждение закрывает', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await approveAll(tx, x, id);
      const today = '2027-03-01';

      await setDue(tx, id, '2027-04-01'); // через 31 день
      expect(await runDocumentReviews(tx, { today })).toEqual({ events: 0, tasksCreated: 0, tasksCommented: 0 });

      await setDue(tx, id, '2027-03-31'); // через 30 дней
      expect(await runDocumentReviews(tx, { today })).toEqual({ events: 1, tasksCreated: 1, tasksCommented: 0 });
      expect(await runDocumentReviews(tx, { today })).toEqual({ events: 0, tasksCreated: 0, tasksCommented: 0 });
      expect(await runDocumentReviews(tx, { today: '2027-03-02' })).toEqual({ events: 0, tasksCreated: 0, tasksCommented: 0 });

      const tasks = await tx.task.findMany({ where: { documentId: id, documentReason: 'review' } });
      expect(tasks).toHaveLength(1);
      const task = must(tasks[0]);
      expect(task).toMatchObject({ assigneeId: x.owner.id, source: 'document' });
      expect(task.dueDate?.toISOString().slice(0, 10)).toBe('2027-03-31');
      const ev = await tx.automationEvent.findMany({ where: { documentId: id }, include: { tasks: true } });
      expect(ev.map((e) => [e.status, e.triggerKey, e.tasks[0]?.action])).toEqual([['processed', '2027-03-31', 'created']]);

      // Цикл сменили — новая дата пересмотра даёт новое событие; задача ещё открыта — комментарий в неё.
      await setDue(tx, id, '2027-03-20');
      expect(await runDocumentReviews(tx, { today })).toEqual({ events: 1, tasksCreated: 0, tasksCommented: 1 });
      expect(await tx.task.count({ where: { documentId: id, documentReason: 'review' } })).toBe(1);

      // Пересмотр начат (новая версия в работе) — новые события не создаются.
      await svc.reviseDocument(tx, await x.as(x.owner), id, { version: (await cur(tx, id)).version });
      await setDue(tx, id, '2027-03-10');
      expect((await runDocumentReviews(tx, { today })).events).toBe(0);

      // Новая версия утверждена — задача пересмотра закрывается сама.
      await approveAll(tx, x, id);
      expect((await tx.task.findUniqueOrThrow({ where: { id: task.id } })).completedAt).not.toBeNull();
    }));

  it('просроченный пересмотр виден в реестре и в счётчике сотрудников ИБ; архивный не контролируется', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await approveAll(tx, x, id);
      await setDue(tx, id, '2020-01-01');
      expect((await view(tx, x.owner, id)).status).toBe('review_overdue');
      expect((await svc.documentSummary(tx, await svc.accessOf(tx, x.owner.id))).reviewOverdue).toBeGreaterThanOrEqual(1);
      expect((await svc.documentSummary(tx, await svc.accessOf(tx, x.legal.id))).reviewOverdue).toBe(0);
      const before = (await svc.documentSummary(tx, await svc.accessOf(tx, x.owner.id))).reviewOverdue;
      await svc.setDocumentArchived(tx, await x.as(x.admin), id, (await cur(tx, id)).version, true);
      expect((await svc.documentSummary(tx, await svc.accessOf(tx, x.owner.id))).reviewOverdue).toBe(before - 1);
      expect((await runDocumentReviews(tx, { today: todayIso() })).events).toBe(0);
    }));

  it('владелец без доступа к ИБ — задача без ответственного с меткой «Владелец документа»', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await approveAll(tx, x, id);
      await tx.userRole.deleteMany({ where: { userId: x.owner.id } });
      await setDue(tx, id, '2027-03-31');
      expect((await runDocumentReviews(tx, { today: '2027-03-01' })).tasksCreated).toBe(1);
      const t = await tx.task.findFirstOrThrow({ where: { documentId: id } });
      expect(t).toMatchObject({ assigneeId: null, recipientLabel: 'Владелец документа' });
    }));
});

describe('документы: пользователи без ib.work', () => {
  it('юрист видит утверждённые и «ждёт вас», а также согласованные им в текущем круге; черновики и архив — нет', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const approved = await x.create('Утверждённый');
      await approveAll(tx, x, approved);
      const draft = await x.create('Черновик');
      const atHead = await x.create('У начальника ИБ');
      await act(tx, svc.submitDocument, x.owner, atHead);
      const atLegal = await x.create('У юриста');
      await act(tx, svc.submitDocument, x.owner, atLegal);
      await act(tx, svc.approveDocument, x.head, atLegal);
      const archived = await x.create('Архивный');
      await approveAll(tx, x, archived);
      await svc.setDocumentArchived(tx, await x.as(x.admin), archived, (await cur(tx, archived)).version, true);

      const titles = async (u: User) => (await list(tx, u)).filter((d) => [approved, draft, atHead, atLegal, archived].includes(d.id)).map((d) => d.title).sort();
      expect(await titles(x.legal)).toEqual(['У юриста', 'Утверждённый']);
      expect((await list(tx, x.legal)).find((d) => d.id === atLegal)?.waitingForMe).toBe(true);
      expect((await svc.documentSummary(tx, await svc.accessOf(tx, x.legal.id))).waitingForMe).toBeGreaterThanOrEqual(1);
      await expectCode(view(tx, x.legal, draft), 'NOT_FOUND');
      await expectCode(view(tx, x.legal, atHead), 'NOT_FOUND');
      expect((await svc.listDocuments(tx, await svc.accessOf(tx, x.legal.id), { archived: true, limit: 50 })).items).toEqual([]);

      // Согласовал — документ остаётся виден (текущий круг), уже не «ждёт вас».
      await act(tx, svc.approveDocument, x.legal, atLegal);
      const after = (await list(tx, x.legal)).find((d) => d.id === atLegal);
      expect(after).toMatchObject({ waitingForMe: false, stage: 3 });
      // Правление видит его как «ждёт вас»; сотрудник ИБ видит всё.
      expect((await list(tx, x.board)).find((d) => d.id === atLegal)?.waitingForMe).toBe(true);
      expect(await titles(x.owner)).toEqual(['У начальника ИБ', 'У юриста', 'Утверждённый', 'Черновик']);

      // Владелец документа — только сотрудник ИБ.
      await expectCode(x.create('Чужой', x.legal.id), 'BAD_OWNER');
      // Юрист не получает задач даже как возвращающий.
      expect(await tx.task.count({ where: { assigneeId: { in: [x.legal.id, x.board.id] } } })).toBe(0);
    }));

  it('ссылка OnlyOffice — только http(s)', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      await expectCode(svc.createDocument(tx, await x.as(x.admin), { title: 'X', typeId: x.type.id, ownerId: x.owner.id, onlyofficeUrl: 'javascript:alert(1)' }), 'BAD_URL');
    }));
});

describe('документы: итоговый PDF (этап 7)', () => {
  it('без PDF на согласование не отправить; все этапы согласуют один файл — sha256 в истории каждого решения', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await expectCode(svc.submitDocument(tx, await x.as(x.owner), id, await cur(tx, id)), 'PDF_REQUIRED');
      // Чужой файл и не PDF не прикладываются.
      const foreign = await makeFileRow(tx, x.head.id);
      await expectCode(svc.submitDocument(tx, await x.as(x.owner), id, { ...(await cur(tx, id)), pdfFileId: foreign.id }), 'FILE_NOT_YOURS');
      const png = await makeFileRow(tx, x.owner.id, { name: 'скан.png', mime: 'image/png' });
      await expectCode(svc.submitDocument(tx, await x.as(x.owner), id, { ...(await cur(tx, id)), pdfFileId: png.id }), 'BAD_FILE_TYPE');

      const pdf = await makeFileRow(tx, x.owner.id);
      await svc.submitDocument(tx, await x.as(x.owner), id, { ...(await cur(tx, id)), pdfFileId: pdf.id });
      await act(tx, svc.approveDocument, x.head, id);
      await act(tx, svc.approveDocument, x.legal, id);
      await act(tx, svc.approveDocument, x.board, id);
      const card = await view(tx, x.owner, id);
      expect(card.status).toBe('approved');
      expect(card.current.pdf?.sha256).toBe(pdf.sha256);
      expect(card.current.textFrozen).toBe(true);
      const acts = card.history.filter((h) => h.decision === 'submitted' || h.decision === 'approved');
      expect(acts).toHaveLength(4);
      expect(acts.every((h) => h.pdfSha256 === pdf.sha256)).toBe(true);
      // Юрист видит утверждённую версию — и её PDF.
      expect(await svc.versionVisible(tx, await svc.accessOf(tx, x.legal.id), card.current.id)).toBe(true);
    }));

  it('утверждение версии без PDF (ушла на согласование до этапа 7) отклоняется; утверждённая без PDF — «текст не зафиксирован»', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      const d = await tx.document.findUniqueOrThrow({ where: { id } });
      // Как версия, отправленная прежним backend: этап 1 без PDF.
      await tx.documentVersion.update({ where: { id: must(d.workingVersionId) }, data: { stage: 1 } });
      await expectCode(act(tx, svc.approveDocument, x.head, id), 'PDF_REQUIRED');
      expect((await tx.documentApproval.count({ where: { documentId: id, decision: 'approved' } }))).toBe(0);

      // И в БД (триггер document_versions_require_pdf): утвердить версию без PDF нельзя и SQL-запросом.
      expect(await sqlError(tx, `UPDATE document_versions SET approved_at = now() WHERE id = '${must(d.workingVersionId)}'`)).toMatch(/только с итоговым PDF/);
    }));

  it('утверждённая до этапа 7 версия без PDF — «текст не зафиксирован», PDF задним числом не прикладывается', async () => {
    // Такие версии остались с этапов 6–7; сейчас их не создать — триггер. Состояние воспроизводится
    // под владельцем схемы с выключенными на время транзакции триггерами (транзакция откатывается).
    const owner = createPrisma(testDbConfig().ownerUrl);
    try {
      await inOwnerTx(owner, async (tx) => {
        const x = await fixture(tx);
        const old = await x.create('Старая политика');
        const od = await tx.document.findUniqueOrThrow({ where: { id: old } });
        const vid = must(od.workingVersionId);
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
        await tx.documentVersion.update({ where: { id: vid }, data: { stage: 3, approvedAt: new Date() } });
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin');
        await tx.document.update({ where: { id: old }, data: { approvedVersionId: vid, workingVersionId: null, reviewDue: new Date('2027-10-27T00:00:00Z') } });
        const card = await view(tx, x.owner, old);
        expect(card.current.textFrozen).toBe(false);
        expect(card.versions[0]?.textFrozen).toBe(false);
        // Задним числом PDF не прикладывается: утверждённая версия не меняется.
        await expectCode(svc.attachPdf(tx, await x.as(x.owner), old, { version: card.version, stage: 3, fileId: (await makeFileRow(tx, x.owner.id)).id }), 'DOC_APPROVED');
      });
    } finally {
      await owner.$disconnect();
    }
  });

  it('замена PDF во время согласования возвращает маршрут к началу; прежний PDF без ссылок помечается удалённым', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await act(tx, svc.submitDocument, x.owner, id);
      await act(tx, svc.approveDocument, x.head, id);
      const before = await tx.documentVersion.findFirstOrThrow({ where: { documentId: id } });
      expect(before.stage).toBe(2);
      const oldPdf = must(before.pdfFileId);

      // Согласующий PDF не меняет — только владелец или docs.manage.
      const legalPdf = await makeFileRow(tx, x.legal.id);
      await expectCode(svc.attachPdf(tx, await x.as(x.legal), id, { ...(await cur(tx, id)), fileId: legalPdf.id }), 'FORBIDDEN');

      const next = await makeFileRow(tx, x.owner.id, { name: 'Итог v2.pdf' });
      await svc.attachPdf(tx, await x.as(x.owner), id, { ...(await cur(tx, id)), fileId: next.id });
      const after = await tx.documentVersion.findFirstOrThrow({ where: { documentId: id } });
      expect(after.stage).toBe(0);
      expect(after.round).toBe(before.round + 1);
      expect(after.pdfFileId).toBe(next.id);
      expect((await tx.file.findUniqueOrThrow({ where: { id: oldPdf } })).deletedAt).not.toBeNull();
      const card = await view(tx, x.owner, id);
      expect(card.history[0]?.decision).toBe('returned');
      expect(card.history[0]?.comment).toMatch(/Заменён итоговый PDF/);
      // Новый круг: начальник ИБ согласует заново, уже новый файл.
      await svc.submitDocument(tx, await x.as(x.owner), id, await cur(tx, id));
      await act(tx, svc.approveDocument, x.head, id);
      const last = (await view(tx, x.owner, id)).history.find((h) => h.decision === 'approved');
      expect(last?.pdfSha256).toBe(next.sha256);
    }));
});
