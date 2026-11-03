import type { User } from '../../generated/prisma/client.js';
import { describe, expect, it } from 'vitest';
import { seedDocumentRoute, seedDocumentStageTasks, seedReviewTasksGrouped } from '../../../prisma/seed/documents.js';
import { runAction } from '../tasks/process.js';
import { closeTasks } from './tasks.js';
import { testDbConfig } from '../../../scripts/test-db.js';
import { createPrisma } from '../../lib/db.js';
import { MIME_BY_EXT } from '../../lib/file-type.js';
import { addDaysIso, todayIso } from '../../lib/today.js';
import { actorFor, expectCode, inTx, makeFileRow, makeUser, must, type Tx } from '../../test/db.js';
import type { Actor } from '../settings/common.js';
import * as parties from './parties.js';
import * as tr from './translations.js';
import { notifyPartyDeadlines } from './notify.js';
import { listNotifications } from '../notifications/service.js';
import { runDocumentReviews } from './review.js';
import * as svc from './service.js';
import { setIbHead } from '../users/service.js';
import { updatePortalParam } from '../settings/portal-params.js';
import { loadFullWorkCalendar } from '../calendar/service.js';
import { addWorkingDays, isoDate, parseIsoDate } from '../../lib/working-days.js';
import { addMonthsIso, FIXED_FILE, type DocAction } from './status.js';

const URL1 = 'https://office.example.local/products/files/doceditor.aspx?fileid=101';
const SIGNED_ON = '2026-10-20';

async function fixture(tx: Tx) {
  const type = await tx.catalogItem.create({ data: { catalogCode: 'document_types', value: `Политика ${Math.random().toString(36).slice(2)}` } });
  const admin = await makeUser(tx, ['super_admin'], { fullName: 'Администратор' });
  const chief = await makeUser(tx, ['ib_staff'], { fullName: 'Руководитель автора' });
  const owner = await makeUser(tx, ['ib_staff'], { fullName: 'Автор Документа', manager: { connect: { id: chief.id } } });
  const staff = await makeUser(tx, ['ib_staff'], { fullName: 'Сотрудник ИБ' });
  const head = await makeUser(tx, ['ib_staff', 'ib_head'], { fullName: 'Начальник ИБ', isIbHead: true });
  const legal = await makeUser(tx, ['doc_reader'], { fullName: 'Юрист' });
  const as = async (u: User): Promise<Actor> => actorFor(tx, u.id);
  /** Документ на «Драфте»; withFile — с файлом автора (без него не уйти дальше этапа 12, 1.4.0). */
  const create = async (title = 'Политика информационной безопасности', ownerId = owner.id, withFile = true) => {
    const id = await svc.createDocument(tx, await as(admin), { title, typeId: type.id, ownerId, onlyofficeUrl: URL1, edition: '1.0' });
    if (withFile) {
      const d = await tx.document.findUniqueOrThrow({ where: { id }, include: { workingVersion: true } });
      const f = await makeFileRow(tx, admin.id, { name: 'Политика.docx', mime: MIME_BY_EXT.docx });
      await svc.addDraftFiles(tx, await as(admin), id, { version: d.version, stage: d.workingVersion?.stage ?? 11, fileIds: [f.id] });
    }
    return id;
  };
  return { type, admin, chief, owner, staff, head, legal, as, create };
}
type Fx = Awaited<ReturnType<typeof fixture>>;

/** Версия документа и этап рабочей версии — то, что пользователь видит на экране. */
async function cur(tx: Tx, id: string) {
  const d = await tx.document.findUniqueOrThrow({ where: { id }, include: { workingVersion: true } });
  return { version: d.version, stage: d.workingVersion?.stage ?? -1 };
}

const docxFile = (tx: Tx, u: User) => makeFileRow(tx, u.id, { name: 'Версия.docx', mime: MIME_BY_EXT.docx });

/**
 * Действие маршрута; для 14 → 15 финальную версию загружает тот, кто действует (если fileId не задан).
 * 13 → 14 (1.4.0) — без загрузки: fileId — выбранный файл автора, по умолчанию последний.
 */
async function move(tx: Tx, u: User, id: string, action: DocAction, opts: { comment?: string; fileId?: string | null } = {}) {
  const upload = action !== 'approve' && FIXED_FILE[action];
  const fileId = opts.fileId === null ? undefined : opts.fileId ?? (upload ? (await docxFile(tx, u)).id : undefined);
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
    // 12 → 13 — только с файлом автора (1.4.0): у новой версии (пересмотр) его ещё нет — автор прикладывает.
    if (a === 'to_head') await ensureAuthorFile(tx, x, id);
    // 14 → 15 — когда ответственные лица согласовали (этап Г3): одно лицо, согласование отмечает начальник ИБ.
    if (a === 'ack_final') await approveParties(tx, x, id);
    await move(tx, u, id, a);
  }
}

/** Файл автора у рабочей версии (этапы 11–12): нет — автор прикладывает. */
async function ensureAuthorFile(tx: Tx, x: Fx, id: string) {
  const versionId = must((await tx.document.findUniqueOrThrow({ where: { id } })).workingVersionId);
  if (await tx.documentFile.count({ where: { versionId, kind: 'draft', removedAt: null } })) return;
  const f = await makeFileRow(tx, x.owner.id, { name: 'Политика.docx', mime: MIME_BY_EXT.docx });
  await svc.addDraftFiles(tx, await actorFor(tx, x.owner.id), id, { ...(await cur(tx, id)), fileIds: [f.id] });
}

/** Все ответственные лица рабочей версии согласовали (нет ни одного — добавить одно). */
async function approveParties(tx: Tx, x: Fx, id: string) {
  const versionId = must((await tx.document.findUniqueOrThrow({ where: { id } })).workingVersionId);
  if ((await tx.documentParty.count({ where: { versionId, removedAt: null } })) === 0) await addParty(tx, x.head, id);
  for (const p of await tx.documentParty.findMany({ where: { versionId, removedAt: null, approvedAt: null } })) {
    await parties.approveParty(tx, await actorFor(tx, x.head.id), id, p.id, await cur(tx, id));
  }
}

async function addParty(tx: Tx, u: User, id: string, extra: Partial<parties.PartyInput> = {}) {
  await parties.addParty(tx, await actorFor(tx, u.id), id, {
    ...(await cur(tx, id)), fullName: 'Петров П. П.', department: 'Юридическое управление', dueDate: '2026-11-10', ...extra,
  });
  return tx.documentParty.findFirstOrThrow({ where: { documentId: id }, orderBy: { addedAt: 'desc' } });
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

      // 13 → 14 (1.4.0): начальник ИБ ничего не загружает — согласует файл автора; чужой файл — не выбрать.
      await expectCode(move(tx, x.owner, id, 'approve'), 'FORBIDDEN');
      await expectCode(move(tx, x.head, id, 'approve', { fileId: (await makeFileRow(tx, x.head.id, { name: 'Своя.pdf' })).id }), 'BAD_FILE');
      expect((await view(tx, x.head, id)).waitingForMe).toBe(true);
      await move(tx, x.head, id, 'approve');

      // 14 → 15: начальник ИБ («Ознакомлен с финальной версией»), тоже с файлом.
      await expectCode(move(tx, x.owner, id, 'ack_final'), 'FORBIDDEN');
      await approveParties(tx, x, id);
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
      // Файл автора, согласованный начальником ИБ (одна строка, две отметки), и финальная версия.
      expect(d.files.map((f) => [f.file.name, f.marks])).toEqual([
        ['Политика.docx', ['Файл драфта', 'Версия при согласовании начальником ИБ']], ['Финал.pdf', ['Финальная версия']],
      ]);
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
      await svc.moveDocument(tx, await x.as(x.head), id, 'approve', seen);
      await expectCode(svc.moveDocument(tx, await x.as(x.head), id, 'approve', seen), 'VERSION_CONFLICT');
      await expectCode(svc.moveDocument(tx, await x.as(x.head), id, 'approve', { ...(await cur(tx, id)), stage: 13 }), 'STAGE_CHANGED');
      await expectCode(move(tx, x.head, id, 'to_signing'), 'WRONG_STAGE');
    }));

  it('этап «Начальник ИБ» — только по отметке: роль с docs.approve.head без отметки и супер-администратор не согласуют; за автора — docs.manage', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const adminHead = await makeUser(tx, ['super_admin', 'ib_head'], { fullName: 'Админ с правом начальника' });
      const roleOnly = await makeUser(tx, ['ib_staff', 'ib_head'], { fullName: 'Роль без отметки' });
      const id = await x.create();
      await move(tx, adminHead, id, 'to_review');
      await move(tx, adminHead, id, 'to_head');
      await expectCode(move(tx, adminHead, id, 'approve'), 'FORBIDDEN');
      await expectCode(move(tx, adminHead, id, 'return', { comment: 'замечание' }), 'FORBIDDEN');
      // Право docs.approve.head (роль «Начальник ИБ» в старой базе) без отметки ничего не даёт.
      await tx.rolePermission.createMany({ data: [{ roleId: (await tx.role.findUniqueOrThrow({ where: { code: 'ib_head' } })).id, permissionCode: 'docs.approve.head' }], skipDuplicates: true });
      await expectCode(move(tx, roleOnly, id, 'approve'), 'FORBIDDEN');
      expect((await view(tx, roleOnly, id)).waitingForMe).toBe(false);
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

describe('документы: автор — начальник ИБ (1.4.0: отметка одна)', () => {
  it('другого начальника ИБ не бывает — свой документ согласует сам, с отметкой «без независимого согласования» в истории и карточке', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      // Держатели старого права docs.approve.head не считаются «другим начальником ИБ».
      await makeUser(tx, ['ib_staff', 'ib_head'], { fullName: 'Роль без отметки' });
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
      // Согласование в каждом круге — своя отметка «версия при согласовании» (привязка head_approved круга).
      expect((await tx.documentFile.findMany({ where: { documentId: id, kind: 'head_approved' }, orderBy: { round: 'asc' } })).map((f) => f.round)).toEqual([1, 2]);
      await move(tx, x.head, id, 'return', { comment: 'Перевод не нужен' });
      expect((await tx.task.findFirstOrThrow({ where: { documentId: id, documentReason: 'returned', completedAt: null } })).id).not.toBe(task.id);
    }));
});

describe('документы: файлы драфта и комментарии', () => {
  it('файлы автора — на этапах 11 и 12; согласованный файл — одна строка с двумя отметками; зафиксированные не снимаются', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create('Политика', x.owner.id, false);
      const add = async (u: User, fileIds: string[]) => svc.addDraftFiles(tx, await x.as(u), id, { ...(await cur(tx, id)), fileIds });
      await expectCode(add(x.staff, [(await docxFile(tx, x.staff)).id]), 'FORBIDDEN');
      await expectCode(add(x.owner, [(await makeFileRow(tx, x.owner.id, { name: 'а.png', mime: MIME_BY_EXT.png })).id]), 'BAD_FILE_TYPE');
      // 11 → 12 — без файла можно; 12 → 13 — нет (1.4.0).
      await move(tx, x.owner, id, 'to_review');
      await expectCode(move(tx, x.owner, id, 'to_head'), 'AUTHOR_FILE_REQUIRED');
      expect((await view(tx, x.owner, id)).can.actions).toEqual([]);
      // На этапе 12 автор добавляет и заменяет файлы.
      await add(x.owner, [(await docxFile(tx, x.owner)).id, (await makeFileRow(tx, x.owner.id, { name: 'Политика.pdf' })).id]);
      let d = await view(tx, x.owner, id);
      expect(d.can.draftFiles).toBe(true);
      expect(d.files.map((f) => [f.kind, f.removable])).toEqual([['draft', true], ['draft', true]]);
      const first = must(d.files[0]);
      await svc.removeDraftFile(tx, await x.as(x.owner), id, first.id, await cur(tx, id));
      expect((await tx.file.findUniqueOrThrow({ where: { id: first.file.id } })).deletedAt).not.toBeNull();
      d = await view(tx, x.owner, id);
      expect(d.files.map((f) => f.file.name)).toEqual(['Политика.pdf']);

      await moveTo(tx, x, id, 14);
      d = await view(tx, x.owner, id);
      // Файл автора согласован начальником ИБ — одна строка с обеими отметками (уточнение 3).
      expect(d.files.map((f) => [f.file.name, f.marks, f.removable])).toEqual([['Политика.pdf', ['Файл драфта', 'Версия при согласовании начальником ИБ'], false]]);
      expect(d.history.find((h) => h.stage === 13)?.pdfSha256).toBe(must(d.files[0]).file.sha256);
      await expectCode(add(x.owner, [(await docxFile(tx, x.owner)).id]), 'FORBIDDEN');
      await expectCode(svc.removeDraftFile(tx, await x.as(x.owner), id, must(d.files[0]).id, await cur(tx, id)), 'FORBIDDEN');
      const fixed = await tx.documentFile.findFirstOrThrow({ where: { documentId: id, kind: 'head_approved' } });
      expect(await sqlError(tx, `UPDATE document_files SET removed_at = now() WHERE id = '${fixed.id}'`)).toMatch(/document_files_removed_check/);
      expect(await sqlError(tx, `DELETE FROM document_files WHERE id = '${fixed.id}'`)).toMatch(/permission denied/);
      expect(await sqlError(tx, `UPDATE files SET deleted_at = now() WHERE id = '${fixed.fileId}'`)).toMatch(/есть ссылки/);
    }));

  it('несколько файлов автора: по умолчанию согласуется последний; начальник ИБ может выбрать другой', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await moveTo(tx, x, id, 12);
      const later = await makeFileRow(tx, x.owner.id, { name: 'Политика v2.pdf' });
      await svc.addDraftFiles(tx, await x.as(x.owner), id, { ...(await cur(tx, id)), fileIds: [later.id] });
      await moveTo(tx, x, id, 13);
      const first = must((await view(tx, x.head, id)).files.find((f) => f.file.name === 'Политика.docx'));
      await move(tx, x.head, id, 'approve', { fileId: first.file.id });
      const fixed = await tx.documentFile.findFirstOrThrow({ where: { documentId: id, kind: 'head_approved' } });
      expect(fixed.fileId).toBe(first.file.id);

      const id2 = await x.create('Вторая');
      await moveTo(tx, x, id2, 12);
      const newest = await makeFileRow(tx, x.owner.id, { name: 'Последний.pdf' });
      await svc.addDraftFiles(tx, await x.as(x.owner), id2, { ...(await cur(tx, id2)), fileIds: [newest.id] });
      await moveTo(tx, x, id2, 14);
      expect((await tx.documentFile.findFirstOrThrow({ where: { documentId: id2, kind: 'head_approved' } })).fileId).toBe(newest.id);
    }));

  it('13 без файла автора → только возврат (с запиской по желанию) → на 11 автор прикладывает файл → снова 12 → 13 → согласование', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create('Старый маршрут', x.owner.id, false);
      // Документ из старого маршрута: был на «Начальнике ИБ» — перенесён на 13 без файла автора.
      const v = must((await tx.document.findUniqueOrThrow({ where: { id } })).workingVersionId);
      await tx.documentVersion.update({ where: { id: v }, data: { stage: 13 } });
      let d = await view(tx, x.head, id);
      expect(d.can.actions).toEqual(['return']);
      expect(d.blockedReason).toMatch(/Нет файла автора/);
      await expectCode(move(tx, x.head, id, 'approve'), 'NO_AUTHOR_FILE');
      await expectCode(move(tx, x.head, id, 'return'), 'EMPTY_COMMENT');
      const note = await makeFileRow(tx, x.head.id, { name: 'Замечания.pdf' });
      await move(tx, x.head, id, 'return', { comment: 'Приложите файл документа', fileId: note.id });
      d = await view(tx, x.owner, id);
      expect([d.stage, d.returned?.comment, d.returned?.file?.name]).toEqual([11, 'Приложите файл документа', 'Замечания.pdf']);
      expect((await tx.documentApproval.findFirstOrThrow({ where: { documentId: id, decision: 'returned' } })).fileId).toBe(note.id);
      // Записку видит автор (файл привязан к решению по документу).
      expect((await svc.versionVisible(tx, await svc.accessOf(tx, x.owner.id), v))).toBe(true);

      await move(tx, x.owner, id, 'to_review');
      await expectCode(move(tx, x.owner, id, 'to_head'), 'AUTHOR_FILE_REQUIRED');
      await svc.addDraftFiles(tx, await x.as(x.owner), id, { ...(await cur(tx, id)), fileIds: [(await docxFile(tx, x.owner)).id] });
      await move(tx, x.owner, id, 'to_head');
      expect((await view(tx, x.head, id)).can.actions).toEqual(['approve', 'return']);
      await move(tx, x.head, id, 'approve');
      expect((await cur(tx, id)).stage).toBe(14);
      // Возврат без файла — можно; файл записки — только pdf или docx.
      await expectCode(move(tx, x.head, id, 'return', { comment: 'x', fileId: (await makeFileRow(tx, x.head.id, { name: 'а.xlsx', mime: MIME_BY_EXT.xlsx })).id }), 'BAD_FILE_TYPE');
      await move(tx, x.head, id, 'return', { comment: 'Ещё раз' });
      expect((await view(tx, x.owner, id)).returned).toMatchObject({ comment: 'Ещё раз', file: null });
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

describe('документы: фильтры и порядок реестра', () => {
  it('тип, автор, срок пересмотра; по типам — сначала «Политика», по алфавиту; значения фильтров — из видимых документов', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      // «Политика» — стартовое значение seed; в чистой базе — создаём.
      const policy = await tx.catalogItem.findFirst({ where: { catalogCode: 'document_types', value: 'Политика' } })
        ?? await tx.catalogItem.create({ data: { catalogCode: 'document_types', value: 'Политика' } });
      const instr = await tx.catalogItem.create({ data: { catalogCode: 'document_types', value: 'Аа-инструкция' } });
      const today = todayIso();
      const make = async (title: string, typeId: string, ownerId = x.owner.id) => {
        const id = await x.create(title, ownerId);
        await tx.document.update({ where: { id }, data: { typeId } });
        return id;
      };
      const soon = await make('Абрикос: пересмотр скоро', instr.id);
      const late = await make('Банан: пересмотр прошёл', policy.id);
      const draft = await make('Вишня: черновик', policy.id, x.staff.id);
      // Пересмотр через 12 месяцев от подписания: ≈ сегодня + 65 дней и ≈ сегодня − 35 дней.
      await moveTo(tx, x, soon, 16);
      await sign(tx, x.owner, soon, { signedOn: addDaysIso(today, -300) });
      await moveTo(tx, x, late, 16);
      await sign(tx, x.owner, late, { signedOn: addDaysIso(today, -400) });

      const mine = [soon, late, draft];
      const q = async (extra: Partial<svc.DocListQuery>) =>
        (await svc.listDocuments(tx, await svc.accessOf(tx, x.head.id), { archived: false, limit: 500, ...extra })).items.map((d) => d.id).filter((id) => mine.includes(id));

      expect(await q({ typeId: policy.id, sort: 'title' })).toEqual([late, draft]);
      expect(await q({ ownerId: x.staff.id })).toEqual([draft]);
      expect(await q({ due: 'overdue' })).toEqual([late]);
      expect(await q({ due: 'd90' })).toEqual([soon]);
      expect(await q({ due: 'd30' })).toEqual([]);
      expect(await q({ dueTo: today, sort: 'title' })).toEqual([late]);
      // Черновик без даты пересмотра в фильтр по сроку не попадает.
      expect(await q({ due: 'd365', sort: 'title' })).toEqual([soon]);

      // По типам: «Политика» первой, хотя «Аа-инструкция» раньше по алфавиту; внутри типа — по названию.
      expect(await q({ sort: 'type' })).toEqual([late, draft, soon]);
      expect(await q({ sort: 'title' })).toEqual([soon, late, draft]);

      // Значения фильтров не сужаются выбранным фильтром; без ib.work — только видимые документы.
      const page = await svc.listDocuments(tx, await svc.accessOf(tx, x.head.id), { archived: false, limit: 500, typeId: instr.id });
      expect(page.facets.types.map((t) => t.value).slice(0, 1)).toEqual(['Политика']);
      expect(page.facets.types.map((t) => t.id)).toEqual(expect.arrayContaining([policy.id, instr.id]));
      expect(page.facets.owners.map((o) => o.id)).toEqual(expect.arrayContaining([x.owner.id, x.staff.id]));
      const reader = await svc.listDocuments(tx, await svc.accessOf(tx, x.legal.id), { archived: false, limit: 500 });
      expect(reader.facets.owners.some((o) => o.id === x.staff.id)).toBe(false);
    }));
});

describe('документы: задачи этапов маршрута (1.6.3; общая задача — 1.6.4)', () => {
  const stageTasks = (tx: Tx, id: string, open = true) => tx.task.findMany({
    where: { documentId: id, documentReason: 'stage', ...(open ? { completedAt: null, archivedAt: null } : {}) },
    include: { assignee: { select: { fullName: true } }, candidates: { select: { user: { select: { id: true, fullName: true } } }, orderBy: { user: { fullName: 'asc' } } } },
    orderBy: { number: 'asc' },
  });
  /** Личная — ФИО; без ответственного — «— метка»; общая — «[метка] ФИО из списка». */
  const who = async (tx: Tx, id: string) => (await stageTasks(tx, id)).map((t) => (t.candidates.length
    ? `[${t.recipientLabel}] ${t.candidates.map((c) => c.user.fullName).join(', ')}${t.assignee ? ` → ${t.assignee.fullName}` : ''}`
    : t.assignee?.fullName ?? `— ${t.recipientLabel}`)).sort();
  const workdays = async (tx: Tx, n: number) => isoDate(addWorkingDays(parseIsoDate(todayIso()), n, await loadFullWorkCalendar(tx)));
  const dueOf = (t: { dueDate: Date | null }) => t.dueDate?.toISOString().slice(0, 10) ?? null;

  it('каждый этап — задача тому, кто действует; смена этапа закрывает прежние; текст — документ, тип, этап, что требуется', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create('Политика паролей');
      const num = (await tx.document.findUniqueOrThrow({ where: { id } })).number;

      // 11: документ завёл администратор за владельца — владельцу «Подготовить драфт», 5 рабочих дней.
      const [t11] = await stageTasks(tx, id);
      expect(t11).toMatchObject({ assigneeId: x.owner.id, title: `Подготовить драфт: документ #${num} «Политика паролей»`, source: 'document' });
      expect(dueOf(must(t11))).toBe(await workdays(tx, 5));
      expect(must(t11).description).toContain(`Тип: ${x.type.value}`);
      expect(must(t11).description).toContain('Этап: Драфт (1 из 6), версия 1');
      // Уведомления «назначена задача» нет — о событии и так сообщает «ждёт вас».
      expect(await tx.notification.count({ where: { taskId: must(t11).id } })).toBe(0);

      // 12: автору — «Учесть комментарии»; одна общая «Проверить» без исполнителя — список: сотрудники ИБ кроме автора (роль не выбрана).
      await move(tx, x.owner, id, 'to_review');
      expect((await tx.task.findUniqueOrThrow({ where: { id: must(t11).id } })).completedAt).not.toBeNull();
      const t12 = await stageTasks(tx, id);
      expect(t12).toHaveLength(2);
      expect(t12.find((t) => t.assigneeId === x.owner.id)?.title).toMatch(/^Учесть комментарии/);
      const review = must(t12.find((t) => t.title.startsWith('Проверить')));
      expect(review).toMatchObject({ assigneeId: null, recipientLabel: svc.REVIEW_GROUP_LABEL });
      const list = review.candidates.map((c) => c.user.id);
      expect(list).toEqual(expect.arrayContaining([x.staff.id, x.head.id, x.chief.id, x.admin.id]));
      expect(list).not.toContain(x.owner.id);
      expect(list).not.toContain(x.legal.id);
      // Список узнаёт о задаче уведомлением (проверяющие — не «Сейчас у», «ждёт вас» им не приходит).
      expect(await tx.notification.count({ where: { taskId: review.id, userId: { in: [x.staff.id, x.head.id] } } })).toBe(2);
      for (const t of t12) expect(dueOf(t)).toBe(await workdays(tx, 3));
      // Берёт сотрудник из списка; дальше — обычный процесс задач.
      const fresh = await tx.task.findUniqueOrThrow({ where: { id: review.id } });
      await runAction(tx, { ...(await x.as(x.staff)), perms: new Set(['ib.work']) }, review.id, 'take', { version: fresh.version });
      expect(await who(tx, id)).toContain(`[${svc.REVIEW_GROUP_LABEL}] ${review.candidates.map((c) => c.user.fullName).join(', ')} → Сотрудник ИБ`);

      // 13: начальнику ИБ «Согласовать», задачи этапа 12 закрыты с комментарием.
      await move(tx, x.owner, id, 'to_head');
      expect(await who(tx, id)).toEqual(['Начальник ИБ']);
      const [t13] = await stageTasks(tx, id);
      expect(must(t13).description).toContain('Этап: Согласование начальника ИБ (3 из 6), версия 1');
      expect(must(t13).description).toContain('Что требуется: согласовать версию 1 или вернуть документ на доработку с комментарием.');
      const closedComment = await tx.taskComment.findFirst({ where: { taskId: review.id }, orderBy: { createdAt: 'desc' } });
      expect(closedComment?.body).toMatch(/Документ на этапе «Согласование начальника ИБ»/);
      // Взятая общая задача — выполненная работа взявшего: «Выполнено», не в архиве.
      expect(await tx.task.findUniqueOrThrow({ where: { id: review.id } })).toMatchObject({ assigneeId: x.staff.id, archivedAt: null });

      // 14: срок — ближайший срок несогласовавшего лица; меняется вместе со сроком лица.
      await move(tx, x.head, id, 'approve');
      const [first14] = await stageTasks(tx, id);
      expect(must(first14).title).toMatch(/^Согласовать с ответственными лицами/);
      expect(dueOf(must(first14))).toBeNull();
      const t14id = must(first14).id;
      const p = await addParty(tx, x.head, id, { dueDate: '2026-12-10' });
      await addParty(tx, x.head, id, { fullName: 'Иванов И. И.', dueDate: '2026-12-20' });
      expect(dueOf(await tx.task.findUniqueOrThrow({ where: { id: t14id } }))).toBe('2026-12-10');
      await parties.updateParty(tx, await x.as(x.head), id, p.id, { ...(await cur(tx, id)), dueDate: '2026-12-15', comment: 'Попросили отсрочку' });
      expect(dueOf(await tx.task.findUniqueOrThrow({ where: { id: t14id } }))).toBe('2026-12-15');
      expect((await tx.taskComment.findFirst({ where: { taskId: t14id }, orderBy: { createdAt: 'desc' } }))?.body).toBe('Срок изменён: 10.12.2026 → 15.12.2026 (сроки ответственных лиц)');
      await parties.approveParty(tx, await x.as(x.head), id, p.id, await cur(tx, id));
      expect(dueOf(await tx.task.findUniqueOrThrow({ where: { id: t14id } }))).toBe('2026-12-20');

      // 15 без переводов — одна общая «Отправить на подписание»: начальник ИБ и старший над автором; 16 — автору; подписание закрывает всё.
      await moveTo(tx, x, id, 15);
      expect(await who(tx, id)).toEqual([`[${svc.HOLDERS_GROUP_LABEL}] Начальник ИБ, Руководитель автора`]);
      expect((await stageTasks(tx, id))[0]?.title).toMatch(/^Отправить на подписание/);
      await moveTo(tx, x, id, 16);
      expect(await who(tx, id)).toEqual(['Автор Документа']);
      await sign(tx, x.owner, id);
      expect(await stageTasks(tx, id)).toEqual([]);
      // Повторов одного состояния нет: на каждого — по одной задаче каждого этапа.
      const all = await stageTasks(tx, id, false);
      expect(new Set(all.map((t) => `${t.documentState}|${t.assigneeId}`)).size).toBe(all.length);
    }));

  it('возврат — задачи этапа закрыты, у автора «Доработать»; перевод — автору со сроком языка; срок по умолчанию — из параметров портала', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      await updatePortalParam(tx, await x.as(x.admin), 'documents.stageDays', { value: { '11': 5, '12': 3, '13': 7, '15': 3, '16': 5 }, version: 0 });
      const id = await x.create();
      await moveTo(tx, x, id, 13);
      expect(dueOf(must((await stageTasks(tx, id))[0]))).toBe(await workdays(tx, 7));
      await move(tx, x.head, id, 'return', { comment: 'Нет раздела 4' });
      expect(await stageTasks(tx, id)).toEqual([]);
      expect(await tx.task.count({ where: { documentId: id, documentReason: 'returned', completedAt: null } })).toBe(1);

      await tr.addTranslation(tx, await x.as(x.owner), id, { ...(await cur(tx, id)), language: 'Английский', dueDate: '2026-12-05' });
      await moveTo(tx, x, id, 15);
      const [tt] = await stageTasks(tx, id);
      expect(tt).toMatchObject({ assigneeId: x.owner.id, title: expect.stringMatching(/^Приложить переводы/) });
      expect(must(tt).description).toContain('приложить файлы перевода: Английский.');
      expect(dueOf(must(tt))).toBe('2026-12-05');
      const t = await tx.documentTranslation.findFirstOrThrow({ where: { documentId: id } });
      await tr.addTranslationFiles(tx, await x.as(x.owner), id, t.id, { ...(await cur(tx, id)), fileIds: [(await makeFileRow(tx, x.owner.id, { name: 'en.docx', mime: MIME_BY_EXT.docx })).id] });
      expect(await who(tx, id)).toEqual([`[${svc.HOLDERS_GROUP_LABEL}] Начальник ИБ, Руководитель автора`]);
    }));

  it('seed: документы в работе получают задачи этапа; повторный запуск ничего не меняет; запрос отката — задачи становятся «доработкой»', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await moveTo(tx, x, id, 13);
      // Как после отката на 1.6.2 (RELEASE.md) — задачи этапов переведены в «доработку», CHECK это принимает.
      await tx.$executeRaw`UPDATE tasks SET document_reason = 'returned', document_state = NULL WHERE document_reason = 'stage' AND document_id = ${id}::uuid`;
      expect(await stageTasks(tx, id)).toEqual([]);
      await seedDocumentStageTasks(tx);
      expect(await who(tx, id)).toEqual(['Начальник ИБ']);
      const n = await tx.task.count({ where: { documentReason: 'stage' } });
      await seedDocumentStageTasks(tx);
      expect(await tx.task.count({ where: { documentReason: 'stage' } })).toBe(n);
    }));

  it('роль проверки из параметров портала: в списке только её участники; взять себе — только из списка; список меняется за ролью', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const role = await tx.role.create({ data: { code: `senior_${Math.random().toString(36).slice(2, 8)}`, name: `Стар. сотрудник ИБ ${Math.random().toString(36).slice(2, 6)}` } });
      await tx.userRole.create({ data: { userId: x.chief.id, roleId: role.id } });
      await tx.userRole.create({ data: { userId: x.owner.id, roleId: role.id } });
      await updatePortalParam(tx, await x.as(x.admin), 'documents.reviewRole', { value: { roleId: role.id }, version: 0 });
      await expectCode(updatePortalParam(tx, await x.as(x.admin), 'documents.reviewRole', { value: { roleId: '00000000-0000-4000-8000-000000000000' }, version: 1 }), 'BAD_PARAM');
      const id = await x.create();
      await moveTo(tx, x, id, 12);
      // Владелец в роли, но свой документ не проверяет.
      expect(await who(tx, id)).toEqual([`[${svc.REVIEW_GROUP_LABEL}] Руководитель автора`, 'Автор Документа']);
      const review = must((await stageTasks(tx, id)).find((t) => t.candidates.length));
      const as = async (u: User) => ({ ...(await x.as(u)), perms: new Set(['ib.work']) });
      const version = async () => (await tx.task.findUniqueOrThrow({ where: { id: review.id } })).version;
      await expectCode(runAction(tx, await as(x.staff), review.id, 'take', { version: await version() }), 'NOT_CANDIDATE');

      // В роль добавили сотрудника — список пополняется при следующем действии с документом.
      await tx.userRole.create({ data: { userId: x.staff.id, roleId: role.id } });
      await svc.syncStageTasks(tx, id);
      expect(await who(tx, id)).toContain(`[${svc.REVIEW_GROUP_LABEL}] Руководитель автора, Сотрудник ИБ`);
      await runAction(tx, await as(x.staff), review.id, 'take', { version: await version() });
      expect((await tx.task.findUniqueOrThrow({ where: { id: review.id } })).assigneeId).toBe(x.staff.id);
    }));

  it('seed 1.6.4: задачи «Проверить» по одной на сотрудника (1.6.3) — в архив; документ получает одну общую', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await moveTo(tx, x, id, 12);
      // Как в 1.6.3: общей задачи не было — была личная каждому; одна уже закрыта системой.
      const v = await tx.document.findUniqueOrThrow({ where: { id }, include: { workingVersion: true } });
      const state = `${must(v.workingVersion).id}:1:12`;
      // Общей задачи в 1.6.3 не было: здесь её закрывает система (как смена состояния) — seed создаёт её заново.
      await closeTasks(tx, (await stageTasks(tx, id)).filter((t) => t.candidates.length), 'как в 1.6.3');
      const old = await stageTasks(tx, id);
      const mk = async (u: User, done = false) => (await tx.task.create({ data: {
        title: 'Проверить: документ', statusId: must(old[0]).statusId, priorityId: must(old[0]).priorityId, categoryId: must(old[0]).categoryId,
        assigneeId: u.id, source: 'document', documentId: id, documentReason: 'stage', documentState: state, ...(done ? { completedAt: new Date() } : {}),
      } })).id;
      const a = await mk(x.staff);
      const b = await mk(x.head, true);
      await tx.seedMarker.deleteMany({ where: { key: 'docs.stage_tasks.group.v1' } });
      await seedReviewTasksGrouped(tx);
      await seedDocumentStageTasks(tx);
      for (const t of [a, b]) expect((await tx.task.findUniqueOrThrow({ where: { id: t } })).archivedAt).not.toBeNull();
      // Задачу владельца («Учесть комментарии») уборка не трогает.
      expect(await who(tx, id)).toEqual(expect.arrayContaining(['Автор Документа', expect.stringMatching(new RegExp(`^\\[${svc.REVIEW_GROUP_LABEL}\\]`))]));
      expect((await stageTasks(tx, id)).filter((t) => t.candidates.length)).toHaveLength(1);
    }));

  it('отметку начальника ИБ передали или сняли — задача переходит или остаётся без ответственного; закрытую вручную не возвращаем', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await moveTo(tx, x, id, 13);
      const head = await tx.user.findUniqueOrThrow({ where: { id: x.head.id } });
      const [was] = await stageTasks(tx, id);
      await setIbHead(tx, await x.as(x.admin), x.staff.id, { version: (await tx.user.findUniqueOrThrow({ where: { id: x.staff.id } })).version, value: true, transfer: true });
      expect(await who(tx, id)).toEqual(['Сотрудник ИБ']);
      // Задача прежнего начальника ИБ — не его выполненная работа: закрыта и в архиве.
      expect((await tx.task.findUniqueOrThrow({ where: { id: must(was).id } })).archivedAt).not.toBeNull();
      await setIbHead(tx, await x.as(x.admin), x.staff.id, { version: (await tx.user.findUniqueOrThrow({ where: { id: x.staff.id } })).version, value: false });
      expect(await who(tx, id)).toEqual([`— ${svc.NO_HEAD_LABEL}`]);
      // Вернули отметку прежнему — задача снова у него: системное закрытие повтор не запрещает.
      await setIbHead(tx, await x.as(x.admin), x.head.id, { version: (await tx.user.findUniqueOrThrow({ where: { id: head.id } })).version, value: true });
      expect(await who(tx, id)).toEqual(['Начальник ИБ']);

      // Начальник ИБ закрыл задачу на доске сам — по тому же этапу она не появляется снова.
      const [t] = await stageTasks(tx, id);
      await tx.task.update({ where: { id: must(t).id }, data: { completedAt: new Date() } });
      await tx.taskTransition.create({ data: { taskId: must(t).id, fromStatusId: must(t).statusId, toStatusId: must(t).statusId, actorId: x.head.id, kind: 'override' } });
      await svc.syncStageTasks(tx, id);
      expect(await stageTasks(tx, id)).toEqual([]);
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

describe('документы: этап 14 — ответственные лица (Г3)', () => {
  it('14 → 15 — только когда все лица (хотя бы одно) согласовали; лиц ведут автор и начальник ИБ', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      // Лиц можно указать заранее, с драфта; сотрудник ИБ — нет.
      await expectCode(addParty(tx, x.staff, id), 'FORBIDDEN');
      const p1 = await addParty(tx, x.owner, id, { fullName: 'Иванов И. И.', department: 'Главный юрист' });
      // Строка до 1.4.0: e-mail и пользователь портала — показываются текстом (новые строки их не получают).
      await tx.documentParty.update({ where: { id: p1.id }, data: { email: 'ivanov@example.tj', userId: x.legal.id } });
      await moveTo(tx, x, id, 14);
      // moveTo остановился на 14: p1 ещё не согласовал.
      await expectCode(move(tx, x.head, id, 'ack_final'), 'PARTIES_PENDING');
      let d = await view(tx, x.head, id);
      expect(d.can).toMatchObject({ actions: ['return'], parties: true, approveParties: true });
      expect(d.blockedReason).toMatch(/Не все ответственные лица согласовали: осталось 1/);
      expect(d.parties.map((p) => [p.fullName, p.department, p.email, p.user?.fullName, p.approvedAt])).toEqual([['Иванов И. И.', 'Главный юрист', 'ivanov@example.tj', 'Юрист', null]]);

      const response = await makeFileRow(tx, x.head.id, { name: 'Письмо.pdf' });
      await parties.approveParty(tx, await x.as(x.head), id, p1.id, { ...(await cur(tx, id)), comment: 'Ответ письмом', fileIds: [response.id] });
      await expectCode(parties.approveParty(tx, await x.as(x.head), id, p1.id, await cur(tx, id)), 'PARTY_APPROVED');
      await expectCode(parties.removeParty(tx, await x.as(x.owner), id, p1.id, await cur(tx, id)), 'PARTY_APPROVED');
      d = await view(tx, x.head, id);
      expect(d.parties[0]).toMatchObject({ approvedBy: 'Начальник ИБ', approveComment: 'Ответ письмом' });
      expect(d.parties[0]?.files.map((f) => f.file.name)).toEqual(['Письмо.pdf']);
      expect(d.files.some((f) => f.file.name === 'Письмо.pdf')).toBe(false);
      expect(d.can.actions).toEqual(['ack_final', 'return']);
      expect(d.waitingForMe).toBe(true);
      await move(tx, x.head, id, 'ack_final');
      expect((await cur(tx, id)).stage).toBe(15);
      // После этапа 14 список лиц не меняется.
      await expectCode(addParty(tx, x.owner, id), 'WRONG_STAGE');
    }));

  it('без лиц 14 → 15 нельзя; согласование отмечается только на этапе 14; снять можно несогласовавшее', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await moveTo(tx, x, id, 13);
      const p = await addParty(tx, x.head, id);
      await expectCode(parties.approveParty(tx, await x.as(x.head), id, p.id, await cur(tx, id)), 'WRONG_STAGE');
      await parties.removeParty(tx, await x.as(x.owner), id, p.id, await cur(tx, id));
      await move(tx, x.head, id, 'approve');
      await expectCode(move(tx, x.head, id, 'ack_final'), 'NO_PARTIES');
      expect((await view(tx, x.head, id)).parties).toEqual([]);
      expect(await sqlError(tx, `DELETE FROM document_parties WHERE id = '${p.id}'`)).toMatch(/permission denied/);
    }));

  it('срок меняется только с комментарием; история сроков только пополняется; в реестре — ближайший срок и просрочка', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      const p = await addParty(tx, x.owner, id, { dueDate: '2020-01-10' });
      const patch = async (body: parties.PartyPatch) => parties.updateParty(tx, await x.as(x.owner), id, p.id, { ...(await cur(tx, id)), ...body });
      await expectCode(patch({ dueDate: '2020-01-20' }), 'EMPTY_COMMENT');
      await expectCode(patch({ dueDate: '2020-02-31', comment: 'x' }), 'BAD_DATE');
      // E-mail и пользователь портала (1.4.0) не вводятся: лишние поля не меняют строку.
      await patch({ email: 'не почта', userId: x.legal.id } as parties.PartyPatch);
      expect(await tx.documentParty.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ email: '', userId: null });
      await patch({ dueDate: '2020-01-20', comment: 'Попросили отсрочку' });
      const item = (await list(tx, x.owner)).find((d) => d.id === id);
      expect(item).toMatchObject({ partiesDue: '2020-01-20', partiesOverdue: true });
      const d = await view(tx, x.owner, id);
      expect(d.parties[0]).toMatchObject({ dueDate: '2020-01-20', overdue: true });
      expect(d.parties[0]?.deadlines).toEqual([expect.objectContaining({ from: '2020-01-10', to: '2020-01-20', comment: 'Попросили отсрочку', actor: 'Автор Документа' })]);
      expect(await sqlError(tx, `UPDATE document_deadline_changes SET comment = 'x' WHERE party_id = '${p.id}'`)).toMatch(/permission denied/);
      expect(await sqlError(tx, `DELETE FROM document_deadline_changes WHERE party_id = '${p.id}'`)).toMatch(/permission denied/);
      // Без ib.work лиц не видно.
      expect((await list(tx, x.legal)).find((i) => i.id === id)).toBeUndefined();
    }));
});

describe('документы: блокеры (Г3)', () => {
  it('открывают и снимают автор, старший и начальник ИБ; открытый блокер останавливает шаги вперёд и подписание', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      const open = async (u: User, text: string) => parties.addBlocker(tx, await x.as(u), id, { ...(await cur(tx, id)), text });
      const resolve = async (u: User, bid: string, comment: string) => parties.resolveBlocker(tx, await x.as(u), id, bid, { ...(await cur(tx, id)), comment });
      await expectCode(open(x.staff, 'чужой'), 'FORBIDDEN');
      await expectCode(open(x.owner, '  '), 'EMPTY_COMMENT');
      await open(x.chief, 'Нет согласования с ДИКТ');
      expect((await list(tx, x.owner)).find((d) => d.id === id)?.openBlockers).toBe(1);
      await expectCode(move(tx, x.owner, id, 'to_review'), 'BLOCKERS_OPEN');
      let d = await view(tx, x.owner, id);
      expect(d.can.actions).toEqual([]);
      expect(d.blockedReason).toMatch(/Открытых блокеров: 1/);
      const b = must(d.blockers[0]);
      await expectCode(resolve(x.owner, b.id, ''), 'EMPTY_COMMENT');
      await resolve(x.head, b.id, 'ДИКТ согласовал письмом');
      await expectCode(resolve(x.head, b.id, 'ещё раз'), 'BLOCKER_RESOLVED');
      d = await view(tx, x.owner, id);
      expect(d.blockers[0]).toMatchObject({ openedBy: 'Руководитель автора', resolvedBy: 'Начальник ИБ', resolveComment: 'ДИКТ согласовал письмом' });
      expect(await sqlError(tx, `UPDATE document_blockers SET text = 'подмена' WHERE id = '${b.id}'`)).toMatch(/только снимается один раз/);
      expect(await sqlError(tx, `DELETE FROM document_blockers WHERE id = '${b.id}'`)).toMatch(/permission denied/);

      // На подписании блокер тоже останавливает.
      await moveTo(tx, x, id, 16);
      await open(x.head, 'Ждём оригинал с подписью');
      await expectCode(sign(tx, x.owner, id), 'BLOCKERS_OPEN');
      expect((await view(tx, x.owner, id)).can.sign).toBe(false);
    }));
});

describe('документы: этап 15 — перевод (Г4)', () => {
  it('строка = язык + переводчик текстом + срок + файл; 15 → 16 — когда у каждого языка есть файл; файл — автор или docs.manage', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      const add = async (u: User, language: string, translatorName?: string, dueDate = '2026-11-20') =>
        tr.addTranslation(tx, await x.as(u), id, { ...(await cur(tx, id)), language, translatorName, dueDate });
      await expectCode(add(x.staff, 'Таджикский', 'Калинов К.'), 'FORBIDDEN');
      await add(x.owner, 'Таджикский', '  Калинов К. К.  ');
      await expectCode(add(x.owner, ' таджикский '), 'DUPLICATE');
      await add(x.chief, 'Английский'); // переводчик не указан — можно
      await expectCode(add(x.owner, 'Узбекский', 'И'.repeat(201)), 'TOO_LONG');
      // translator_id новых строк — тот, кто добавил (откат на 1.3.0 не ломается), имя — текстом.
      const rows = await tx.documentTranslation.findMany({ where: { documentId: id }, orderBy: { addedAt: 'asc' } });
      expect(rows.map((r) => [r.language, r.translatorName, r.translatorId])).toEqual([['Таджикский', 'Калинов К. К.', x.owner.id], ['Английский', '', x.chief.id]]);

      await moveTo(tx, x, id, 15);
      await expectCode(move(tx, x.head, id, 'to_signing'), 'TRANSLATIONS_MISSING');
      let d = await view(tx, x.head, id);
      expect(d.blockedReason).toMatch(/осталось 2/);
      expect(d.translations.map((t) => [t.language, t.translatorName])).toEqual([['Таджикский', 'Калинов К. К.'], ['Английский', '']]);
      const [tj, en] = [must(d.translations[0]), must(d.translations[1])];

      const file = async (u: User, name = 'Перевод.docx') => (await makeFileRow(tx, u.id, { name, mime: MIME_BY_EXT.docx })).id;
      const upload = async (u: User, tid: string, fid: string) => tr.addTranslationFiles(tx, await x.as(u), id, tid, { ...(await cur(tx, id)), fileIds: [fid] });
      // Файл — автор (владелец или docs.manage); начальник ИБ, старший над автором и сотрудник — нет.
      for (const u of [x.head, x.chief, x.staff]) await expectCode(upload(u, tj.id, await file(u)), 'FORBIDDEN');
      expect(d.translations.every((t) => !t.canUpload)).toBe(true);
      expect((await view(tx, x.owner, id)).translations.every((t) => t.canUpload)).toBe(true);
      await expectCode(upload(x.owner, tj.id, (await makeFileRow(tx, x.owner.id, { name: 'а.png', mime: MIME_BY_EXT.png })).id), 'BAD_FILE_TYPE');
      await upload(x.owner, tj.id, await file(x.owner, 'Таджикский.docx'));
      await expectCode(move(tx, x.head, id, 'to_signing'), 'TRANSLATIONS_MISSING');
      await upload(x.admin, en.id, await file(x.admin, 'English.docx')); // docs.manage — за автора
      d = await view(tx, x.head, id);
      expect(d.translations.map((t) => [t.language, t.done, t.files.map((f) => f.file.name)])).toEqual([
        ['Таджикский', true, ['Таджикский.docx']], ['Английский', true, ['English.docx']],
      ]);
      expect(d.files.some((f) => f.file.name === 'English.docx')).toBe(false);
      await move(tx, x.chief, id, 'to_signing');
      expect((await cur(tx, id)).stage).toBe(16);
      // После этапа 15 файлы перевода не меняются, строки не снимаются.
      await expectCode(upload(x.owner, en.id, await file(x.owner)), 'WRONG_STAGE');
      await expectCode(tr.removeTranslation(tx, await x.as(x.owner), id, en.id, await cur(tx, id)), 'WRONG_STAGE');
    }));

  it('строку снимают до прохождения этапа 15 — и с файлом; снятая не участвует в проверке 15 → 16; срок — с комментарием', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await tr.addTranslation(tx, await x.as(x.owner), id, { ...(await cur(tx, id)), language: 'Таджикский', translatorName: 'Калинов К.', dueDate: '2020-01-10' });
      const t = must((await view(tx, x.owner, id)).translations[0]);
      expect(t.overdue).toBe(true);
      const patch = async (body: { dueDate?: string; comment?: string; translatorName?: string }) =>
        tr.updateTranslation(tx, await x.as(x.owner), id, t.id, { ...(await cur(tx, id)), ...body });
      await expectCode(patch({ dueDate: '2020-01-20' }), 'EMPTY_COMMENT');
      await patch({ dueDate: '2020-01-20', comment: 'Переводчик в отпуске', translatorName: 'Ромашова Р.' });
      const after = must((await view(tx, x.owner, id)).translations[0]);
      expect(after).toMatchObject({ dueDate: '2020-01-20', translatorName: 'Ромашова Р.' });
      expect(after.deadlines).toEqual([expect.objectContaining({ from: '2020-01-10', to: '2020-01-20', comment: 'Переводчик в отпуске' })]);

      // На этапе 15 с файлом — снять можно; снятая строка и её файл в проверке 15 → 16 не участвуют.
      await moveTo(tx, x, id, 15);
      await tr.addTranslationFiles(tx, await x.as(x.owner), id, t.id, { ...(await cur(tx, id)), fileIds: [(await makeFileRow(tx, x.owner.id, { name: 'tj.docx', mime: MIME_BY_EXT.docx })).id] });
      await tr.addTranslation(tx, await x.as(x.owner), id, { ...(await cur(tx, id)), language: 'Английский', dueDate: '2026-11-20' });
      await expectCode(move(tx, x.head, id, 'to_signing'), 'TRANSLATIONS_MISSING');
      const en = must((await view(tx, x.owner, id)).translations.find((r) => r.language === 'Английский'));
      await tr.removeTranslation(tx, await x.as(x.owner), id, t.id, await cur(tx, id));
      await tr.removeTranslation(tx, await x.as(x.owner), id, en.id, await cur(tx, id));
      expect((await view(tx, x.owner, id)).translations).toEqual([]);
      expect(await tx.documentFile.count({ where: { translationId: t.id } })).toBe(1); // файл не удалён, строка — «снята»
      await move(tx, x.head, id, 'to_signing');
      expect(await sqlError(tx, `DELETE FROM document_translations WHERE id = '${t.id}'`)).toMatch(/permission denied/);
    }));

  it('переводчик не пользователь портала: «Сейчас у» на 15 — автор; документ не виден и не ждёт пользователя, указанного переводчиком до 1.4.0', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await tr.addTranslation(tx, await x.as(x.owner), id, { ...(await cur(tx, id)), language: 'Таджикский', translatorName: 'Юрист', dueDate: '2026-11-20' });
      // Строка до 1.4.0: translator_id — пользователь портала (читатель документов).
      await tx.documentTranslation.updateMany({ where: { documentId: id }, data: { translatorId: x.legal.id } });
      await moveTo(tx, x, id, 15);
      const item = must((await list(tx, x.staff)).find((d) => d.id === id));
      expect(item.holders).toEqual({ people: [{ id: x.owner.id, fullName: 'Автор Документа' }], missingHead: false });
      expect((await list(tx, x.owner)).find((d) => d.id === id)?.waitingForMe).toBe(true);
      expect((await list(tx, x.legal)).find((d) => d.id === id)).toBeUndefined();
      expect((await svc.documentSummary(tx, await svc.accessOf(tx, x.legal.id))).waitingForMe).toBe(0);
      expect(await tx.notification.count({ where: { userId: x.legal.id, documentId: id } })).toBe(0);
      // Автору — «ждёт файлов перевода» (14 → 15 перевёл начальник ИБ).
      expect(await tx.notification.count({ where: { userId: x.owner.id, documentId: id, title: { contains: 'ждёт файлов перевода' } } })).toBe(1);
    }));
});

describe('документы: уведомления (Г5)', () => {
  /** Уведомления пользователя по документу: вид и заголовок. */
  // Уведомление списку общей задачи «Проверить документ» (1.6.4) проверяет тест задач этапов; здесь — только «ждёт вас» и события.
  const inbox = async (tx: Tx, u: User, id: string) =>
    (await tx.notification.findMany({ where: { userId: u.id, documentId: id, OR: [{ dedupeKey: null }, { NOT: { dedupeKey: { startsWith: 'doc_review:' } } }] }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }))
      .map((n) => `${n.kind}: ${n.title}`);

  it('«ждёт вас» по этапам, возврат и комментарий — автору; о своих действиях — нет; ссылка ведёт на документ', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create('Политика ИБ');
      await tr.addTranslation(tx, await x.as(x.owner), id, { ...(await cur(tx, id)), language: 'Таджикский', translatorName: 'Юрист', dueDate: '2026-11-20' });
      await moveTo(tx, x, id, 12);
      await svc.addDocumentComment(tx, await x.as(x.staff), id, { body: 'Нет срока в п. 4' });
      await svc.addDocumentComment(tx, await x.as(x.owner), id, { body: 'Добавил' });
      await moveTo(tx, x, id, 13);
      await move(tx, x.head, id, 'return', { comment: 'Уточнить раздел 3' });
      expect(await inbox(tx, x.owner, id)).toEqual([
        expect.stringMatching(/^doc_commented: Комментарий к документу #\d+ «Политика ИБ»$/),
        expect.stringMatching(/^doc_returned: Документ #\d+ «Политика ИБ» вернули на доработку$/),
      ]);
      expect(await inbox(tx, x.head, id)).toEqual([expect.stringMatching(/^doc_waiting: .* ждёт вашего согласования$/)]);
      expect(await inbox(tx, x.staff, id)).toEqual([]);

      await moveTo(tx, x, id, 15);
      // Последнее лицо согласовал сам начальник ИБ — себе уведомления нет; переводчику — его язык.
      expect(await inbox(tx, x.head, id)).toHaveLength(2);
      // Переводчик не пользователь портала: файлов перевода ждёт автор (1.4.0).
      expect(await inbox(tx, x.legal, id)).toEqual([]);
      expect((await inbox(tx, x.owner, id)).at(-1)).toMatch(/^doc_waiting: .* ждёт файлов перевода$/);
      const t = must((await view(tx, x.head, id)).translations[0]);
      await tr.addTranslationFiles(tx, await x.as(x.owner), id, t.id, { ...(await cur(tx, id)), fileIds: [(await makeFileRow(tx, x.owner.id)).id] });
      expect((await inbox(tx, x.head, id)).at(-1)).toMatch(/переводы готовы — можно на подписание/);
      expect((await inbox(tx, x.chief, id)).at(-1)).toMatch(/переводы готовы — можно на подписание/);
      await move(tx, x.chief, id, 'to_signing');
      expect((await inbox(tx, x.owner, id)).at(-1)).toMatch(/^doc_waiting: .* ждёт подписанного PDF$/);

      const list = await listNotifications(tx, x.owner.id, {});
      expect(list.items.find((n) => n.kind === 'doc_waiting')?.link).toBe(`/documents?doc=${id}`);
    }));

  it('«ждёт вас» — по stageHolders, один раз на состояние: блокер открыли и сняли — не повторяется; новый круг — снова', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create('Политика ИБ');
      await moveTo(tx, x, id, 13);
      const waiting = async () => (await inbox(tx, x.head, id)).filter((n) => n.includes('ждёт вашего согласования'));
      expect(await waiting()).toHaveLength(1);
      // Блокер открыли и сняли — состояние «ждёт начальника ИБ» то же: второго уведомления нет.
      await parties.addBlocker(tx, await x.as(x.owner), id, { ...(await cur(tx, id)), text: 'Ждём ДИКТ' });
      const b = must((await view(tx, x.head, id)).blockers[0]);
      await parties.resolveBlocker(tx, await x.as(x.chief), id, b.id, { ...(await cur(tx, id)), comment: 'Ответили' });
      await svc.notifyWaiting(tx, id, x.chief.id);
      expect(await waiting()).toHaveLength(1);
      // Вернули на доработку — новый круг: снова на этапе 13 — одно новое уведомление.
      await move(tx, x.head, id, 'return', { comment: 'Уточнить раздел 3' });
      await moveTo(tx, x, id, 13);
      expect(await waiting()).toHaveLength(2);
    }));

  it('все лица согласовали — начальнику ИБ (отметка); держатель старого права без отметки уведомлений не получает', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const roleOnly = await makeUser(tx, ['ib_staff', 'ib_head'], { fullName: 'Роль без отметки' });
      const theirs = await x.create('Чужой');
      await moveTo(tx, x, theirs, 13);
      expect(await inbox(tx, x.head, theirs)).toEqual([expect.stringMatching(/ждёт вашего согласования/)]);
      expect(await inbox(tx, roleOnly, theirs)).toEqual([]);
      // Свой документ: о своих действиях уведомлений нет.
      const own = await x.create('Свой', x.head.id);
      await move(tx, x.head, own, 'to_review');
      await move(tx, x.head, own, 'to_head');
      expect(await inbox(tx, x.head, own)).toEqual([]);

      const id = await x.create();
      await moveTo(tx, x, id, 14);
      const p = await addParty(tx, x.owner, id);
      await parties.approveParty(tx, await x.as(x.owner), id, p.id, await cur(tx, id));
      expect((await inbox(tx, x.head, id)).at(-1)).toMatch(/^doc_waiting: .*: все ответственные лица согласовали$/);
    }));

  it('сменили срок: лица — автору, перевода — автору (переводчик не пользователь портала); срок лица завтра и просрочен — автору, без дублей', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create('Регламент');
      const p = await addParty(tx, x.owner, id, { dueDate: '2026-11-10' });
      await parties.updateParty(tx, await x.as(x.head), id, p.id, { ...(await cur(tx, id)), dueDate: '2026-11-15', comment: 'Отсрочка' });
      expect(await inbox(tx, x.owner, id)).toEqual([expect.stringMatching(/^doc_deadline_changed: .*срок ответа Петров П\. П\. перенесён с 10\.11\.2026 на 15\.11\.2026$/)]);
      await tr.addTranslation(tx, await x.as(x.owner), id, { ...(await cur(tx, id)), language: 'Английский', translatorName: 'Сотрудник ИБ', dueDate: '2026-11-20' });
      const t = must((await view(tx, x.owner, id)).translations[0]);
      await tr.updateTranslation(tx, await x.as(x.head), id, t.id, { ...(await cur(tx, id)), dueDate: '2026-11-25', comment: 'Объём больше' });
      expect(await inbox(tx, x.staff, id)).toEqual([]);
      expect((await inbox(tx, x.owner, id)).at(-1)).toMatch(/срок перевода на Английский перенесён/);
      expect(await inbox(tx, x.owner, id)).toHaveLength(2);

      const at = (iso: string) => new Date(`${iso}T06:00:00Z`);
      expect(await notifyPartyDeadlines(tx, at('2026-11-14'))).toMatchObject({ dueTomorrow: expect.any(Number) });
      expect((await inbox(tx, x.owner, id)).at(-1)).toMatch(/^doc_party_due_tomorrow: .*срок ответа Петров П\. П\. — завтра, 15\.11\.2026$/);
      await notifyPartyDeadlines(tx, at('2026-11-14'));
      await notifyPartyDeadlines(tx, at('2026-11-17'));
      await notifyPartyDeadlines(tx, at('2026-11-18'));
      const mine = await inbox(tx, x.owner, id);
      expect(mine.filter((m) => m.startsWith('doc_party_due_tomorrow'))).toHaveLength(1);
      expect(mine.filter((m) => m.startsWith('doc_party_overdue'))).toEqual([expect.stringMatching(/Петров П\. П\. не ответил\(а\) в срок \(15\.11\.2026\)/)]);
      // Согласовавшее лицо — без напоминаний; архивный документ — тоже.
      await svc.setDocumentArchived(tx, await x.as(x.admin), id, (await cur(tx, id)).version, true);
      await tx.documentParty.update({ where: { id: p.id }, data: { dueDate: new Date('2026-11-16T00:00:00Z') } });
      await notifyPartyDeadlines(tx, at('2026-11-20'));
      expect(await inbox(tx, x.owner, id)).toHaveLength(mine.length);
    }));
});

describe('«Сейчас у» и «ждут вас» — одна функция (1.4.0, шаг 5)', () => {
  /** «Сейчас у» в реестре и «кто действует» под этапом карточки — глазами сотрудника ИБ. */
  const nowAt = async (tx: Tx, x: Fx, id: string) => {
    const item = must((await list(tx, x.staff)).find((d) => d.id === id));
    return { names: item.holders?.people.map((p) => p.fullName) ?? null, missingHead: item.holders?.missingHead ?? null };
  };
  /** Цифра у «Документы» = числу строк реестра с «ждёт вас» (одна функция). */
  const sameCount = async (tx: Tx, u: User) => {
    const n = (await svc.documentSummary(tx, await svc.accessOf(tx, u.id))).waitingForMe;
    expect(n).toBe((await list(tx, u)).filter((d) => d.waitingForMe).length);
    return n;
  };

  it('по этапам: 11, 12, 16 — автор; 13, 14 — начальник ИБ; 15 — переводчики, затем начальник ИБ и старшие; пройденные — кто и когда', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      expect(await nowAt(tx, x, id)).toEqual({ names: ['Автор Документа'], missingHead: false });
      await moveTo(tx, x, id, 12);
      expect((await nowAt(tx, x, id)).names).toEqual(['Автор Документа']);
      expect([await sameCount(tx, x.owner), await sameCount(tx, x.chief)]).toEqual([1, 0]); // старший может, но ждут автора
      await moveTo(tx, x, id, 13);
      expect((await nowAt(tx, x, id)).names).toEqual(['Начальник ИБ']);
      expect([await sameCount(tx, x.head), await sameCount(tx, x.owner)]).toEqual([1, 0]);
      // Открытый блокер шаг вперёд останавливает, но этап по-прежнему у начальника ИБ: снять блокер или вернуть — его действие.
      await parties.addBlocker(tx, await x.as(x.owner), id, { ...(await cur(tx, id)), text: 'Ждём ДИКТ' });
      expect(await sameCount(tx, x.head)).toBe(1);
      const b = must((await view(tx, x.head, id)).blockers[0]);
      await parties.resolveBlocker(tx, await x.as(x.head), id, b.id, { ...(await cur(tx, id)), comment: 'ДИКТ ответил' });
      await moveTo(tx, x, id, 14);
      expect((await nowAt(tx, x, id)).names).toEqual(['Начальник ИБ']);
      await moveTo(tx, x, id, 15);
      // Языков нет — перевести дальше: начальник ИБ и старший над автором.
      expect((await nowAt(tx, x, id)).names).toEqual(['Начальник ИБ', 'Руководитель автора']);
      expect([await sameCount(tx, x.head), await sameCount(tx, x.chief), await sameCount(tx, x.owner)]).toEqual([1, 1, 0]);
      await moveTo(tx, x, id, 16);
      expect((await nowAt(tx, x, id)).names).toEqual(['Автор Документа']);

      const card = await view(tx, x.staff, id);
      expect(card.holders?.people.map((p) => p.fullName)).toEqual(['Автор Документа']);
      const byStage = new Map(card.route.map((r) => [r.stage, r]));
      expect(byStage.get(13)).toMatchObject({ state: 'done', approvers: ['Начальник ИБ'], actedBy: 'Начальник ИБ', missingHead: false });
      expect(byStage.get(13)?.actedAt).not.toBeNull();
      expect(byStage.get(15)?.approvers).toEqual(['Начальник ИБ', 'Руководитель автора']);
      expect(byStage.get(16)).toMatchObject({ state: 'current', approvers: ['Автор Документа'], actedBy: null });
    }));

  it('отметка «Начальник ИБ» никому не стоит: на этапах 13 и 14 — «Начальник ИБ не назначен» в реестре и карточке; документ не ждёт никого', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await moveTo(tx, x, id, 13);
      await tx.user.update({ where: { id: x.head.id }, data: { isIbHead: false } });
      expect(await nowAt(tx, x, id)).toEqual({ names: [], missingHead: true });
      const card = await view(tx, x.staff, id);
      expect(card.holders).toEqual({ people: [], missingHead: true });
      expect(card.route.find((r) => r.stage === 14)).toMatchObject({ approvers: [], missingHead: true });
      expect(card.route.find((r) => r.stage === 11)).toMatchObject({ approvers: ['Автор Документа'], missingHead: false });
      expect(await sameCount(tx, x.head)).toBe(0);
    }));

  it('отключённый автор остаётся в «Сейчас у» с пометкой inactive и в маршруте — «(отключён)»', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await tx.user.update({ where: { id: x.owner.id }, data: { isActive: false } });
      const item = must((await list(tx, x.staff)).find((d) => d.id === id));
      expect(item.holders?.people).toEqual([{ id: x.owner.id, fullName: 'Автор Документа', inactive: true }]);
      expect((await view(tx, x.staff, id)).route.find((r) => r.stage === 11)?.approvers).toEqual(['Автор Документа (отключён)']);
    }));

  it('п. 1: видимость не считается — читатель без права действия видит документ, но цифра 0; язык без файла — у автора', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      // Подписанный документ на пересмотре, рабочая версия у начальника ИБ: читатель видит подписанную версию.
      const signed = await x.create('Подписанная политика');
      await signAll(tx, x, signed);
      await svc.reviseDocument(tx, await x.as(x.owner), signed, { version: (await cur(tx, signed)).version, edition: '2.0' });
      await moveTo(tx, x, signed, 13);
      const seen = (await list(tx, x.legal)).find((d) => d.id === signed);
      expect(seen).toMatchObject({ waitingForMe: false, holders: null });
      expect(await sameCount(tx, x.legal)).toBe(0);

      // Язык без файла на этапе 15 (1.4.0): файл прикладывает автор — документ ждёт автора, а не переводчика.
      const id = await x.create('Политика с переводом');
      await tr.addTranslation(tx, await x.as(x.owner), id, { ...(await cur(tx, id)), language: 'Таджикский', translatorName: 'Юрист', dueDate: '2026-11-20' });
      await moveTo(tx, x, id, 15);
      expect(await nowAt(tx, x, id)).toEqual({ names: ['Автор Документа'], missingHead: false });
      expect(await sameCount(tx, x.legal)).toBe(0);
      // Пока перевод не готов, начальника ИБ этот документ не ждёт (его ждёт только первый — на этапе 13).
      expect((await list(tx, x.head)).find((d) => d.id === id)?.waitingForMe).toBe(false);
      expect(await sameCount(tx, x.head)).toBe(1);
    }));
});
