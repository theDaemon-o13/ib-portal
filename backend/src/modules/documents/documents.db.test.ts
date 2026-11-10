// Документы с настоящей БД: маршрут 1.11.0 (этапы 21–24, ADR-0042), права, история, неизменность утверждённых
// версий, ответственные лица, переводы ссылками, файлы только на этапе 24, задачи и уведомления этапов.
// Тесты маршрута 1.2.0 (11–16) переписаны под 21–24; удалены только тесты переходов, которых больше нет.
import type { User } from '../../generated/prisma/client.js';
import { describe, expect, it } from 'vitest';
import { seedDocumentRoute, seedDocumentRouteV3, seedDocumentStageTasks, seedReviewTasksGrouped } from '../../../prisma/seed/documents.js';
import { testDbConfig } from '../../../scripts/test-db.js';
import { createPrisma } from '../../lib/db.js';
import { MIME_BY_EXT } from '../../lib/file-type.js';
import { addDaysIso, todayIso } from '../../lib/today.js';
import { actorFor, expectCode, inTx, makeFileRow, makeUser, must, type Tx } from '../../test/db.js';
import type { Actor } from '../settings/common.js';
import * as parties from './parties.js';
import * as tr from './translations.js';
import { notifyPartyDeadlines, notifyTranslationDeadlines } from './notify.js';
import { listNotifications } from '../notifications/service.js';
import { runDocumentReviews } from './review.js';
import * as svc from './service.js';
import ExcelJS from 'exceljs';
import { approvedRows, exportApproved } from './export.js';
import * as controls from './controls.js';
import * as autos from './automations.js';
import * as tasksSvc from '../tasks/service.js';
import { setIbHead } from '../users/service.js';
import { updatePortalParam } from '../settings/portal-params.js';
import { loadFullWorkCalendar } from '../calendar/service.js';
import { addWorkingDays, isoDate, parseIsoDate } from '../../lib/working-days.js';
import { addMonthsIso, type DocAction } from './status.js';

const URL1 = 'https://office.example.local/products/files/doceditor.aspx?fileid=101';
const URL_TJ = 'https://office.example.local/products/files/doceditor.aspx?fileid=202';
const SIGNED_ON = '2026-10-20';
const isoOf = (d: Date | null | undefined) => d?.toISOString().slice(0, 10) ?? null;

async function fixture(tx: Tx) {
  const type = await tx.catalogItem.create({ data: { catalogCode: 'document_types', value: `Политика ${Math.random().toString(36).slice(2)}` } });
  const admin = await makeUser(tx, ['super_admin'], { fullName: 'Администратор' });
  const chief = await makeUser(tx, ['ib_staff'], { fullName: 'Руководитель автора' });
  const owner = await makeUser(tx, ['ib_staff'], { fullName: 'Автор Документа', manager: { connect: { id: chief.id } } });
  const staff = await makeUser(tx, ['ib_staff'], { fullName: 'Сотрудник ИБ' });
  const head = await makeUser(tx, ['ib_staff', 'ib_head'], { fullName: 'Начальник ИБ', isIbHead: true });
  const legal = await makeUser(tx, ['doc_reader'], { fullName: 'Юрист' });
  const as = async (u: User): Promise<Actor> => actorFor(tx, u.id);
  /** Документ на «Драфте» (21): с 1.11.0 — только ссылка OnlyOffice, файлов нет. */
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
/** Место маршрута: «21:draft», «21:head_review», «22:parties», «22:head_recheck», «23», «24». */
async function place(tx: Tx, id: string): Promise<string> {
  const v = (await tx.document.findUniqueOrThrow({ where: { id }, include: { workingVersion: true } })).workingVersion;
  return v ? `${v.stage}${v.routeState ? `:${v.routeState}` : ''}` : 'none';
}

const docxFile = (tx: Tx, u: User, name = 'Версия.docx') => makeFileRow(tx, u.id, { name, mime: MIME_BY_EXT.docx });
const pdfFile = (tx: Tx, u: User, name = 'Подписан.pdf') => makeFileRow(tx, u.id, { name });

async function move(tx: Tx, u: User, id: string, action: DocAction, opts: { comment?: string; fileId?: string; confirmUnchanged?: boolean } = {}) {
  const confirmUnchanged = opts.confirmUnchanged ?? (action === 'to_translation' ? true : undefined);
  return svc.moveDocument(tx, await actorFor(tx, u.id), id, action, { ...(await cur(tx, id)), comment: opts.comment, fileId: opts.fileId, confirmUnchanged });
}

async function setFile(tx: Tx, u: User, id: string, slot: svc.ApprovalSlot, fileId: string | null, translationId?: string) {
  return svc.setApprovalFile(tx, await actorFor(tx, u.id), id, { ...(await cur(tx, id)), slot, fileId, translationId });
}

/** Обязательные файлы этапа 24: PDF и .docx основного языка, .docx каждого перевода. */
async function attachApproval(tx: Tx, u: User, id: string) {
  await setFile(tx, u, id, 'pdf', (await pdfFile(tx, u)).id);
  await setFile(tx, u, id, 'docx', (await docxFile(tx, u, 'Исходный.docx')).id);
  const versionId = must((await tx.document.findUniqueOrThrow({ where: { id } })).workingVersionId);
  for (const t of await tx.documentTranslation.findMany({ where: { versionId, removedAt: null, sourceDocxFileId: null } })) {
    await setFile(tx, u, id, 'translation_docx', (await docxFile(tx, u, `${t.language}.docx`)).id, t.id);
  }
}

async function sign(tx: Tx, u: User, id: string, opts: { signedOn?: string; orderNo?: string; orderDate?: string } = {}) {
  return svc.signDocument(tx, await actorFor(tx, u.id), id, { ...(await cur(tx, id)), signedOn: opts.signedOn ?? SIGNED_ON, orderNo: opts.orderNo, orderDate: opts.orderDate });
}

/** Места маршрута по порядку; moveTo доводит документ до места полным маршрутом без повторной проверки. */
const PLACES = ['21:draft', '21:head_review', '22:parties', '23', '24'] as const;
type Place = (typeof PLACES)[number];
async function moveTo(tx: Tx, x: Fx, id: string, target: Place) {
  for (let p = await place(tx, id); p !== target; p = await place(tx, id)) {
    if (!PLACES.includes(p as Place) || PLACES.indexOf(p as Place) > PLACES.indexOf(target)) throw new Error(`moveTo: документ на ${p}, цель ${target}`);
    if (p === '21:draft') await move(tx, x.owner, id, 'submit_head');
    else if (p === '21:head_review') await move(tx, x.head, id, 'head_approve');
    else if (p === '22:parties') {
      await approveParties(tx, x, id);
      await move(tx, x.owner, id, 'to_translation');
    } else if (p === '23') {
      await linkTranslations(tx, x, id);
      await move(tx, x.owner, id, 'to_approval');
    }
  }
}

/** Все ответственные лица рабочей версии согласовали (нет ни одного — автор добавляет одно). */
async function approveParties(tx: Tx, x: Pick<Fx, 'owner'>, id: string) {
  const versionId = must((await tx.document.findUniqueOrThrow({ where: { id } })).workingVersionId);
  if ((await tx.documentParty.count({ where: { versionId, removedAt: null } })) === 0) await addParty(tx, x.owner, id);
  for (const p of await tx.documentParty.findMany({ where: { versionId, removedAt: null, approvedAt: null } })) {
    await parties.approveParty(tx, await actorFor(tx, x.owner.id), id, p.id, await cur(tx, id));
  }
}

/** Ссылка на перевод у каждого языка без ссылки (этап 23). */
async function linkTranslations(tx: Tx, x: Fx, id: string) {
  const versionId = must((await tx.document.findUniqueOrThrow({ where: { id } })).workingVersionId);
  for (const t of await tx.documentTranslation.findMany({ where: { versionId, removedAt: null, onlyofficeUrl: '' } })) {
    await tr.updateTranslation(tx, await actorFor(tx, x.owner.id), id, t.id, { ...(await cur(tx, id)), onlyofficeUrl: URL_TJ });
  }
}

/** Лицо: на этапе 21 — срок днями (по умолчанию 7), на 22 — датой. */
async function addParty(tx: Tx, u: User, id: string, extra: Partial<parties.PartyInput> = {}) {
  const c = await cur(tx, id);
  const due = c.stage === 21 ? { dueDays: 7 } : { dueDate: '2026-11-10' };
  await parties.addParty(tx, await actorFor(tx, u.id), id, { ...c, fullName: 'Петров П. П.', department: 'Юридическое управление', ...due, ...extra });
  return tx.documentParty.findFirstOrThrow({ where: { documentId: id }, orderBy: { addedAt: 'desc' } });
}

async function addTranslation(tx: Tx, u: User, id: string, language: string, extra: { translatorName?: string; dueDate?: string; onlyofficeUrl?: string } = {}) {
  await tr.addTranslation(tx, await actorFor(tx, u.id), id, { ...(await cur(tx, id)), language, dueDate: extra.dueDate ?? '2026-11-20', ...extra });
  return tx.documentTranslation.findFirstOrThrow({ where: { documentId: id, removedAt: null }, orderBy: { addedAt: 'desc' } });
}

/** Утвердить документ полным маршрутом. */
async function signAll(tx: Tx, x: Fx, id: string, opts: { signedOn?: string } = {}) {
  await moveTo(tx, x, id, '24');
  await attachApproval(tx, x.owner, id);
  await sign(tx, x.owner, id, opts);
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

const stageTasks = (tx: Tx, id: string, open = true) => tx.task.findMany({
  where: { documentId: id, documentReason: 'stage', ...(open ? { completedAt: null, archivedAt: null } : {}) },
  include: { assignee: { select: { fullName: true } } },
  orderBy: { number: 'asc' },
});

describe('документы: маршрут 1.11.0 (ADR-0042)', () => {
  it('полный маршрут 21 → 24 без повторной проверки: кто что может, утверждение с файлами и приказом, пересмотр от даты утверждения', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      let d = await view(tx, x.owner, id);
      expect(d).toMatchObject({ status: 'draft', stage: 21, stageName: 'Драфт', waitingForMe: true });
      expect(d.can).toMatchObject({ actions: ['submit_head'], edit: true, parties: true, translations: false, approvalFiles: false });

      // 21 «Драфт» → «На проверке у начальника ИБ»: только автор (владелец или docs.manage); старший над автором — нет.
      await expectCode(move(tx, x.staff, id, 'submit_head'), 'FORBIDDEN');
      await expectCode(move(tx, x.chief, id, 'submit_head'), 'FORBIDDEN');
      await move(tx, x.owner, id, 'submit_head');
      d = await view(tx, x.head, id);
      expect(d).toMatchObject({ status: 'draft', stage: 21, waitingForMe: true });
      expect(d.can.actions).toEqual(['head_approve', 'head_return']);
      expect(d.route.find((r) => r.stage === 21)).toMatchObject({ state: 'current', place: 'На проверке у начальника ИБ', approvers: ['Начальник ИБ'] });
      // На проверке автор не правит документ.
      expect((await view(tx, x.owner, id)).can).toMatchObject({ edit: false, parties: false, actions: [] });

      // Одобрить — только начальник ИБ, без файла (в истории — ссылка OnlyOffice).
      await expectCode(move(tx, x.owner, id, 'head_approve'), 'FORBIDDEN');
      await move(tx, x.head, id, 'head_approve');
      expect(await place(tx, id)).toBe('22:parties');
      expect((await view(tx, x.owner, id)).status).toBe('in_approval');

      // 22 → 23: автор; без отметки «не изменялся» — 400; кнопки недоступны, пока не все лица согласовали.
      await addParty(tx, x.owner, id);
      await expectCode(move(tx, x.owner, id, 'to_translation'), 'PARTIES_PENDING');
      await approveParties(tx, x, id);
      await expectCode(move(tx, x.owner, id, 'to_translation', { confirmUnchanged: false }), 'CONFIRM_UNCHANGED');
      await expectCode(move(tx, x.head, id, 'to_translation'), 'FORBIDDEN');
      await expectCode(move(tx, x.chief, id, 'to_translation'), 'FORBIDDEN');
      await move(tx, x.owner, id, 'to_translation');
      // Начальник ИБ получил одну задачу — только на проверке (21).
      expect(await tx.task.count({ where: { documentId: id, documentReason: 'stage', assigneeId: x.head.id } })).toBe(1);

      // 23 → 24 без языков — сразу; только автор (начальник ИБ и старший — нет).
      await expectCode(move(tx, x.head, id, 'to_approval'), 'FORBIDDEN');
      await expectCode(move(tx, x.chief, id, 'to_approval'), 'FORBIDDEN');
      await move(tx, x.owner, id, 'to_approval');

      // 24: автор или начальник ИБ; без файлов — 409, дата — не позже сегодня.
      d = await view(tx, x.owner, id);
      expect(d).toMatchObject({ stage: 24, waitingForMe: true });
      expect(d.can).toMatchObject({ actions: [], sign: false, approvalFiles: true });
      expect(d.blockedReason).toMatch(/подписанный PDF, исходный документ Word/);
      await expectCode(sign(tx, x.owner, id), 'APPROVAL_FILES_REQUIRED');
      await expectCode(setFile(tx, x.staff, id, 'pdf', (await pdfFile(tx, x.staff)).id), 'FORBIDDEN');
      await expectCode(setFile(tx, x.owner, id, 'pdf', (await docxFile(tx, x.owner)).id), 'BAD_FILE_TYPE');
      await expectCode(setFile(tx, x.owner, id, 'docx', (await pdfFile(tx, x.owner)).id), 'BAD_FILE_TYPE');
      await setFile(tx, x.owner, id, 'pdf', (await pdfFile(tx, x.owner)).id);
      await expectCode(sign(tx, x.owner, id), 'APPROVAL_FILES_REQUIRED');
      await setFile(tx, x.head, id, 'docx', (await docxFile(tx, x.head, 'Исходный.docx')).id);
      expect((await view(tx, x.owner, id)).can.sign).toBe(true);
      await expectCode(sign(tx, x.staff, id), 'FORBIDDEN');
      await expectCode(sign(tx, x.owner, id, { signedOn: '2099-01-01' }), 'BAD_DATE');
      await expectCode(sign(tx, x.owner, id, { signedOn: '2026-02-30' }), 'BAD_DATE');
      await expectCode(sign(tx, x.owner, id, { orderNo: 'N'.repeat(101) }), 'TOO_LONG');
      await expectCode(sign(tx, x.owner, id, { orderNo: '12', orderDate: '2099-01-01' }), 'BAD_DATE');
      await sign(tx, x.owner, id, { orderNo: '15-ИБ', orderDate: SIGNED_ON });

      d = await view(tx, x.owner, id);
      expect(d).toMatchObject({ status: 'approved', approvedVersionNo: 1, signedOn: SIGNED_ON, working: null, stage: null });
      expect(d.reviewDue).toBe(addMonthsIso(SIGNED_ON, 12));
      expect(d.current).toMatchObject({ stage: 24, signedOn: SIGNED_ON, textFrozen: true });
      expect(d.current.pdf?.name).toBe('Подписан.pdf');
      expect(d.versions[0]).toMatchObject({ orderNo: '15-ИБ', orderDate: SIGNED_ON, docx: expect.objectContaining({ name: 'Исходный.docx' }) });
      expect(d.route.map((r) => [r.stage, r.state, r.actedBy])).toEqual([
        [21, 'done', 'Начальник ИБ'], [22, 'done', 'Автор Документа'], [23, 'done', 'Автор Документа'], [24, 'done', 'Автор Документа'],
      ]);
      expect(d.files).toEqual([]);
      expect(d.history.map((h) => `${h.decision}:${h.stage}→${h.toStage ?? ''}:${h.event}`)).toEqual([
        'signed:24→:approved_final', 'moved:23→24:translations_done', 'moved:22→23:unchanged_confirmed',
        'approved:21→22:head_approved', 'submitted:21→21:head_review_requested',
      ]);
      expect(d.history.find((h) => h.event === 'head_approved')?.comment).toBe(`Одобрено по ссылке OnlyOffice: ${URL1}`);
      expect(d.history.find((h) => h.event === 'unchanged_confirmed')?.comment).toMatch(/^Автор подтвердил: документ не изменялся после проверки начальником ИБ/);
      expect(d.history[0]?.pdfSha256).toMatch(/^[0-9a-f]{64}$/);
      // После утверждения маршрута нет.
      await expectCode(move(tx, x.head, id, 'head_return', { comment: 'x' }), 'NOT_IN_ROUTE');
      expect((await tx.auditLog.findFirstOrThrow({ where: { action: 'document.signed', entityId: id } })).diff).toMatchObject({ after: { signedOn: SIGNED_ON, orderNo: '15-ИБ' } });
    }));

  it('с повторной проверкой: у начальника ИБ задача на каждую проверку; возврат — комментарий обязателен, остаётся на 22, отметки «до доработки», на 21 не вернуть', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await moveTo(tx, x, id, '22:parties');
      const p = await addParty(tx, x.owner, id);
      await expectCode(move(tx, x.owner, id, 'request_recheck'), 'PARTIES_PENDING');
      await approveParties(tx, x, id);
      await expectCode(move(tx, x.head, id, 'request_recheck'), 'FORBIDDEN');
      await move(tx, x.owner, id, 'request_recheck');
      expect(await place(tx, id)).toBe('22:head_recheck');
      let d = await view(tx, x.head, id);
      expect(d.can.actions).toEqual(['head_reapprove', 'recheck_return']);
      expect(d.waitingForMe).toBe(true);
      // На повторной проверке автор лиц не ведёт.
      expect((await view(tx, x.owner, id)).can).toMatchObject({ parties: false, approveParties: false, actions: [] });
      await expectCode(addParty(tx, x.owner, id, { fullName: 'Иванов И. И.' }), 'WRONG_STAGE');

      // Возврат — только начальник ИБ, только с комментарием; документ остаётся на этапе 22.
      await expectCode(move(tx, x.head, id, 'recheck_return'), 'EMPTY_COMMENT');
      await expectCode(move(tx, x.owner, id, 'recheck_return', { comment: 'сам' }), 'FORBIDDEN');
      await move(tx, x.head, id, 'recheck_return', { comment: 'Уточнить раздел 3' });
      expect(await place(tx, id)).toBe('22:parties');
      d = await view(tx, x.owner, id);
      expect(d.current).toMatchObject({ stage: 22, round: 2 });
      expect(d.returned).toMatchObject({ actor: 'Начальник ИБ', comment: 'Уточнить раздел 3' });
      expect(d.parties[0]).toMatchObject({ approvedAt: expect.any(String), reworkedAt: expect.any(String) });
      expect(await tx.task.count({ where: { documentId: id, documentReason: 'returned', completedAt: null, assigneeId: x.owner.id } })).toBe(1);
      // Отметка «до доработки» считается отметкой: снова можно на повторную проверку или на перевод.
      expect(d.can.actions).toEqual(['request_recheck', 'to_translation']);
      // Возврата на этап 21 с этапа 22 нет.
      await expectCode(move(tx, x.head, id, 'head_return', { comment: 'на драфт' }), 'WRONG_STAGE');

      // «Запросить повторно»: отметка сброшена, новый срок, история только пополняется.
      const due = addDaysIso(todayIso(), 7);
      await expectCode(parties.recheckParty(tx, await x.as(x.owner), id, p.id, { ...(await cur(tx, id)), dueDate: '2020-01-01' }), 'BAD_DATE');
      await expectCode(parties.recheckParty(tx, await x.as(x.head), id, p.id, { ...(await cur(tx, id)), dueDate: due }), 'FORBIDDEN');
      await parties.recheckParty(tx, await x.as(x.owner), id, p.id, { ...(await cur(tx, id)), dueDate: due, comment: 'Раздел 3 изменён' });
      await expectCode(parties.recheckParty(tx, await x.as(x.owner), id, p.id, { ...(await cur(tx, id)), dueDate: due }), 'PARTY_NOT_APPROVED');
      d = await view(tx, x.owner, id);
      expect(d.parties[0]).toMatchObject({ approvedAt: null, reworkedAt: null, dueDate: due });
      expect(d.parties[0]?.rechecks).toEqual([expect.objectContaining({ toDue: due, comment: 'Раздел 3 изменён', actor: 'Автор Документа', reworkedAt: expect.any(String) })]);
      expect(d.can.actions).toEqual([]);
      expect(await sqlError(tx, `UPDATE document_party_rechecks SET comment = 'x' WHERE party_id = '${p.id}'`)).toMatch(/permission denied/);
      expect(await sqlError(tx, `DELETE FROM document_party_rechecks WHERE party_id = '${p.id}'`)).toMatch(/permission denied/);

      await approveParties(tx, x, id);
      await move(tx, x.owner, id, 'request_recheck');
      await move(tx, x.head, id, 'head_reapprove');
      expect(await place(tx, id)).toBe('23');
      const headTasks = await tx.task.findMany({ where: { documentId: id, documentReason: 'stage', assigneeId: x.head.id }, orderBy: { number: 'asc' } });
      expect(headTasks.map((t) => t.title.split(':')[0])).toEqual(['Проверить', 'Повторно проверить', 'Повторно проверить']);
      expect(headTasks.every((t) => t.completedAt !== null)).toBe(true);
      expect((await view(tx, x.owner, id)).history.map((h) => h.event).slice(0, 2)).toEqual(['head_reapproved', 'head_recheck_requested']);
    }));

  it('устаревший этап или версия на экране — 409; действие не своего места маршрута — 409', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await moveTo(tx, x, id, '21:head_review');
      const seen = await cur(tx, id);
      await svc.moveDocument(tx, await x.as(x.head), id, 'head_approve', seen);
      await expectCode(svc.moveDocument(tx, await x.as(x.head), id, 'head_approve', seen), 'VERSION_CONFLICT');
      await expectCode(svc.moveDocument(tx, await x.as(x.head), id, 'head_approve', { ...(await cur(tx, id)), stage: 21 }), 'STAGE_CHANGED');
      await expectCode(move(tx, x.owner, id, 'to_approval'), 'WRONG_STAGE');
      await expectCode(move(tx, x.head, id, 'head_reapprove'), 'WRONG_STAGE');
    }));

  it('начальник ИБ — только по отметке: роль ib_head без отметки не одобряет; супер-администратор с отметкой — SEPARATION_OF_DUTIES; за автора — docs.manage', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const roleOnly = await makeUser(tx, ['ib_staff', 'ib_head'], { fullName: 'Роль без отметки' });
      const id = await x.create();
      // Супер-администратор (docs.manage) действует за автора.
      await move(tx, x.admin, id, 'submit_head');
      await expectCode(move(tx, x.admin, id, 'head_approve'), 'FORBIDDEN');
      await expectCode(move(tx, roleOnly, id, 'head_approve'), 'FORBIDDEN');
      await expectCode(move(tx, roleOnly, id, 'head_return', { comment: 'замечание' }), 'FORBIDDEN');
      expect((await view(tx, roleOnly, id)).waitingForMe).toBe(false);
      const d = await view(tx, x.admin, id);
      expect(d.can.actions).toEqual([]);
      expect(d.route.find((r) => r.stage === 21)?.approvers).toEqual(['Начальник ИБ']);
      expect((await svc.documentSummary(tx, await svc.accessOf(tx, x.admin.id))).waitingForMe).toBe(0);
      // Отметка у супер-администратора (поставлена в обход сервиса) — одобрять он всё равно не может.
      await tx.user.update({ where: { id: x.head.id }, data: { isIbHead: false } });
      await tx.user.update({ where: { id: x.admin.id }, data: { isIbHead: true } });
      await expectCode(move(tx, x.admin, id, 'head_approve'), 'SEPARATION_OF_DUTIES');
    }));

  it('подробная история — только с правом «История в карточках»; кто прошёл этапы — видят все (ADR-0021)', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await signAll(tx, x, id);
      const plain = await view(tx, x.owner, id, { history: false });
      expect(plain.history).toEqual([]);
      expect(plain.route.map((r) => r.actedBy)).toEqual(['Начальник ИБ', 'Автор Документа', 'Автор Документа', 'Автор Документа']);
      expect((await view(tx, x.owner, id)).history).toHaveLength(5);
    }));

  it('история прежнего маршрута — с прежними подписями; файлы прежнего маршрута — только просмотр', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create('Документ 1.10.0');
      const v = must((await tx.document.findUniqueOrThrow({ where: { id } })).workingVersionId);
      // Как у документа, прошедшего часть маршрута 1.2.0: решение 11 → 12 и файл драфта.
      await tx.documentApproval.create({ data: { documentId: id, versionId: v, versionNo: 1, round: 1, stage: 11, toStage: 12, decision: 'moved', actorId: x.owner.id } });
      const f = await docxFile(tx, x.owner, 'Политика 1.10.docx');
      await tx.documentFile.create({ data: { documentId: id, versionId: v, round: 1, kind: 'draft', fileId: f.id, addedBy: x.owner.id } });
      const d = await view(tx, x.owner, id);
      expect(d.history.find((h) => h.stage === 11)).toMatchObject({ stageName: 'Драфт', toStageName: 'Проверка сотрудниками', event: null });
      expect(d.files.map((r) => [r.file.name, r.marks, r.removable])).toEqual([['Политика 1.10.docx', ['Файл драфта'], false]]);
      expect(d.can.draftFiles).toBe(false);
      await expectCode(svc.removeDraftFile(tx, await x.as(x.owner), id, must(d.files[0]).id, await cur(tx, id)), 'FILES_ONLY_AT_APPROVAL');
    }));
});

describe('документы: автор — начальник ИБ (отметка одна)', () => {
  it('свой документ одобряет сам — на проверке и повторной проверке, с отметкой «без независимого согласования»', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      await makeUser(tx, ['ib_staff', 'ib_head'], { fullName: 'Роль без отметки' });
      const id = await x.create('Свой документ', x.head.id);
      await move(tx, x.head, id, 'submit_head');
      expect((await view(tx, x.head, id)).can.actions).toEqual(['head_approve', 'head_return']);
      await move(tx, x.head, id, 'head_approve');
      await approveParties(tx, { owner: x.head }, id);
      await move(tx, x.head, id, 'request_recheck');
      await move(tx, x.head, id, 'head_reapprove');
      const d = await view(tx, x.head, id);
      expect(d.history.filter((h) => h.selfApproved).map((h) => h.event)).toEqual(['head_reapproved', 'head_approved']);
      const audit = (await tx.auditLog.findMany({ where: { action: 'document.moved', entityId: id } }))
        .find((a) => (a.diff as { after?: { event?: string } }).after?.event === 'head_approved');
      expect((must(audit).diff as { summary: string }).summary).toMatch(/одобрено автором \(начальник ИБ\), без независимого согласования/);
      // Чужой документ — обычным порядком, без отметки.
      const other = await x.create();
      await moveTo(tx, x, other, '22:parties');
      expect((await view(tx, x.head, other)).route.find((r) => r.stage === 21)?.selfApproved).toBe(false);
    }));
});

describe('документы: возврат с проверки начальника ИБ', () => {
  it('только начальник ИБ, только с комментарием, только «на проверке»; новый круг; задача владельцу; повторная отправка закрывает её', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await expectCode(move(tx, x.head, id, 'head_return', { comment: 'рано' }), 'WRONG_STAGE');
      await moveTo(tx, x, id, '21:head_review');
      await expectCode(move(tx, x.head, id, 'head_return'), 'EMPTY_COMMENT');
      await expectCode(move(tx, x.owner, id, 'head_return', { comment: 'сам' }), 'FORBIDDEN');
      // Записка файлом — больше нет: файлы только на этапе 24.
      await expectCode(move(tx, x.head, id, 'head_return', { comment: 'x', fileId: (await pdfFile(tx, x.head)).id }), 'FILES_ONLY_AT_APPROVAL');
      await move(tx, x.head, id, 'head_return', { comment: 'Уточнить раздел 3' });

      const d = await view(tx, x.owner, id);
      expect(d.current).toMatchObject({ stage: 21, round: 2 });
      expect(await place(tx, id)).toBe('21:draft');
      expect(d.returned).toMatchObject({ actor: 'Начальник ИБ', stageName: 'Драфт', comment: 'Уточнить раздел 3', file: null });
      expect(d.can).toMatchObject({ edit: true, actions: ['submit_head'] });
      const task = await tx.task.findFirstOrThrow({ where: { documentId: id, documentReason: 'returned' } });
      expect(task).toMatchObject({ assigneeId: x.owner.id, completedAt: null });

      await move(tx, x.owner, id, 'submit_head');
      expect((await tx.task.findUniqueOrThrow({ where: { id: task.id } })).completedAt).not.toBeNull();
      await move(tx, x.head, id, 'head_return', { comment: 'Ещё раз' });
      expect((await tx.task.findFirstOrThrow({ where: { documentId: id, documentReason: 'returned', completedAt: null } })).id).not.toBe(task.id);
    }));
});

describe('документы: файлы — только на этапе 24', () => {
  it('на 21–23 каждый маршрут прикладывания файла — 409 FILES_ONLY_AT_APPROVAL', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      const nobody = '00000000-0000-4000-8000-000000000000';
      const tryAll = async () => {
        const f = (await docxFile(tx, x.owner)).id;
        await expectCode(svc.addDraftFiles(tx, await x.as(x.owner), id, { ...(await cur(tx, id)), fileIds: [f] }), 'FILES_ONLY_AT_APPROVAL');
        await expectCode(setFile(tx, x.owner, id, 'pdf', (await pdfFile(tx, x.owner)).id), 'FILES_ONLY_AT_APPROVAL');
        await expectCode(parties.addResponseFiles(tx, await x.as(x.owner), id, nobody, { ...(await cur(tx, id)), fileIds: [f] }), 'FILES_ONLY_AT_APPROVAL');
        await expectCode(tr.addTranslationFiles(tx, await x.as(x.owner), id, nobody, { ...(await cur(tx, id)), fileIds: [f] }), 'FILES_ONLY_AT_APPROVAL');
      };
      await tryAll();
      await expectCode(move(tx, x.owner, id, 'submit_head', { fileId: (await docxFile(tx, x.owner)).id }), 'FILES_ONLY_AT_APPROVAL');
      await moveTo(tx, x, id, '22:parties');
      await tryAll();
      const p = await addParty(tx, x.owner, id);
      await expectCode(parties.approveParty(tx, await x.as(x.owner), id, p.id, { ...(await cur(tx, id)), fileIds: [(await pdfFile(tx, x.owner)).id] }), 'FILES_ONLY_AT_APPROVAL');
      await moveTo(tx, x, id, '23');
      await tryAll();
      expect(await tx.documentFile.count({ where: { documentId: id } })).toBe(0);
    }));

  it('на 24: замена файла удаляет прежний без ссылок; файл утверждённой версии не удалить и SQL-запросом', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await moveTo(tx, x, id, '24');
      const first = await pdfFile(tx, x.owner, 'Первый.pdf');
      await setFile(tx, x.owner, id, 'pdf', first.id);
      await setFile(tx, x.owner, id, 'pdf', (await pdfFile(tx, x.owner, 'Второй.pdf')).id);
      expect((await tx.file.findUniqueOrThrow({ where: { id: first.id } })).deletedAt).not.toBeNull();
      await setFile(tx, x.owner, id, 'docx', (await docxFile(tx, x.owner)).id);
      await setFile(tx, x.owner, id, 'docx', null);
      expect((await view(tx, x.owner, id)).can.sign).toBe(false);
      await attachApproval(tx, x.owner, id);
      await sign(tx, x.owner, id);
      const v = await tx.documentVersion.findFirstOrThrow({ where: { documentId: id } });
      expect(await sqlError(tx, `UPDATE files SET deleted_at = now() WHERE id = '${v.sourceDocxFileId}'`)).toMatch(/есть ссылки/);
      expect(await sqlError(tx, `UPDATE files SET deleted_at = now() WHERE id = '${v.pdfFileId}'`)).toMatch(/есть ссылки/);
    }));
});

describe('документы: комментарии', () => {
  it('сотрудники ИБ — на любом этапе 21–24; читатель — нет; не правятся и не удаляются', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      const say = async (u: User, body: string) => svc.addDocumentComment(tx, await x.as(u), id, { body });
      await say(x.staff, 'На драфте');
      await expectCode(say(x.staff, '   '), 'EMPTY_COMMENT');
      await expectCode(say(x.legal, 'без доступа'), 'FORBIDDEN');
      await moveTo(tx, x, id, '22:parties');
      expect((await view(tx, x.staff, id)).can.comment).toBe(true);
      await say(x.staff, 'В п. 4 не хватает срока');
      await moveTo(tx, x, id, '24');
      await say(x.owner, 'Добавил');
      expect((await view(tx, x.owner, id)).comments.map((c) => [c.author, c.body])).toEqual([
        ['Сотрудник ИБ', 'На драфте'], ['Сотрудник ИБ', 'В п. 4 не хватает срока'], ['Автор Документа', 'Добавил'],
      ]);
      expect(await sqlError(tx, `UPDATE document_comments SET body = 'x' WHERE document_id = '${id}'`)).toMatch(/permission denied/);
      expect(await sqlError(tx, `DELETE FROM document_comments WHERE document_id = '${id}'`)).toMatch(/permission denied/);
      await attachApproval(tx, x.owner, id);
      await sign(tx, x.owner, id);
      await expectCode(say(x.staff, 'поздно'), 'WRONG_STAGE');
    }));
});

describe('документы: новая версия и отмена пересмотра', () => {
  it('правка утверждённого — новая версия на «Драфт» через маршрут заново; утверждённая версия не меняется', () =>
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
      expect(d.current).toMatchObject({ no: 2, stage: 21, round: 1, edition: '2.0', approvedAt: null });
      expect(await place(tx, id)).toBe('21:draft');
      expect(d.approved?.no).toBe(1);
      await svc.updateDocument(tx, await x.as(x.owner), id, { ...(await cur(tx, id)), title: 'Политика ИБ, ред. 2' });
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
      await moveTo(tx, x, id, '21:head_review');
      expect((await view(tx, x.head, id)).can.cancelRevision).toBe(true);
      expect((await view(tx, x.staff, id)).can.cancelRevision).toBe(false);
      await expectCode(cancel(x.staff, 'чужой'), 'FORBIDDEN');
      await expectCode(cancel(x.head, '  '), 'EMPTY_COMMENT');
      await cancel(x.head, 'Изменения не нужны');

      const d = await view(tx, x.owner, id);
      expect(d).toMatchObject({ status: 'approved', approvedVersionNo: 1, working: null, stage: null });
      expect(d.versions.map((v) => [v.no, v.approvedAt !== null, v.cancelledAt !== null])).toEqual([[2, false, true], [1, true, false]]);
      expect(d.history[0]).toMatchObject({ decision: 'cancelled', versionNo: 2, stage: 21, comment: 'Изменения не нужны' });
      await svc.reviseDocument(tx, await x.as(x.owner), id, { version: (await cur(tx, id)).version });
      expect((await view(tx, x.owner, id)).current).toMatchObject({ no: 3, stage: 21 });
    }));
});

describe('документы: удаление (docs.delete)', () => {
  it('неутверждённый — мягко, пропадает отовсюду, в журнале; утверждённый — только в архив', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const signed = await x.create('Утверждённый');
      await signAll(tx, x, signed);
      await expectCode(svc.deleteDocument(tx, await x.as(x.head), signed, { version: (await cur(tx, signed)).version }), 'DOC_SIGNED');
      expect((await view(tx, x.head, signed)).can.delete).toBe(false);

      const draft = await x.create('Ненужный драфт');
      await moveTo(tx, x, draft, '21:head_review');
      expect((await view(tx, x.head, draft)).can.delete).toBe(true);
      expect((await view(tx, x.owner, draft)).can.delete).toBe(false);
      await svc.deleteDocument(tx, await x.as(x.head), draft, { version: (await cur(tx, draft)).version, comment: 'Дубль' });

      const row = await tx.document.findUniqueOrThrow({ where: { id: draft } });
      expect(row.deletedBy).toBe(x.head.id);
      expect(row.deletedAt).not.toBeNull();
      expect(row.archivedAt).not.toBeNull();
      await expectCode(view(tx, x.head, draft), 'NOT_FOUND');
      expect((await list(tx, x.head)).some((d) => d.id === draft)).toBe(false);
      await expectCode(svc.setDocumentArchived(tx, await x.as(x.admin), draft, row.version, false), 'NOT_FOUND');
      await expectCode(move(tx, x.head, draft, 'head_approve'), 'NOT_FOUND');
      expect(await stageTasks(tx, draft)).toEqual([]);
      expect((await tx.auditLog.findFirstOrThrow({ where: { action: 'document.deleted', entityId: draft } })).diff).toMatchObject({ summary: `Документ #${row.number} «Ненужный драфт» удалён: Дубль` });
      expect(await sqlError(tx, `UPDATE documents SET deleted_at = now(), archived_at = now() WHERE id = '${signed}'`)).toMatch(/documents_deleted_check/);
    }));
});

describe('документы: фильтры и порядок реестра', () => {
  it('тип, автор, срок пересмотра; по типам — сначала «Политика»; значения фильтров — из видимых документов', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
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
      await signAll(tx, x, soon, { signedOn: addDaysIso(today, -300) });
      await signAll(tx, x, late, { signedOn: addDaysIso(today, -400) });

      const mine = [soon, late, draft];
      const q = async (extra: Partial<svc.DocListQuery>) =>
        (await svc.listDocuments(tx, await svc.accessOf(tx, x.head.id), { archived: false, limit: 500, ...extra })).items.map((d) => d.id).filter((id) => mine.includes(id));
      expect(await q({ typeId: policy.id, sort: 'title' })).toEqual([late, draft]);
      expect(await q({ ownerId: x.staff.id })).toEqual([draft]);
      expect(await q({ due: 'overdue' })).toEqual([late]);
      expect(await q({ due: 'd90' })).toEqual([soon]);
      expect(await q({ due: 'd30' })).toEqual([]);
      expect(await q({ dueTo: today, sort: 'title' })).toEqual([late]);
      expect(await q({ due: 'd365', sort: 'title' })).toEqual([soon]);
      expect(await q({ sort: 'type' })).toEqual([late, draft, soon]);
      expect(await q({ sort: 'title' })).toEqual([soon, late, draft]);

      const page = await svc.listDocuments(tx, await svc.accessOf(tx, x.head.id), { archived: false, limit: 500, typeId: instr.id });
      expect(page.facets.types.map((t) => t.value).slice(0, 1)).toEqual(['Политика']);
      expect(page.facets.owners.map((o) => o.id)).toEqual(expect.arrayContaining([x.owner.id, x.staff.id]));
      const reader = await svc.listDocuments(tx, await svc.accessOf(tx, x.legal.id), { archived: false, limit: 500 });
      expect(reader.facets.owners.some((o) => o.id === x.staff.id)).toBe(false);
    }));
});

describe('документы: «В работе» и «Утверждённые» (1.11.0, план — раздел 4)', () => {
  it('подменю фильтрует рабочие и утверждённые; реестр — редакция, приказ, дни до пересмотра, «на пересмотре»; Excel и журнал; читатель — только видимое', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const draft = await x.create('Черновик реестра');
      const atParties = await x.create('На согласовании реестра');
      await moveTo(tx, x, atParties, '22:parties');
      const signed = await x.create('Утверждённый реестра');
      await moveTo(tx, x, signed, '24');
      await attachApproval(tx, x.owner, signed);
      await sign(tx, x.owner, signed, { orderNo: '15-ИБ', signedOn: SIGNED_ON });
      const revised = await x.create('Пересмотр реестра');
      await signAll(tx, x, revised);
      await svc.reviseDocument(tx, await x.as(x.owner), revised, { version: (await cur(tx, revised)).version, edition: '2.0' });
      const mine = [draft, atParties, signed, revised];
      const ids = async (u: User, q: Partial<svc.DocListQuery>) =>
        (await svc.listDocuments(tx, await svc.accessOf(tx, u.id), { archived: false, limit: 500, sort: 'title', ...q })).items.map((d) => d.id).filter((id) => mine.includes(id));

      expect(await ids(x.staff, { view: 'work' })).toEqual([atParties, revised, draft]);
      expect(await ids(x.staff, { view: 'work', stage: 22 })).toEqual([atParties]);
      expect(await ids(x.staff, { view: 'approved' })).toEqual([revised, signed]);
      expect(await ids(x.staff, { view: 'approved', onReview: true })).toEqual([revised]);

      const rows = await approvedRows(tx, await svc.accessOf(tx, x.staff.id), {}, '2027-10-25');
      const row = must(rows.find((r) => r.title === 'Утверждённый реестра'));
      expect(row).toMatchObject({ version: '1 · ред. 1.0', approvedOn: SIGNED_ON, orderNo: '15-ИБ', reviewDue: addMonthsIso(SIGNED_ON, 12), daysLeft: -5, onReview: false });
      expect(rows.filter((r) => r.onReview).map((r) => r.title)).toEqual(['Пересмотр реестра']);

      const { fileName, buffer } = await exportApproved(tx, await x.as(x.staff), await svc.accessOf(tx, x.staff.id), { onReview: false });
      expect(fileName).toMatch(/^Утверждённые документы \d{4}-\d{2}-\d{2}\.xlsx$/);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
      const ws = must(wb.getWorksheet('Утверждённые'));
      expect((ws.getRow(1).values as unknown[]).slice(1)).toEqual(['№', 'Документ', 'Тип', 'Владелец', 'Действующая версия', 'Утверждён', 'Приказ', 'Пересмотр до', 'Дней до пересмотра', 'Механизмов контроля', 'Автоматизаций', 'На пересмотре']);
      const titles = ws.getColumn(2).values.slice(2);
      expect(titles).toEqual(expect.arrayContaining(['Утверждённый реестра']));
      expect(titles).not.toContain('Черновик реестра');
      expect(await tx.auditLog.count({ where: { action: 'documents.approved_exported', userId: x.staff.id } })).toBe(1);

      // Читатель без ib.work: в реестре утверждённых — те же утверждённые; рабочих версий нет.
      expect(await ids(x.legal, { view: 'approved' })).toEqual([revised, signed]);
      expect(await ids(x.legal, { view: 'work' })).toEqual([]);
    }));
});

describe('документы: механизмы контроля (1.11.0, ADR-0043)', () => {
  const fields = { clause: 'п. 4.2', requirement: 'Пароли — не короче 12 символов', mechanism: 'Проверка групповой политики AD\nраз в квартал', checkMethod: 'Выгрузка GPO', expectedEvidence: 'Скриншот политики', executorUnit: 'ДИКТ' };

  it('ведут владелец, начальник ИБ и docs.manage; сотрудник ИБ — только читает; без ib.work — 403; только у утверждённого', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const draft = await x.create('Черновик с контролем');
      await expectCode(controls.createControl(tx, await x.as(x.owner), draft, fields), 'NOT_APPROVED');
      const id = await x.create();
      await signAll(tx, x, id);
      const c1 = await controls.createControl(tx, await x.as(x.owner), id, fields);
      expect(c1).toMatchObject({ position: 1, mechanism: 'Проверка групповой политики AD\nраз в квартал', active: true, version: 1, creator: 'Автор Документа' });
      const c2 = await controls.createControl(tx, await x.as(x.head), id, { requirement: '  Журналы  хранятся год ', mechanism: 'Проверка SIEM' });
      expect(c2).toMatchObject({ position: 2, requirement: 'Журналы хранятся год', clause: '' });
      await controls.createControl(tx, await x.as(x.admin), id, { requirement: 'Резервные копии', mechanism: 'Тест восстановления' });
      await expectCode(controls.createControl(tx, await x.as(x.staff), id, fields), 'FORBIDDEN');
      await expectCode(controls.createControl(tx, await x.as(x.owner), id, { requirement: ' ', mechanism: 'x' }), 'EMPTY');
      await expectCode(controls.createControl(tx, await x.as(x.owner), id, { requirement: 'x', mechanism: 'y', clause: 'п'.repeat(301) }), 'TOO_LONG');
      expect(await controls.listControls(tx, await x.as(x.staff), id)).toMatchObject({ canManage: false, items: [{ position: 1 }, { position: 2 }, { position: 3 }] });
      expect((await controls.listControls(tx, await x.as(x.owner), id)).canManage).toBe(true);
      await expectCode(controls.listControls(tx, await x.as(x.legal), id), 'FORBIDDEN');
      // Пересмотр: механизмы — у документа, сохраняются.
      await svc.reviseDocument(tx, await x.as(x.owner), id, { version: (await cur(tx, id)).version });
      expect((await controls.listControls(tx, await x.as(x.owner), id)).items).toHaveLength(3);
      // Архив — только чтение.
      await svc.setDocumentArchived(tx, await x.as(x.admin), id, (await cur(tx, id)).version, true);
      expect((await controls.listControls(tx, await x.as(x.owner), id)).canManage).toBe(false);
      await expectCode(controls.createControl(tx, await x.as(x.owner), id, fields), 'DOC_ARCHIVED');
    }));

  it('изменение — с version (409), отключение вместо удаления, журнал «было → стало»; в реестре — число активных; DELETE запрещён', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await signAll(tx, x, id);
      const c = await controls.createControl(tx, await x.as(x.owner), id, fields);
      await controls.createControl(tx, await x.as(x.owner), id, { requirement: 'Второе', mechanism: 'Второй механизм' });
      const upd = await controls.updateControl(tx, await x.as(x.owner), id, c.id, { version: 1, checkMethod: 'Отчёт RSoP' });
      expect(upd).toMatchObject({ checkMethod: 'Отчёт RSoP', version: 2 });
      await expectCode(controls.updateControl(tx, await x.as(x.owner), id, c.id, { version: 1, clause: 'п. 5' }), 'VERSION_CONFLICT');
      await expectCode(controls.updateControl(tx, await x.as(x.staff), id, c.id, { version: 2, clause: 'п. 5' }), 'FORBIDDEN');
      const same = await controls.updateControl(tx, await x.as(x.owner), id, c.id, { version: 2, checkMethod: 'Отчёт RSoP' });
      expect(same.version).toBe(2);
      const off = await controls.updateControl(tx, await x.as(x.head), id, c.id, { version: 2, active: false });
      expect(off).toMatchObject({ active: false, version: 3 });
      const audit = await tx.auditLog.findMany({ where: { entityId: id, action: { startsWith: 'document_control.' } }, orderBy: { at: 'asc' } });
      expect(audit.map((a) => a.action)).toEqual(['document_control.created', 'document_control.created', 'document_control.updated', 'document_control.disabled']);
      expect((audit[2]?.diff as { after: { changes: unknown[] } }).after.changes).toEqual([{ label: 'Способ проверки', from: 'Выгрузка GPO', to: 'Отчёт RSoP' }]);
      expect((await list(tx, x.staff)).find((d) => d.id === id)?.controlsActive).toBe(1);
      expect((await list(tx, x.legal)).find((d) => d.id === id)?.controlsActive).toBe(0);
      expect(await sqlError(tx, `DELETE FROM document_controls WHERE id = '${c.id}'`)).toMatch(/permission denied/);
    }));

  it('под владельцем схемы: механизмы и автоматизации не удаляются, запуски только пополняются, событие контроля — сразу обработанное', async () => {
    const owner = createPrisma(testDbConfig().ownerUrl);
    try {
      await inOwnerTx(owner, async (tx) => {
        const x = await fixture(tx);
        const id = await x.create();
        await signAll(tx, x, id);
        const c = await controls.createControl(tx, await x.as(x.owner), id, fields);
        expect(await sqlError(tx, `DELETE FROM document_controls WHERE id = '${c.id}'`)).toMatch(/не удаляется/);
        const a = await tx.documentControlAutomation.create({ data: {
          documentId: id, controlId: c.id, title: 'Проверить GPO', cadence: { kind: 'monthly', day: 1 }, startsOn: new Date('2026-11-01'),
          dueDays: 5, dueKind: 'working', assigneeId: x.staff.id, createdBy: x.owner.id,
        } });
        expect(await sqlError(tx, `DELETE FROM document_control_automations WHERE id = '${a.id}'`)).toMatch(/не удаляется/);
        expect(await sqlError(tx, `UPDATE document_control_automations SET due_days = 0 WHERE id = '${a.id}'`)).toMatch(/document_control_automations_check/);
        expect(await sqlError(tx, `UPDATE document_control_automations SET cadence = '{"kind":"hourly"}' WHERE id = '${a.id}'`)).toMatch(/document_control_automations_check/);
        const run = await tx.documentControlRun.create({ data: { automationId: a.id, nominalDate: new Date('2026-11-01'), plannedDate: new Date('2026-10-30'), status: 'no_assignee' } });
        expect(await sqlError(tx, `UPDATE document_control_runs SET status = 'created' WHERE id = '${run.id}'`)).toMatch(/только пополняется/);
        expect(await sqlError(tx, `DELETE FROM document_control_runs WHERE id = '${run.id}'`)).toMatch(/только пополняется/);
        expect(await sqlError(tx, `INSERT INTO document_control_runs (automation_id, nominal_date, planned_date, status) VALUES ('${a.id}', '2026-11-01', '2026-10-30', 'no_assignee')`)).toMatch(/document_control_runs_automation_id_nominal_date_key/);
        expect(await sqlError(tx, `INSERT INTO document_control_runs (automation_id, nominal_date, planned_date, status) VALUES ('${a.id}', '2026-12-01', '2026-12-01', 'created')`)).toMatch(/document_control_runs_status_check/);
        expect(await sqlError(tx, `INSERT INTO automation_events (control_automation_id, event_type, recipients, trigger_key, fire_at) VALUES ('${a.id}', 'remind', '[]', '2026-11-01', '2026-11-01')`)).toMatch(/automation_events_control_processed_check/);
        expect(await sqlError(tx, `INSERT INTO automation_events (control_automation_id, document_id, event_type, recipients, trigger_key, fire_at, status, processed_at) VALUES ('${a.id}', '${id}', 'remind', '[]', 'k', '2026-11-01', 'processed', now())`)).toMatch(/automation_events_subject_check/);
        await tx.$executeRawUnsafe(`INSERT INTO automation_events (control_automation_id, event_type, recipients, trigger_key, fire_at, status, processed_at) VALUES ('${a.id}', 'remind', '[]', '2026-11-01', '2026-11-01', 'processed', now())`);
      });
    } finally {
      await owner.$disconnect();
    }
  });
});

describe('документы: автоматизации механизмов контроля (1.11.0, ADR-0043)', () => {
  /** Утверждённый документ с механизмом контроля и автоматизацией; createdAt и startsOn — в прошлом, чтобы прогон «в прошлом» работал. */
  const setup = async (tx: Tx, input: Partial<autos.AutomationInput> & { createdOn?: string } = {}) => {
    const x = await fixture(tx);
    const id = await x.create('Политика паролей');
    await signAll(tx, x, id);
    const c = await controls.createControl(tx, await x.as(x.owner), id, { requirement: 'Пароли — не короче 12 символов', mechanism: 'Проверка GPO' });
    const a = await autos.createAutomation(tx, await x.as(x.owner), id, {
      title: 'Проверить GPO паролей', controlId: c.id, cadence: { kind: 'monthly', day: 1 }, startsOn: '2026-01-01', dueDays: 3, dueKind: 'working', assigneeId: x.staff.id,
      ...input,
    });
    await tx.documentControlAutomation.update({ where: { id: a.id }, data: { createdAt: new Date(`${input.createdOn ?? input.startsOn ?? '2026-01-01'}T03:00:00Z`) } });
    return { x, id, c, a };
  };
  const at = (iso: string) => new Date(`${iso}T06:00:00Z`);
  const runs = (tx: Tx, automationId: string) => tx.documentControlRun.findMany({ where: { automationId }, orderBy: { nominalDate: 'asc' }, include: { task: true } });

  it('ведут владелец, начальник ИБ и docs.manage; ответственный — сотрудник ИБ; механизм — этого документа; видят сотрудники ИБ', () =>
    inTx(async (tx) => {
      const { x, id, a } = await setup(tx);
      expect(a).toMatchObject({ cadenceLabel: 'ежемесячно, 1-го', assignee: { fullName: 'Сотрудник ИБ' }, control: { position: 1 }, active: true, noAssignee: false });
      const base = { title: 't', cadence: { kind: 'daily' } as const, startsOn: '2026-01-01', dueDays: 1, dueKind: 'calendar' as const, assigneeId: x.staff.id };
      await expectCode(autos.createAutomation(tx, await x.as(x.staff), id, base), 'FORBIDDEN');
      await expectCode(autos.createAutomation(tx, await x.as(x.owner), id, { ...base, assigneeId: x.legal.id }), 'BAD_ASSIGNEE');
      await expectCode(autos.createAutomation(tx, await x.as(x.owner), id, { ...base, dueDays: 0 }), 'BAD_DUE_DAYS');
      const other = await x.create('Другой');
      await signAll(tx, x, other);
      const foreign = await controls.createControl(tx, await x.as(x.owner), other, { requirement: 'r', mechanism: 'm' });
      await expectCode(autos.createAutomation(tx, await x.as(x.owner), id, { ...base, controlId: foreign.id }), 'BAD_CONTROL');
      await autos.createAutomation(tx, await x.as(x.head), id, base);
      await autos.createAutomation(tx, await x.as(x.admin), id, base);
      expect(await autos.listAutomations(tx, await x.as(x.staff), id)).toMatchObject({ canManage: false });
      expect((await autos.listAutomations(tx, await x.as(x.staff), id)).items).toHaveLength(3);
      await expectCode(autos.listAutomations(tx, await x.as(x.legal), id), 'FORBIDDEN');
      await expectCode(autos.runAutomationNow(tx, await x.as(x.staff), id, a.id), 'FORBIDDEN');
      // Изменение — с version; отключение; журнал.
      const off = await autos.updateAutomation(tx, await x.as(x.owner), id, a.id, { version: 1, active: false });
      expect(off).toMatchObject({ active: false, version: 2, next: null });
      await expectCode(autos.updateAutomation(tx, await x.as(x.owner), id, a.id, { version: 1, dueDays: 5 }), 'VERSION_CONFLICT');
      expect(await tx.auditLog.count({ where: { entityId: id, action: { startsWith: 'document_control_automation.' } } })).toBe(4);
      expect((await list(tx, x.staff)).find((d) => d.id === id)?.automationsActive).toBe(2);
    }));

  it('запуск с выходного — на предыдущий рабочий день; срок — от дня создания через праздник; повторный прогон без дублей; событие сразу обработано', () =>
    inTx(async (tx) => {
      const { x, id, a } = await setup(tx);
      // 03.02.2026 (вторник) — праздник в производственном календаре.
      await tx.workCalendarDay.create({ data: { day: new Date('2026-02-03T00:00:00Z'), kind: 'holiday', title: 'Тестовый праздник' } });
      // 01.02.2026 — воскресенье: запуск 30.01 (пятница). 29.01 — рано.
      // Запуск 01.01 (первый) на 29.01 старше 7 дней — «пропущен»; 01.02 ещё рано.
      expect(await autos.runControlAutomations(tx, { now: at('2026-01-29'), automationId: a.id })).toMatchObject({ created: 0, skipped: 1 });
      // 01.02 → 30.01 — задача.
      expect(await autos.runControlAutomations(tx, { now: at('2026-01-30'), automationId: a.id })).toMatchObject({ ran: true, created: 1, skipped: 0 });
      expect((await runs(tx, a.id)).map((x2) => [isoOf(x2.nominalDate), x2.status])).toEqual([['2026-01-01', 'skipped_late'], ['2026-02-01', 'created']]);
      const r = (await runs(tx, a.id)).find((x2) => x2.status === 'created');
      expect([isoOf(r?.nominalDate), isoOf(r?.plannedDate)]).toEqual(['2026-02-01', '2026-01-30']);
      // 30.01 + 3 рабочих дня: 02.02, (03.02 праздник), 04.02, 05.02.
      expect(must(r?.task)).toMatchObject({ source: 'document_control', assigneeId: x.staff.id, title: 'Проверить GPO паролей', documentId: null });
      expect(isoOf(must(r?.task).dueDate)).toBe('2026-02-05');
      expect(must(r?.task).description).toContain('Механизм контроля 1: Пароли — не короче 12 символов');
      const ev = await tx.automationEvent.findFirstOrThrow({ where: { controlAutomationId: a.id } });
      expect(ev).toMatchObject({ status: 'processed', triggerKey: '2026-02-01' });
      expect(await tx.notification.count({ where: { userId: x.staff.id, taskId: must(r?.task).id, kind: 'task_assigned' } })).toBe(1);
      // Повтор — без дублей.
      expect((await autos.runControlAutomations(tx, { now: at('2026-01-30'), automationId: a.id })).created).toBe(0);
      expect((await autos.runControlAutomations(tx, { now: at('2026-02-02'), automationId: a.id })).created).toBe(0);
      expect(await runs(tx, a.id)).toHaveLength(2);
      // Карточка задачи — происхождение; удалить нельзя, архивировать можно.
      const dto = await tasksSvc.getTask(tx, must(r?.task).id);
      expect(dto.origin).toMatchObject({ kind: 'document_control', document: { id, title: 'Политика паролей' }, automation: { title: 'Проверить GPO паролей' }, control: { position: 1 }, nominalDate: '2026-02-01' });
      const t = await tx.task.findUniqueOrThrow({ where: { id: must(r?.task).id } });
      await expectCode(tasksSvc.deleteTask(tx, await x.as(x.admin), t.id, t.version), 'TASK_LINKED_TO_CONTROL');
      await tasksSvc.setTaskArchived(tx, await x.as(x.admin), t.id, t.version, true);
      // Категория — системная «Контроль по документу».
      expect((await tx.catalogItem.findUniqueOrThrow({ where: { id: t.categoryId } })).systemKey).toBe('document_control');
    }));

  it('догон после простоя — до 7 дней задачей, старше — «пропущен»; документ в архиве — запусков нет; пересмотр — работает', () =>
    inTx(async (tx) => {
      const { x, id, a } = await setup(tx, { cadence: { kind: 'daily' }, dueKind: 'calendar', dueDays: 1, startsOn: '2026-03-01' });
      const r = await autos.runControlAutomations(tx, { now: at('2026-03-20'), automationId: a.id });
      // 01.03–20.03: двадцать дат; не старше 7 дней — 13.03…20.03 (восемь), остальные двенадцать — «пропущен».
      expect(r).toMatchObject({ created: 8, skipped: 12 });
      const all = await runs(tx, a.id);
      expect(all.filter((x2) => x2.status === 'skipped_late').every((x2) => x2.taskId === null)).toBe(true);
      expect(isoOf(all.find((x2) => x2.status === 'created')?.nominalDate)).toBe('2026-03-13');
      // Пересмотр (рабочая версия есть) — автоматизация работает.
      await svc.reviseDocument(tx, await x.as(x.owner), id, { version: (await cur(tx, id)).version });
      expect((await autos.runControlAutomations(tx, { now: at('2026-03-21'), automationId: a.id })).created).toBe(1);
      // Архив — не создаётся ничего.
      await svc.setDocumentArchived(tx, await x.as(x.admin), id, (await cur(tx, id)).version, true);
      expect(await autos.runControlAutomations(tx, { now: at('2026-03-22'), automationId: a.id })).toMatchObject({ created: 0, automations: 0 });
    }));

  it('ежедневно со сроком в рабочих днях: суббота и воскресенье переносятся на пятницу — один запуск, не три (найдено на репетиции 1.11.0)', () =>
    inTx(async (tx) => {
      // 06.11.2026 — пятница; 07 и 08 — выходные; 09 — понедельник.
      const { x, id, c, a } = await setup(tx, { cadence: { kind: 'daily' }, dueKind: 'working', dueDays: 3, startsOn: '2026-11-06' });
      expect(await autos.runControlAutomations(tx, { now: at('2026-11-06'), automationId: a.id })).toMatchObject({ created: 1, skipped: 0 });
      expect(await autos.runControlAutomations(tx, { now: at('2026-11-06'), automationId: a.id })).toMatchObject({ created: 0 });
      expect(await autos.runControlAutomations(tx, { now: at('2026-11-08'), automationId: a.id })).toMatchObject({ created: 0 });
      expect(await autos.runControlAutomations(tx, { now: at('2026-11-09'), automationId: a.id })).toMatchObject({ created: 1 });
      expect((await runs(tx, a.id)).map((r) => [isoOf(r.nominalDate), isoOf(r.plannedDate)])).toEqual([['2026-11-06', '2026-11-06'], ['2026-11-09', '2026-11-09']]);
      // Календарные дни — без переноса: каждый день свой запуск.
      const cal = await autos.createAutomation(tx, await x.as(x.owner), id, {
        title: 'Проверить GPO каждый день', controlId: c.id, cadence: { kind: 'daily' }, startsOn: '2026-11-06', dueDays: 1, dueKind: 'calendar', assigneeId: x.staff.id,
      });
      await tx.documentControlAutomation.update({ where: { id: cal.id }, data: { createdAt: new Date('2026-11-06T03:00:00Z') } });
      expect(await autos.runControlAutomations(tx, { now: at('2026-11-08'), automationId: cal.id })).toMatchObject({ created: 3 });
    }));

  it('нет ответственного — запуск без задачи, автору одно уведомление; после смены ответственного — снова задачи', () =>
    inTx(async (tx) => {
      const { x, id, a } = await setup(tx, { cadence: { kind: 'daily' }, dueKind: 'calendar', dueDays: 1, startsOn: '2026-04-01' });
      await tx.user.update({ where: { id: x.staff.id }, data: { isActive: false } });
      expect(await autos.runControlAutomations(tx, { now: at('2026-04-01'), automationId: a.id })).toMatchObject({ created: 0, noAssignee: 1 });
      expect(await autos.runControlAutomations(tx, { now: at('2026-04-02'), automationId: a.id })).toMatchObject({ created: 0, noAssignee: 1 });
      const notes = await tx.notification.findMany({ where: { userId: x.owner.id, kind: 'doc_control_no_assignee' } });
      expect(notes).toHaveLength(1);
      expect(notes[0]?.title).toMatch(/нет ответственного — задачи не создаются/);
      expect((await autos.listAutomations(tx, await x.as(x.owner), id)).items[0]).toMatchObject({ noAssignee: true });
      await autos.updateAutomation(tx, await x.as(x.owner), id, a.id, { version: (await tx.documentControlAutomation.findUniqueOrThrow({ where: { id: a.id } })).version, assigneeId: x.head.id });
      expect(await autos.runControlAutomations(tx, { now: at('2026-04-03'), automationId: a.id })).toMatchObject({ created: 1, noAssignee: 0 });
      expect((await autos.listAutomations(tx, await x.as(x.owner), id)).items[0]).toMatchObject({ noAssignee: false, runs: [{ status: 'created' }, { status: 'no_assignee' }, { status: 'no_assignee' }] });
    }));
});

describe('документы: задачи этапов маршрута (ADR-0034, маршрут 1.11.0)', () => {
  const who = async (tx: Tx, id: string) => (await stageTasks(tx, id)).map((t) => t.assignee?.fullName ?? `— ${t.recipientLabel}`).sort();
  const workdays = async (tx: Tx, n: number) => isoDate(addWorkingDays(parseIsoDate(todayIso()), n, await loadFullWorkCalendar(tx)));
  const dueOf = (t: { dueDate: Date | null }) => t.dueDate?.toISOString().slice(0, 10) ?? null;

  it('каждое место маршрута — задача тому, кто действует; смена места закрывает прежние; начальнику ИБ — только проверка', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create('Политика паролей');
      const num = (await tx.document.findUniqueOrThrow({ where: { id } })).number;

      // 21: документ завёл администратор за владельца — владельцу «Подготовить драфт», 5 рабочих дней.
      const [t21] = await stageTasks(tx, id);
      expect(t21).toMatchObject({ assigneeId: x.owner.id, title: `Подготовить драфт: документ #${num} «Политика паролей»`, source: 'document' });
      expect(dueOf(must(t21))).toBe(await workdays(tx, 5));
      expect(must(t21).description).toContain(`Тип: ${x.type.value}`);
      expect(must(t21).description).toContain('Этап: Драфт (1 из 4), версия 1');
      expect(await tx.notification.count({ where: { taskId: must(t21).id } })).toBe(0);

      // На проверке — начальнику ИБ «Проверить», 3 рабочих дня; задача драфта закрыта.
      await move(tx, x.owner, id, 'submit_head');
      expect((await tx.task.findUniqueOrThrow({ where: { id: must(t21).id } })).completedAt).not.toBeNull();
      expect(await who(tx, id)).toEqual(['Начальник ИБ']);
      const [t21h] = await stageTasks(tx, id);
      expect(must(t21h).description).toContain('Этап: Драфт — На проверке у начальника ИБ (1 из 4), версия 1');
      expect(dueOf(must(t21h))).toBe(await workdays(tx, 3));

      // 22: автору; срок — ближайший срок несогласовавшего лица; меняется вместе со сроком лица.
      await move(tx, x.head, id, 'head_approve');
      const [t22] = await stageTasks(tx, id);
      expect(t22).toMatchObject({ assigneeId: x.owner.id, title: expect.stringMatching(/^Согласовать с ответственными лицами/) });
      expect(dueOf(must(t22))).toBeNull();
      const p = await addParty(tx, x.owner, id, { dueDate: '2026-12-10' });
      await addParty(tx, x.owner, id, { fullName: 'Иванов И. И.', dueDate: '2026-12-20' });
      expect(dueOf(await tx.task.findUniqueOrThrow({ where: { id: must(t22).id } }))).toBe('2026-12-10');
      await parties.updateParty(tx, await x.as(x.owner), id, p.id, { ...(await cur(tx, id)), dueDate: '2026-12-15', comment: 'Попросили отсрочку' });
      expect(dueOf(await tx.task.findUniqueOrThrow({ where: { id: must(t22).id } }))).toBe('2026-12-15');
      await parties.approveParty(tx, await x.as(x.owner), id, p.id, await cur(tx, id));
      expect(dueOf(await tx.task.findUniqueOrThrow({ where: { id: must(t22).id } }))).toBe('2026-12-20');

      // 23 без языков — автору «Отправить на утверждение»; 24 — «Утвердить документ»; утверждение закрывает всё.
      await moveTo(tx, x, id, '23');
      expect((await stageTasks(tx, id))[0]).toMatchObject({ assigneeId: x.owner.id, title: expect.stringMatching(/^Перевести и отправить на утверждение/) });
      await moveTo(tx, x, id, '24');
      expect((await stageTasks(tx, id))[0]?.title).toMatch(/^Утвердить документ/);
      expect(dueOf(must((await stageTasks(tx, id))[0]))).toBe(await workdays(tx, 5));
      await attachApproval(tx, x.owner, id);
      await sign(tx, x.owner, id);
      expect(await stageTasks(tx, id)).toEqual([]);
      const all = await stageTasks(tx, id, false);
      expect(new Set(all.map((t) => `${t.documentState}|${t.assigneeId}`)).size).toBe(all.length);
      // Без повторной проверки у начальника ИБ ровно одна задача.
      expect(all.filter((t) => t.assigneeId === x.head.id)).toHaveLength(1);
    }));

  it('возврат — задачи этапа закрыты, у автора «Доработать»; перевод — автору со сроком языка; срок по умолчанию — из параметров портала (новый ключ)', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      await updatePortalParam(tx, await x.as(x.admin), 'documents.stageDays.v3', { value: { '21': 5, '21h': 7, '22h': 3, '23': 3, '24': 5 }, version: 0 });
      const id = await x.create();
      await moveTo(tx, x, id, '21:head_review');
      expect(dueOf(must((await stageTasks(tx, id))[0]))).toBe(await workdays(tx, 7));
      await move(tx, x.head, id, 'head_return', { comment: 'Нет раздела 4' });
      expect(await stageTasks(tx, id)).toEqual([]);
      expect(await tx.task.count({ where: { documentId: id, documentReason: 'returned', completedAt: null } })).toBe(1);

      await moveTo(tx, x, id, '23');
      const t = await addTranslation(tx, x.owner, id, 'Английский', { dueDate: '2026-12-05' });
      // Задача этапа та же; срок — срок языка без ссылки, со ссылкой — снова N рабочих дней этапа.
      const [tt] = await stageTasks(tx, id);
      expect(tt).toMatchObject({ assigneeId: x.owner.id, title: expect.stringMatching(/^Перевести и отправить на утверждение/) });
      expect(dueOf(must(tt))).toBe('2026-12-05');
      await tr.updateTranslation(tx, await x.as(x.owner), id, t.id, { ...(await cur(tx, id)), onlyofficeUrl: URL_TJ });
      expect((await stageTasks(tx, id)).map((z) => z.id)).toEqual([must(tt).id]);
    }));

  it('seed: документы в работе получают задачи этапа; повторный запуск ничего не меняет', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await moveTo(tx, x, id, '21:head_review');
      await tx.$executeRaw`UPDATE tasks SET document_reason = 'returned', document_state = NULL WHERE document_reason = 'stage' AND document_id = ${id}::uuid`;
      expect(await stageTasks(tx, id)).toEqual([]);
      await seedDocumentStageTasks(tx);
      expect(await who(tx, id)).toEqual(['Начальник ИБ']);
      const n = await tx.task.count({ where: { documentReason: 'stage' } });
      await seedDocumentStageTasks(tx);
      expect(await tx.task.count({ where: { documentReason: 'stage' } })).toBe(n);
    }));

  it('seed 1.6.4: личные задачи «Проверить» прежнего этапа 12 — в архив, задачу владельца не трогает', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      const v = must((await tx.document.findUniqueOrThrow({ where: { id } })).workingVersionId);
      const [own] = await stageTasks(tx, id);
      const mk = async (u: User, done = false) => (await tx.task.create({ data: {
        title: 'Проверить: документ', statusId: must(own).statusId, priorityId: must(own).priorityId, categoryId: must(own).categoryId,
        assigneeId: u.id, source: 'document', documentId: id, documentReason: 'stage', documentState: `${v}:1:12`, ...(done ? { completedAt: new Date() } : {}),
      } })).id;
      const a = await mk(x.staff);
      const b = await mk(x.head, true);
      await tx.seedMarker.deleteMany({ where: { key: 'docs.stage_tasks.group.v1' } });
      await seedReviewTasksGrouped(tx);
      for (const t of [a, b]) expect((await tx.task.findUniqueOrThrow({ where: { id: t } })).archivedAt).not.toBeNull();
      expect((await tx.task.findUniqueOrThrow({ where: { id: must(own).id } })).archivedAt).toBeNull();
    }));

  it('отметку начальника ИБ передали или сняли — задача переходит или остаётся без ответственного; закрытую вручную не возвращаем', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await moveTo(tx, x, id, '21:head_review');
      const [was] = await stageTasks(tx, id);
      const ver = async (u: User) => (await tx.user.findUniqueOrThrow({ where: { id: u.id } })).version;
      await setIbHead(tx, await x.as(x.admin), x.staff.id, { version: await ver(x.staff), value: true, transfer: true });
      expect(await who(tx, id)).toEqual(['Сотрудник ИБ']);
      expect((await tx.task.findUniqueOrThrow({ where: { id: must(was).id } })).archivedAt).not.toBeNull();
      await setIbHead(tx, await x.as(x.admin), x.staff.id, { version: await ver(x.staff), value: false });
      expect(await who(tx, id)).toEqual([`— ${svc.NO_HEAD_LABEL}`]);
      await setIbHead(tx, await x.as(x.admin), x.head.id, { version: await ver(x.head), value: true });
      expect(await who(tx, id)).toEqual(['Начальник ИБ']);

      const [t] = await stageTasks(tx, id);
      await tx.task.update({ where: { id: must(t).id }, data: { completedAt: new Date() } });
      await tx.taskTransition.create({ data: { taskId: must(t).id, fromStatusId: must(t).statusId, toStatusId: must(t).statusId, actorId: x.head.id, kind: 'override' } });
      await svc.syncStageTasks(tx, id);
      expect(await stageTasks(tx, id)).toEqual([]);
    }));
});

describe('документы: перенос при обновлении на 1.2.0 (seed docs.route.v1_2)', () => {
  it('рабочие версии 0 → 11, 1 → 13, 2 и 3 → 14; утверждённые не трогаются; повторный запуск ничего не меняет', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const ids: string[] = [];
      for (const stage of [0, 1, 2, 3]) {
        const id = await x.create(`Старый на этапе ${stage}`);
        const v = must((await tx.document.findUniqueOrThrow({ where: { id } })).workingVersionId);
        await tx.documentVersion.update({ where: { id: v }, data: { stage, routeState: null } });
        ids.push(id);
      }
      const signed = await x.create('Утверждённый');
      await signAll(tx, x, signed);
      const before = await tx.documentVersion.findFirstOrThrow({ where: { documentId: signed } });

      await seedDocumentRoute(tx);
      const stages = await Promise.all(ids.map(async (id) => (await cur(tx, id)).stage));
      expect(stages).toEqual([11, 13, 14, 14]);
      expect(await tx.documentVersion.findFirstOrThrow({ where: { documentId: signed } })).toEqual(before);
      const h = (await view(tx, x.owner, must(ids[1]))).history;
      expect(h[0]).toMatchObject({ decision: 'migrated', actor: 'Система', stage: 1, stageName: 'Начальник ИБ', toStage: 13, toStageName: 'Согласование начальника ИБ' });
      const decisions = await tx.documentApproval.count({ where: { decision: 'migrated', documentId: { in: ids } } });
      await seedDocumentRoute(tx);
      expect(await tx.documentApproval.count({ where: { decision: 'migrated', documentId: { in: ids } } })).toBe(decisions);
    }));
});

describe('документы: перенос на маршрут 1.11.0 (seed docs.route.v3)', () => {
  it('11 и 12 → 21, 13 → 21 «на проверке» с задачей начальника ИБ, 14 → 22 по отметкам лиц, 15 → 23, 16 → 24; утверждённые и отменённые не трогаются; повторный запуск ничего не меняет', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      /** Документ «как в 1.10.0»: рабочая версия на этапе маршрута 1.2.0 (в том числе созданная 1.10.0 после отката). */
      const atStage = async (stage: number, title: string) => {
        const id = await x.create(title);
        const v = must((await tx.document.findUniqueOrThrow({ where: { id } })).workingVersionId);
        await tx.documentVersion.update({ where: { id: v }, data: { stage, routeState: null } });
        return { id, v };
      };
      const party = (documentId: string, versionId: string, approved: boolean) => tx.documentParty.create({ data: {
        documentId, versionId, fullName: 'Петров П. П.', dueDate: new Date('2026-12-01T00:00:00Z'), addedBy: x.owner.id,
        ...(approved ? { approvedAt: new Date(), approvedBy: x.owner.id } : {}),
      } });
      const s11 = await atStage(11, 'Драфт 1.2.0');
      const s12 = await atStage(12, 'Проверка сотрудниками');
      const s13 = await atStage(13, 'У начальника ИБ');
      const s14a = await atStage(14, 'Лица не все');
      await party(s14a.id, s14a.v, true);
      await party(s14a.id, s14a.v, false);
      const s14b = await atStage(14, 'Лица согласовали');
      await party(s14b.id, s14b.v, true);
      const s14c = await atStage(14, 'Без лиц');
      const s15 = await atStage(15, 'Перевод');
      const s16 = await atStage(16, 'Подписание');
      // Задача начальника ИБ на этапе 13 — как её создал 1.10.0.
      const [own] = await stageTasks(tx, s13.id);
      const headTask = await tx.task.create({ data: {
        title: 'Согласовать: документ', statusId: must(own).statusId, priorityId: must(own).priorityId, categoryId: must(own).categoryId,
        assigneeId: x.head.id, source: 'document', documentId: s13.id, documentReason: 'stage', documentState: `${s13.v}:1:13`,
      } });
      const signed = await x.create('Утверждённый');
      await signAll(tx, x, signed);
      const before = await tx.documentVersion.findFirstOrThrow({ where: { documentId: signed } });
      const cancelled = await x.create('Пересмотр отменён');
      await signAll(tx, x, cancelled);
      await svc.reviseDocument(tx, await x.as(x.owner), cancelled, { version: (await cur(tx, cancelled)).version });
      const cv = must((await tx.document.findUniqueOrThrow({ where: { id: cancelled } })).workingVersionId);
      await tx.documentVersion.update({ where: { id: cv }, data: { stage: 13, routeState: null } });
      await svc.cancelRevision(tx, await x.as(x.owner), cancelled, { version: (await cur(tx, cancelled)).version, comment: 'Не нужен' });

      await seedDocumentRouteV3(tx);
      await seedDocumentStageTasks(tx);
      const places = await Promise.all([s11, s12, s13, s14a, s14b, s14c, s15, s16].map((d) => place(tx, d.id)));
      expect(places).toEqual(['21:draft', '21:draft', '21:head_review', '22:parties', '22:head_recheck', '22:parties', '23', '24']);
      expect(await tx.documentVersion.findFirstOrThrow({ where: { documentId: signed } })).toEqual(before);
      expect((await tx.documentVersion.findUniqueOrThrow({ where: { id: cv } })).stage).toBe(13);

      // История: решение migrated от «Системы», прежняя подпись этапа → новое место.
      const h = (await view(tx, x.owner, s13.id)).history;
      expect(h[0]).toMatchObject({ decision: 'migrated', actor: 'Система', stage: 13, stageName: 'Согласование начальника ИБ', toStage: 21, toStageName: 'Драфт' });
      expect(h[0]?.comment).toBe('Перенесён на маршрут 1.11.0 при обновлении: «Согласование начальника ИБ» → «Драфт — На проверке у начальника ИБ»');
      // Задача начальника ИБ сохранилась (новое состояние), второй не появилось.
      const t13 = await tx.task.findUniqueOrThrow({ where: { id: headTask.id } });
      expect(t13).toMatchObject({ completedAt: null, archivedAt: null, documentState: `${s13.v}:1:21:head_review` });
      expect((await stageTasks(tx, s13.id)).map((t) => t.id)).toEqual([headTask.id]);
      // Перенесённый документ идёт дальше по новому маршруту.
      await move(tx, x.head, s13.id, 'head_approve');
      expect(await place(tx, s13.id)).toBe('22:parties');
      expect((await tx.task.findUniqueOrThrow({ where: { id: headTask.id } })).completedAt).not.toBeNull();
      // На 22 «На повторной проверке» — у начальника ИБ задача; на 23 файлы прежнего перевода не считаются ссылкой.
      expect((await stageTasks(tx, s14b.id)).map((t) => t.assigneeId)).toEqual([x.head.id]);
      expect((await tx.auditLog.findFirstOrThrow({ where: { action: 'document.route_migrated' }, orderBy: { at: 'desc' } })).diff).toMatchObject({ moved: 8, headTasks: 1 });

      const decisions = await tx.documentApproval.count({ where: { decision: 'migrated' } });
      const tasks = await tx.task.count();
      await seedDocumentRouteV3(tx);
      await seedDocumentStageTasks(tx);
      expect(await tx.documentApproval.count({ where: { decision: 'migrated' } })).toBe(decisions);
      expect(await tx.task.count()).toBe(tasks);
    }));
});

describe('документы: неизменность истории и утверждённых версий', () => {
  /** Новые колонки 1.11.0 у утверждённой версии и её строк: каждая — отдельный UPDATE. */
  const newColumnUpdates = async (tx: Tx, id: string, u: User) => {
    const v = await tx.documentVersion.findFirstOrThrow({ where: { documentId: id, approvedAt: { not: null } } });
    const t = await tx.documentTranslation.findFirstOrThrow({ where: { versionId: v.id } });
    const p = await tx.documentParty.findFirstOrThrow({ where: { versionId: v.id } });
    const f = (await docxFile(tx, u, 'Подмена.docx')).id;
    return {
      version: [
        `UPDATE document_versions SET route_state = 'draft' WHERE id = '${v.id}'`,
        `UPDATE document_versions SET source_docx_file_id = '${f}' WHERE id = '${v.id}'`,
        `UPDATE document_versions SET order_no = 'подмена' WHERE id = '${v.id}'`,
        `UPDATE document_versions SET order_date = '2026-01-01' WHERE id = '${v.id}'`,
      ],
      children: [
        `UPDATE document_translations SET onlyoffice_url = 'https://x.local/y' WHERE id = '${t.id}'`,
        `UPDATE document_translations SET source_docx_file_id = '${f}' WHERE id = '${t.id}'`,
        `UPDATE document_translations SET signed_pdf_file_id = '${f}' WHERE id = '${t.id}'`,
        `UPDATE document_translations SET source_docx_file_id = NULL WHERE id = '${t.id}'`,
        `UPDATE document_parties SET approved_on = '2026-01-01' WHERE id = '${p.id}'`,
        `UPDATE document_parties SET due_days = 5 WHERE id = '${p.id}'`,
        `UPDATE document_parties SET reworked_at = now() WHERE id = '${p.id}'`,
      ],
    };
  };
  /** Утверждённый документ с переводом (Word и PDF) и согласовавшим лицом. */
  const approvedWithChildren = async (tx: Tx, x: Fx) => {
    const id = await x.create();
    await moveTo(tx, x, id, '23');
    const t = await addTranslation(tx, x.owner, id, 'Таджикский', { onlyofficeUrl: URL_TJ });
    await moveTo(tx, x, id, '24');
    await attachApproval(tx, x.owner, id);
    await setFile(tx, x.owner, id, 'translation_pdf', (await pdfFile(tx, x.owner, 'tj.pdf')).id, t.id);
    await sign(tx, x.owner, id, { orderNo: '7' });
    return id;
  };

  it('роль приложения не правит и не удаляет историю и версии; новые колонки утверждённой версии и её строк — отклоняются', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await approvedWithChildren(tx, x);
      const v1 = await tx.documentVersion.findFirstOrThrow({ where: { documentId: id, no: 1 } });
      expect(await sqlError(tx, `UPDATE document_approvals SET comment = 'x' WHERE document_id = '${id}'`)).toMatch(/permission denied/);
      expect(await sqlError(tx, `UPDATE document_approvals SET event = 'head_approved' WHERE document_id = '${id}'`)).toMatch(/permission denied/);
      expect(await sqlError(tx, `DELETE FROM document_approvals WHERE document_id = '${id}'`)).toMatch(/permission denied/);
      expect(await sqlError(tx, 'TRUNCATE document_approvals')).toMatch(/permission denied/);
      expect(await sqlError(tx, `DELETE FROM document_versions WHERE id = '${v1.id}'`)).toMatch(/permission denied/);
      expect(await sqlError(tx, `UPDATE document_versions SET title = 'подмена' WHERE id = '${v1.id}'`)).toMatch(/утверждённая версия не меняется/);
      const sql = await newColumnUpdates(tx, id, x.owner);
      for (const s of [...sql.version, ...sql.children]) expect(await sqlError(tx, s)).toMatch(/утверждённая версия не меняется/);
      expect(await tx.documentVersion.findUniqueOrThrow({ where: { id: v1.id } })).toEqual(v1);
      // Прежние колонки строк утверждённой версии триггер не трогает (1.10.0 после отката пишет их как раньше).
      const t = await tx.documentTranslation.findFirstOrThrow({ where: { versionId: v1.id } });
      await tx.$executeRawUnsafe(`UPDATE document_translations SET translator_name = translator_name WHERE id = '${t.id}'`);
    }));

  it('триггеры и ограничения срабатывают и для владельца схемы, в том числе на новые колонки утверждённой версии', async () => {
    const owner = createPrisma(testDbConfig().ownerUrl);
    try {
      await inOwnerTx(owner, async (tx) => {
        const x = await fixture(tx);
        const id = await approvedWithChildren(tx, x);
        const v1 = await tx.documentVersion.findFirstOrThrow({ where: { documentId: id, no: 1 } });
        expect(await sqlError(tx, `UPDATE document_approvals SET comment = 'x' WHERE document_id = '${id}'`)).toMatch(/только пополняется/);
        expect(await sqlError(tx, `UPDATE document_versions SET title = 'подмена' WHERE id = '${v1.id}'`)).toMatch(/утверждённая версия не меняется/);
        expect(await sqlError(tx, `DELETE FROM document_versions WHERE id = '${v1.id}'`)).toMatch(/версии не удаляются/);
        const sql = await newColumnUpdates(tx, id, x.owner);
        for (const s of [...sql.version, ...sql.children]) expect(await sqlError(tx, s)).toMatch(/утверждённая версия не меняется/);
        const p = must(await tx.documentParty.findFirst({ where: { versionId: v1.id } }));
        await tx.documentPartyRecheck.create({ data: { documentId: id, partyId: p.id, prevApprovedAt: new Date(), fromDue: p.dueDate, toDue: p.dueDate, actorId: x.owner.id } });
        expect(await sqlError(tx, `UPDATE document_party_rechecks SET comment = 'x' WHERE party_id = '${p.id}'`)).toMatch(/только пополняется/);
        expect(await sqlError(tx, `DELETE FROM document_party_rechecks WHERE party_id = '${p.id}'`)).toMatch(/только пополняется/);

        const draft = await x.create('Без PDF');
        const dv = must((await tx.document.findUniqueOrThrow({ where: { id: draft } })).workingVersionId);
        expect(await sqlError(tx, `UPDATE document_versions SET approved_at = now() WHERE id = '${dv}'`)).toMatch(/только с итоговым PDF/);
        const pdf = (await makeFileRow(tx, x.owner.id)).id;
        expect(await sqlError(tx, `UPDATE document_versions SET approved_at = now(), pdf_file_id = '${pdf}' WHERE id = '${dv}'`)).toMatch(/document_versions_approved_check/);
        expect(await sqlError(tx, `UPDATE document_versions SET stage = 24, route_state = NULL, approved_at = now(), pdf_file_id = '${pdf}', cancelled_at = now(), signed_on = '2026-10-01' WHERE id = '${dv}'`)).toMatch(/document_versions_cancelled_check/);
        expect(await sqlError(tx, `UPDATE document_versions SET stage = 7 WHERE id = '${dv}'`)).toMatch(/document_versions_stage_check/);
        expect(await sqlError(tx, `UPDATE document_versions SET route_state = 'parties' WHERE id = '${dv}'`)).toMatch(/document_versions_route_state_check/);
        expect(await sqlError(tx, `UPDATE document_versions SET order_no = '${'N'.repeat(101)}' WHERE id = '${dv}'`)).toMatch(/document_versions_order_check/);
        // Привязки файлов прежнего маршрута не удаляются и для владельца схемы.
        const f = (await docxFile(tx, x.owner)).id;
        const link = await tx.documentFile.create({ data: { documentId: draft, versionId: dv, round: 1, kind: 'draft', fileId: f, addedBy: x.owner.id } });
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
        await tx.documentVersion.update({ where: { id: vid }, data: { stage: 3, routeState: null, approvedAt: new Date() } });
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

  it('задача владельцу за 30 дней до пересмотра; повторный прогон дублей не даёт; новая дата — комментарий; утверждение закрывает', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await signAll(tx, x, id);
      const today = '2027-03-01';
      await setDue(tx, id, '2027-04-01');
      expect(await runDocumentReviews(tx, { today })).toEqual({ events: 0, tasksCreated: 0, tasksCommented: 0 });
      await setDue(tx, id, '2027-03-31');
      expect(await runDocumentReviews(tx, { today })).toEqual({ events: 1, tasksCreated: 1, tasksCommented: 0 });
      expect(await runDocumentReviews(tx, { today })).toEqual({ events: 0, tasksCreated: 0, tasksCommented: 0 });
      const task = must((await tx.task.findMany({ where: { documentId: id, documentReason: 'review' } }))[0]);
      expect(task).toMatchObject({ assigneeId: x.owner.id, source: 'document' });
      await setDue(tx, id, '2027-03-20');
      expect(await runDocumentReviews(tx, { today })).toEqual({ events: 1, tasksCreated: 0, tasksCommented: 1 });
      await svc.reviseDocument(tx, await x.as(x.owner), id, { version: (await cur(tx, id)).version });
      await setDue(tx, id, '2027-03-10');
      expect((await runDocumentReviews(tx, { today })).events).toBe(0);
      await signAll(tx, x, id);
      expect((await tx.task.findUniqueOrThrow({ where: { id: task.id } })).completedAt).not.toBeNull();
    }));

  it('цикл пересмотра меняется — дата от даты утверждения', () =>
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
  it('видят только утверждённые; маршрут, черновики и архив — нет', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const signed = await x.create('Утверждённый');
      await signAll(tx, x, signed);
      const draft = await x.create('Черновик');
      const atHead = await x.create('У начальника ИБ');
      await moveTo(tx, x, atHead, '21:head_review');
      const archived = await x.create('Архивный');
      await signAll(tx, x, archived);
      await svc.setDocumentArchived(tx, await x.as(x.admin), archived, (await cur(tx, archived)).version, true);

      const titles = async (u: User) => (await list(tx, u)).filter((d) => [signed, draft, atHead, archived].includes(d.id)).map((d) => d.title).sort();
      expect(await titles(x.legal)).toEqual(['Утверждённый']);
      await expectCode(view(tx, x.legal, draft), 'NOT_FOUND');
      await expectCode(view(tx, x.legal, atHead), 'NOT_FOUND');
      expect((await svc.listDocuments(tx, await svc.accessOf(tx, x.legal.id), { archived: true, limit: 50 })).items).toEqual([]);
      expect(await titles(x.staff)).toEqual(['У начальника ИБ', 'Утверждённый', 'Черновик']);
      await expectCode(x.create('Чужой', x.legal.id), 'BAD_OWNER');
    }));

  it('ссылка OnlyOffice — только http(s)', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      await expectCode(svc.createDocument(tx, await x.as(x.admin), { title: 'X', typeId: x.type.id, ownerId: x.owner.id, onlyofficeUrl: 'javascript:alert(1)' }), 'BAD_URL');
    }));
});

describe('документы: ответственные лица (этапы 21 и 22)', () => {
  it('на 21 — автор, срок днями; отметка и перенос срока — только с 22; при одобрении срок становится датой', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await expectCode(addParty(tx, x.staff, id), 'FORBIDDEN');
      await expectCode(addParty(tx, x.head, id), 'FORBIDDEN');
      await expectCode(addParty(tx, x.owner, id, { dueDays: 0 }), 'BAD_DUE_DAYS');
      await expectCode(addParty(tx, x.owner, id, { dueDays: 91 }), 'BAD_DUE_DAYS');
      const p1 = await addParty(tx, x.owner, id, { fullName: 'Иванов И. И.', department: 'Главный юрист', dueDays: 10 });
      // Строка до 1.4.0: e-mail и пользователь портала — показываются текстом.
      await tx.documentParty.update({ where: { id: p1.id }, data: { email: 'ivanov@example.tj', userId: x.legal.id } });
      await expectCode(parties.approveParty(tx, await x.as(x.owner), id, p1.id, await cur(tx, id)), 'WRONG_STAGE');
      await expectCode(parties.recheckParty(tx, await x.as(x.owner), id, p1.id, { ...(await cur(tx, id)), dueDate: addDaysIso(todayIso(), 3) }), 'WRONG_STAGE');
      let d = await view(tx, x.owner, id);
      expect(d.parties.map((p) => [p.fullName, p.department, p.email, p.user?.fullName, p.dueDays, p.overdue])).toEqual([['Иванов И. И.', 'Главный юрист', 'ivanov@example.tj', 'Юрист', 10, false]]);
      expect(d.can).toMatchObject({ parties: true, approveParties: false });
      await parties.updateParty(tx, await x.as(x.owner), id, p1.id, { ...(await cur(tx, id)), dueDays: 12 });
      // На проверке у начальника ИБ лиц не ведут.
      await move(tx, x.owner, id, 'submit_head');
      await expectCode(addParty(tx, x.owner, id, { fullName: 'Сидоров С. С.' }), 'WRONG_STAGE');
      await move(tx, x.head, id, 'head_approve');
      const due = addDaysIso(todayIso(), 12);
      d = await view(tx, x.owner, id);
      expect(d.parties[0]).toMatchObject({ dueDate: due, dueDays: null });
      expect(d.parties[0]?.deadlines[0]).toMatchObject({ to: due, comment: 'Срок от перехода на этап 2: 12 дн.', actor: 'Начальник ИБ' });
      expect(d.can).toMatchObject({ parties: true, approveParties: true });

      await expectCode(move(tx, x.owner, id, 'to_translation'), 'PARTIES_PENDING');
      expect((await view(tx, x.owner, id)).blockedReason).toMatch(/Не все ответственные лица согласовали: осталось 1/);
      await expectCode(parties.approveParty(tx, await x.as(x.owner), id, p1.id, { ...(await cur(tx, id)), approvedOn: '2099-01-01' }), 'BAD_DATE');
      await expectCode(parties.approveParty(tx, await x.as(x.head), id, p1.id, await cur(tx, id)), 'FORBIDDEN');
      await parties.approveParty(tx, await x.as(x.owner), id, p1.id, { ...(await cur(tx, id)), comment: 'Согласовано письмом от 05.11', approvedOn: todayIso() });
      await expectCode(parties.approveParty(tx, await x.as(x.owner), id, p1.id, await cur(tx, id)), 'PARTY_APPROVED');
      await expectCode(parties.removeParty(tx, await x.as(x.owner), id, p1.id, await cur(tx, id)), 'PARTY_APPROVED');
      d = await view(tx, x.owner, id);
      expect(d.parties[0]).toMatchObject({ approvedBy: 'Автор Документа', approveComment: 'Согласовано письмом от 05.11', approvedOn: todayIso(), files: [] });
      expect(d.can.actions).toEqual(['request_recheck', 'to_translation']);
      await move(tx, x.owner, id, 'to_translation');
      await expectCode(addParty(tx, x.owner, id), 'WRONG_STAGE');
    }));

  it('без лиц дальше этапа 22 нельзя; снять можно несогласовавшее; строки не удаляются', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      const p = await addParty(tx, x.owner, id);
      await parties.removeParty(tx, await x.as(x.owner), id, p.id, await cur(tx, id));
      await moveTo(tx, x, id, '21:head_review');
      await move(tx, x.head, id, 'head_approve');
      await expectCode(move(tx, x.owner, id, 'to_translation'), 'NO_PARTIES');
      await expectCode(move(tx, x.owner, id, 'request_recheck'), 'NO_PARTIES');
      expect((await view(tx, x.owner, id)).parties).toEqual([]);
      expect(await sqlError(tx, `DELETE FROM document_parties WHERE id = '${p.id}'`)).toMatch(/permission denied/);
    }));

  it('на 22 срок меняется только с комментарием; история сроков только пополняется; просрочка видна в реестре', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await moveTo(tx, x, id, '21:head_review');
      await move(tx, x.head, id, 'head_approve');
      const p = await addParty(tx, x.owner, id, { dueDate: '2020-01-10' });
      const patch = async (body: parties.PartyPatch) => parties.updateParty(tx, await x.as(x.owner), id, p.id, { ...(await cur(tx, id)), ...body });
      await expectCode(patch({ dueDate: '2020-01-20' }), 'EMPTY_COMMENT');
      await expectCode(patch({ dueDate: '2020-02-31', comment: 'x' }), 'BAD_DATE');
      // Почта (1.13.6) проверяется; «пользователь портала» по-прежнему не вводится.
      await expectCode(patch({ email: 'не почта' }), 'BAD_EMAIL');
      await patch({ userId: x.legal.id } as parties.PartyPatch);
      expect(await tx.documentParty.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ email: '', userId: null });
      await patch({ dueDate: '2020-01-20', comment: 'Попросили отсрочку' });
      expect((await list(tx, x.owner)).find((d) => d.id === id)).toMatchObject({ partiesDue: '2020-01-20', partiesOverdue: true });
      const d = await view(tx, x.owner, id);
      expect(d.parties[0]).toMatchObject({ dueDate: '2020-01-20', overdue: true });
      expect(d.parties[0]?.deadlines).toEqual([expect.objectContaining({ from: '2020-01-10', to: '2020-01-20', comment: 'Попросили отсрочку', actor: 'Автор Документа' })]);
      expect(await sqlError(tx, `UPDATE document_deadline_changes SET comment = 'x' WHERE party_id = '${p.id}'`)).toMatch(/permission denied/);
      expect(await sqlError(tx, `DELETE FROM document_deadline_changes WHERE party_id = '${p.id}'`)).toMatch(/permission denied/);
    }));
});

describe('документы: несколько ответственных лиц с одним сроком (1.13.5)', () => {
  const batch = async (tx: Tx, u: User, id: string, people: parties.PartiesBatchInput['people'], due: { dueDate?: string; dueDays?: number }) =>
    parties.addParties(tx, await actorFor(tx, u.id), id, { ...(await cur(tx, id)), people, ...due });
  const partyRows = (tx: Tx, id: string) => tx.documentParty.findMany({ where: { documentId: id, removedAt: null }, orderBy: { addedAt: 'asc' } });
  const addedAudit = (tx: Tx, id: string) => tx.auditLog.findMany({ where: { entity: 'document', entityId: id, action: 'document.party_added' }, orderBy: { id: 'asc' } });

  it('справочник + вручную: N строк с одним сроком, запись журнала на каждого, одна задача этапа, без уведомлений; отключённые не в выборе', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      // Справочник: трое, один отключён — в выборе для документа его нет.
      const { createPerson, updatePerson, directoryForDocument } = await import('../party-directory/service.js');
      const admin = await x.as(x.admin);
      const ivanov = (await createPerson(tx, admin, { fullName: 'Иванов И.И.', position: 'Технический директор' })).item;
      const petrova = (await createPerson(tx, admin, { fullName: 'Петрова П.П.', position: 'Главный бухгалтер' })).item;
      const off = (await createPerson(tx, admin, { fullName: 'Отключённый О.О.', position: 'Юрист' })).item;
      await updatePerson(tx, admin, off.id, { version: off.version, active: false });

      const id = await x.create('Политика тестовая');
      await moveTo(tx, x, id, '21:head_review');
      await move(tx, x.head, id, 'head_approve');
      const pick = (await directoryForDocument(tx, x.owner.id, id)).filter((p) => [ivanov.id, petrova.id, off.id].includes(p.id));
      expect(pick.map((p) => p.fullName)).toEqual(['Иванов И.И.', 'Петрова П.П.']);
      const tasksBefore = await tx.task.count({ where: { documentId: id } });
      const notesBefore = await tx.notification.count({ where: { documentId: id } });

      const due = addDaysIso(todayIso(), 10);
      await batch(tx, x.owner, id, [
        ...pick.map((p) => ({ fullName: p.fullName, department: p.position })),
        { fullName: '  Сидоров   С.С. ', department: 'Начальник службы' },
      ], { dueDate: due });
      const rows = await partyRows(tx, id);
      expect(rows.map((r) => [r.fullName, r.department, isoOf(r.dueDate), r.dueDays])).toEqual([
        ['Иванов И.И.', 'Технический директор', due, null],
        ['Петрова П.П.', 'Главный бухгалтер', due, null],
        ['Сидоров С.С.', 'Начальник службы', due, null],
      ]);
      // Журнал: на каждого — как у одного лица (кто, кого, срок), плюс место в пачке.
      const log = await addedAudit(tx, id);
      expect(log.map((a) => [a.userId, (a.diff as { after: { fullName: string; dueDate: string; batch: unknown } }).after])).toEqual(rows.map((r, i) => [
        x.owner.id, expect.objectContaining({ partyId: r.id, fullName: r.fullName, dueDate: due, batch: { size: 3, row: i + 1 } }),
      ]));
      // Одна задача этапа «Согласование» у автора — та же, что была; уведомлений о добавлении нет.
      expect(await tx.task.count({ where: { documentId: id } })).toBe(tasksBefore);
      expect(await tx.task.count({ where: { documentId: id, documentReason: 'stage', completedAt: null, archivedAt: null } })).toBe(1);
      expect(await tx.notification.count({ where: { documentId: id } })).toBe(notesBefore);

      // Дальше каждый — сам по себе: перенос срока одного не трогает остальных, напоминания — по каждому, без дублей.
      const [p1, p2, p3] = rows;
      const later = addDaysIso(due, 5);
      await parties.updateParty(tx, await x.as(x.owner), id, must(p2).id, { ...(await cur(tx, id)), dueDate: later, comment: 'Попросили отсрочку' });
      expect((await partyRows(tx, id)).map((r) => isoOf(r.dueDate))).toEqual([due, later, due]);
      await notifyPartyDeadlines(tx, new Date(`${addDaysIso(due, -1)}T06:00:00Z`));
      await notifyPartyDeadlines(tx, new Date(`${addDaysIso(due, -1)}T07:00:00Z`));
      const tomorrow = await tx.notification.findMany({ where: { documentId: id, kind: 'doc_party_due_tomorrow' } });
      expect(tomorrow.map((n) => n.title).sort()).toEqual([expect.stringContaining('Иванов И.И.'), expect.stringContaining('Сидоров С.С.')]);
      for (const p of [p1, p2, p3]) await parties.approveParty(tx, await x.as(x.owner), id, must(p).id, await cur(tx, id));
      expect((await view(tx, x.owner, id)).can.actions).toEqual(['request_recheck', 'to_translation']);
    }));

  it('дубль с уже добавленным или внутри пачки, пустое ФИО, срок — отказ всей пачке, ничего не записано; правило — ФИО + должность, «ё» = «е»', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create('Политика тестовая');
      await moveTo(tx, x, id, '21:head_review');
      await move(tx, x.head, id, 'head_approve');
      await addParty(tx, x.owner, id, { fullName: 'Иванов И.И.', department: 'Технический директор', dueDate: '2026-12-01' });
      const before = (await partyRows(tx, id)).length;
      const auditBefore = (await addedAudit(tx, id)).length;
      const due = { dueDate: '2026-12-10' };
      const fails = async (people: parties.PartiesBatchInput['people'], code: string, msg: RegExp, row?: number, d: { dueDate?: string; dueDays?: number } = due) => {
        const err = await batch(tx, x.owner, id, people, d).then(() => null, (e: unknown) => e as { code: string; message: string; details?: { row?: number } });
        expect(err, JSON.stringify(people)).not.toBeNull();
        expect([err?.code, err?.details?.row]).toEqual([code, row]);
        expect(err?.message).toMatch(msg);
        expect((await partyRows(tx, id)).length).toBe(before);
        expect((await addedAudit(tx, id)).length).toBe(auditBefore);
      };
      // С уже добавленным — без учёта регистра и лишних пробелов.
      await fails([{ fullName: 'Петров П.П.', department: 'Юрист' }, { fullName: ' иванов  и.и.', department: 'ТЕХНИЧЕСКИЙ ДИРЕКТОР' }],
        'PARTY_DUPLICATE', /^Строка 2 \(иванов и\.и\.\): .*уже есть среди ответственных лиц/, 2);
      // Внутри пачки: выбран из справочника и тот же введён вручную.
      await fails([{ fullName: 'Петров П.П.', department: 'Юрист' }, { fullName: 'Сидоров С.С.' }, { fullName: 'петров п.п.', department: ' юрист ' }],
        'PARTY_DUPLICATE', /^Строка 3 .*повторяется в списке: строки 1 и 3/, 3);
      await fails([{ fullName: 'Петров П.П.' }, { fullName: '   ', department: 'Юрист' }], 'EMPTY', /^Строка 2: Укажите ФИО/, 2);
      await fails([{ fullName: 'Петров П.П.' }, { fullName: 'Я'.repeat(parties.NAME_MAX + 1) }], 'TOO_LONG', /^Строка 2 /, 2);
      await fails([{ fullName: 'Петров П.П.' }], 'BAD_DATE', /срок ответа/, undefined, {});
      await fails([{ fullName: 'Петров П.П.' }], 'BAD_DATE', /срок ответа/, undefined, { dueDate: '2026-02-30' });
      await fails([], 'EMPTY', /хотя бы одного/);
      // «ё» и «е» — одна буква (1.13.5): и пачкой, и по одному.
      await addParty(tx, x.owner, id, { fullName: 'Королёв П.П.', department: 'Начальник отдела учёта', dueDate: '2026-12-01' });
      const auditAfterKorolev = (await addedAudit(tx, id)).length;
      await expectCode(addParty(tx, x.owner, id, { fullName: 'Королев П.П.', department: 'начальник отдела учета', dueDate: '2026-12-01' }), 'PARTY_DUPLICATE');
      const err = await batch(tx, x.owner, id, [{ fullName: 'Петров П.П.' }, { fullName: 'КОРОЛЕВ П.П.', department: 'Начальник отдела учета' }], due).then(() => null, (e: unknown) => e as { code: string; details?: { row?: number } });
      expect([err?.code, err?.details?.row]).toEqual(['PARTY_DUPLICATE', 2]);
      const err2 = await batch(tx, x.owner, id, [{ fullName: 'Сёмин С.С.', department: 'Юрист' }, { fullName: 'Семин С.С.', department: 'юрист' }], due).then(() => null, (e: unknown) => e as { code: string; message: string });
      expect([err2?.code, err2?.message]).toEqual(['PARTY_DUPLICATE', expect.stringMatching(/повторяется в списке: строки 1 и 2/)]);
      expect((await addedAudit(tx, id)).length).toBe(auditAfterKorolev);
      // Однофамилец с другой должностью — другой человек (правило 1.6.7): проходит.
      await batch(tx, x.owner, id, [{ fullName: 'Иванов И.И.', department: 'Главный бухгалтер' }], due);
      expect((await partyRows(tx, id)).length).toBe(before + 2);
    }));

  it('лимит пачки — 50; этапы — как у одного лица: драфт днями, «Согласование» датой, на проверке и после — 409; ведёт только автор', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create('Политика тестовая');
      const many = (n: number, tag: string) => Array.from({ length: n }, (_, i) => ({ fullName: `Тестов ${tag}${i + 1}`, department: 'Отдел тестовый' }));
      await expectCode(batch(tx, x.owner, id, many(parties.PARTIES_BATCH_MAX + 1, 'а'), { dueDays: 7 }), 'PARTIES_BATCH_LIMIT');
      expect(await partyRows(tx, id)).toEqual([]);
      await expectCode(batch(tx, x.staff, id, many(2, 'б'), { dueDays: 7 }), 'FORBIDDEN');
      await expectCode(batch(tx, x.owner, id, many(2, 'б'), { dueDays: 0 }), 'BAD_DUE_DAYS');
      // Драфт: срок днями — у всех одинаковый.
      await batch(tx, x.owner, id, many(parties.PARTIES_BATCH_MAX, 'в'), { dueDays: 12 });
      const rows = await partyRows(tx, id);
      expect(rows).toHaveLength(parties.PARTIES_BATCH_MAX);
      expect(new Set(rows.map((r) => `${r.dueDays}|${isoOf(r.dueDate)}`))).toEqual(new Set([`12|${addDaysIso(todayIso(), 12)}`]));
      // На проверке у начальника ИБ — нельзя; после одобрения сроки становятся датами у каждого.
      await move(tx, x.owner, id, 'submit_head');
      await expectCode(batch(tx, x.owner, id, many(1, 'г'), { dueDays: 7 }), 'WRONG_STAGE');
      await move(tx, x.head, id, 'head_approve');
      expect(new Set((await partyRows(tx, id)).map((r) => `${r.dueDays}|${isoOf(r.dueDate)}`))).toEqual(new Set([`null|${addDaysIso(todayIso(), 12)}`]));
      // «Перевод» и дальше — 409.
      await moveTo(tx, x, id, '23');
      await expectCode(batch(tx, x.owner, id, many(1, 'д'), { dueDate: '2026-12-10' }), 'WRONG_STAGE');
    }));
});

describe('документы: блокеры', () => {
  it('открывают и снимают автор, старший и начальник ИБ; открытый блокер останавливает шаги вперёд и «Утвердить», возврат — нет', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      const open = async (u: User, text: string) => parties.addBlocker(tx, await x.as(u), id, { ...(await cur(tx, id)), text });
      const resolve = async (u: User, bid: string, comment: string) => parties.resolveBlocker(tx, await x.as(u), id, bid, { ...(await cur(tx, id)), comment });
      await expectCode(open(x.staff, 'чужой'), 'FORBIDDEN');
      await expectCode(open(x.owner, '  '), 'EMPTY_COMMENT');
      await open(x.chief, 'Нет согласования с ДИКТ');
      expect((await list(tx, x.owner)).find((d) => d.id === id)?.openBlockers).toBe(1);
      await expectCode(move(tx, x.owner, id, 'submit_head'), 'BLOCKERS_OPEN');
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

      // На проверке блокер не мешает возврату.
      await moveTo(tx, x, id, '21:head_review');
      await open(x.owner, 'Ждём ДИКТ');
      await expectCode(move(tx, x.head, id, 'head_approve'), 'BLOCKERS_OPEN');
      await move(tx, x.head, id, 'head_return', { comment: 'Пока блокер — на доработку' });
      for (const ob of (await view(tx, x.owner, id)).blockers.filter((z) => !z.resolvedAt)) await resolve(x.owner, ob.id, 'снят');

      // На утверждении блокер тоже останавливает.
      await moveTo(tx, x, id, '24');
      await attachApproval(tx, x.owner, id);
      await open(x.head, 'Ждём оригинал с подписью');
      await expectCode(sign(tx, x.owner, id), 'BLOCKERS_OPEN');
      expect((await view(tx, x.owner, id)).can.sign).toBe(false);
    }));
});

describe('документы: этап 23 — перевод ссылками', () => {
  it('языки — только на 23 и только автор; ссылка OnlyOffice; 23 → 24 — когда у каждого языка есть ссылка; на 24 Word языка обязателен', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      // На 21 и 22 раздела «Перевод» нет.
      await expectCode(addTranslation(tx, x.owner, id, 'Таджикский'), 'WRONG_STAGE');
      expect((await view(tx, x.owner, id)).can.translations).toBe(false);
      await moveTo(tx, x, id, '22:parties');
      await expectCode(addTranslation(tx, x.owner, id, 'Таджикский'), 'WRONG_STAGE');
      await moveTo(tx, x, id, '23');
      expect((await view(tx, x.owner, id)).can.translations).toBe(true);
      for (const u of [x.staff, x.chief, x.head]) await expectCode(addTranslation(tx, u, id, 'Таджикский'), 'FORBIDDEN');
      await expectCode(addTranslation(tx, x.owner, id, 'Таджикский', { onlyofficeUrl: 'javascript:alert(1)' }), 'BAD_URL');
      const tj = await addTranslation(tx, x.owner, id, 'Таджикский', { translatorName: '  Калинов К. К.  ' });
      await expectCode(addTranslation(tx, x.owner, id, ' таджикский '), 'DUPLICATE');
      const en = await addTranslation(tx, x.admin, id, 'Английский', { onlyofficeUrl: URL_TJ }); // docs.manage — за автора
      await expectCode(addTranslation(tx, x.owner, id, 'Узбекский', { translatorName: 'И'.repeat(201) }), 'TOO_LONG');
      expect([tj.translatorName, tj.translatorId, en.translatorId]).toEqual(['Калинов К. К.', x.owner.id, x.admin.id]);

      await expectCode(move(tx, x.owner, id, 'to_approval'), 'TRANSLATION_LINK_MISSING');
      let d = await view(tx, x.owner, id);
      expect(d.blockedReason).toMatch(/Не у всех языков есть ссылка на перевод: Таджикский/);
      expect(d.translations.map((t) => [t.language, t.done, t.canUpload])).toEqual([['Таджикский', false, false], ['Английский', true, false]]);
      await expectCode(tr.addTranslationFiles(tx, await x.as(x.owner), id, tj.id, { ...(await cur(tx, id)), fileIds: [(await docxFile(tx, x.owner)).id] }), 'FILES_ONLY_AT_APPROVAL');
      await tr.updateTranslation(tx, await x.as(x.owner), id, tj.id, { ...(await cur(tx, id)), onlyofficeUrl: URL_TJ });
      await move(tx, x.owner, id, 'to_approval');

      // 24: Word каждого языка обязателен, PDF — по желанию; языки не меняются.
      await expectCode(tr.removeTranslation(tx, await x.as(x.owner), id, en.id, await cur(tx, id)), 'WRONG_STAGE');
      await setFile(tx, x.owner, id, 'pdf', (await pdfFile(tx, x.owner)).id);
      await setFile(tx, x.owner, id, 'docx', (await docxFile(tx, x.owner)).id);
      await setFile(tx, x.owner, id, 'translation_docx', (await docxFile(tx, x.owner, 'tj.docx')).id, tj.id);
      await expectCode(sign(tx, x.owner, id), 'APPROVAL_FILES_REQUIRED');
      expect((await view(tx, x.owner, id)).blockedReason).toBe('Загрузите: Word перевода (Английский)');
      await expectCode(setFile(tx, x.owner, id, 'translation_docx', (await pdfFile(tx, x.owner)).id, en.id), 'BAD_FILE_TYPE');
      await setFile(tx, x.owner, id, 'translation_docx', (await docxFile(tx, x.owner, 'en.docx')).id, en.id);
      d = await view(tx, x.owner, id);
      expect(d.translations.map((t) => [t.language, t.docx?.name, t.pdf])).toEqual([['Таджикский', 'tj.docx', null], ['Английский', 'en.docx', null]]);
      await sign(tx, x.owner, id);
      expect((await view(tx, x.owner, id)).status).toBe('approved');
    }));

  it('строку снимают на этапе 23; снятая не участвует в проверке 23 → 24; срок — с комментарием', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await moveTo(tx, x, id, '23');
      const t = await addTranslation(tx, x.owner, id, 'Таджикский', { translatorName: 'Калинов К.', dueDate: '2020-01-10' });
      expect(must((await view(tx, x.owner, id)).translations[0]).overdue).toBe(true);
      const patch = async (body: { dueDate?: string; comment?: string; translatorName?: string }) =>
        tr.updateTranslation(tx, await x.as(x.owner), id, t.id, { ...(await cur(tx, id)), ...body });
      await expectCode(patch({ dueDate: '2020-01-20' }), 'EMPTY_COMMENT');
      await patch({ dueDate: '2020-01-20', comment: 'Переводчик в отпуске', translatorName: 'Ромашова Р.' });
      const after = must((await view(tx, x.owner, id)).translations[0]);
      expect(after).toMatchObject({ dueDate: '2020-01-20', translatorName: 'Ромашова Р.' });
      expect(after.deadlines).toEqual([expect.objectContaining({ from: '2020-01-10', to: '2020-01-20', comment: 'Переводчик в отпуске' })]);
      await expectCode(move(tx, x.owner, id, 'to_approval'), 'TRANSLATION_LINK_MISSING');
      await tr.removeTranslation(tx, await x.as(x.owner), id, t.id, await cur(tx, id));
      expect((await view(tx, x.owner, id)).translations).toEqual([]);
      await move(tx, x.owner, id, 'to_approval');
      expect(await sqlError(tx, `DELETE FROM document_translations WHERE id = '${t.id}'`)).toMatch(/permission denied/);
    }));
});

describe('документы: уведомления', () => {
  const inbox = async (tx: Tx, u: User, id: string) =>
    (await tx.notification.findMany({ where: { userId: u.id, documentId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).map((n) => `${n.kind}: ${n.title}`);

  it('начальнику ИБ — проверка и повторная проверка; автору — возврат и комментарий; о своих действиях — нет; ссылка ведёт на документ', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create('Политика ИБ');
      await svc.addDocumentComment(tx, await x.as(x.staff), id, { body: 'Нет срока в п. 4' });
      await svc.addDocumentComment(tx, await x.as(x.owner), id, { body: 'Добавил' });
      await moveTo(tx, x, id, '21:head_review');
      await move(tx, x.head, id, 'head_return', { comment: 'Уточнить раздел 3' });
      expect(await inbox(tx, x.owner, id)).toEqual([
        expect.stringMatching(/^doc_commented: Комментарий к документу #\d+ «Политика ИБ»$/),
        expect.stringMatching(/^doc_returned: Документ #\d+ «Политика ИБ» вернули на доработку$/),
      ]);
      expect(await inbox(tx, x.head, id)).toEqual([expect.stringMatching(/^doc_waiting: /)]);
      expect(await inbox(tx, x.staff, id)).toEqual([]);

      await moveTo(tx, x, id, '22:parties');
      await approveParties(tx, x, id);
      // Все лица согласовали — начальнику ИБ больше ничего не приходит (1.11.0).
      expect(await inbox(tx, x.head, id)).toHaveLength(2);
      await move(tx, x.owner, id, 'request_recheck');
      expect(await inbox(tx, x.head, id)).toHaveLength(3);
      await move(tx, x.head, id, 'head_reapprove');
      await moveTo(tx, x, id, '24');
      // 23 и 24 — у автора, он сам ведёт документ: «ждёт вас» себе не приходит.
      expect((await inbox(tx, x.owner, id)).filter((n) => n.startsWith('doc_waiting'))).toEqual([]);
      const items = (await listNotifications(tx, x.head.id, {})).items;
      expect(items.find((n) => n.kind === 'doc_waiting')?.link).toBe(`/documents?doc=${id}`);
    }));

  it('«ждёт вас» — один раз на состояние: блокер открыли и сняли — не повторяется; новый круг — снова; держатель роли без отметки — нет', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const roleOnly = await makeUser(tx, ['ib_staff', 'ib_head'], { fullName: 'Роль без отметки' });
      const id = await x.create('Политика ИБ');
      await moveTo(tx, x, id, '21:head_review');
      const waiting = async () => (await inbox(tx, x.head, id)).filter((n) => n.startsWith('doc_waiting'));
      expect(await waiting()).toHaveLength(1);
      expect(await inbox(tx, roleOnly, id)).toEqual([]);
      await parties.addBlocker(tx, await x.as(x.owner), id, { ...(await cur(tx, id)), text: 'Ждём ДИКТ' });
      const b = must((await view(tx, x.head, id)).blockers[0]);
      await parties.resolveBlocker(tx, await x.as(x.chief), id, b.id, { ...(await cur(tx, id)), comment: 'Ответили' });
      await svc.notifyWaiting(tx, id, x.chief.id);
      expect(await waiting()).toHaveLength(1);
      await move(tx, x.head, id, 'head_return', { comment: 'Уточнить раздел 3' });
      await moveTo(tx, x, id, '21:head_review');
      expect(await waiting()).toHaveLength(2);
      // Свой документ начальник ИБ отправляет на проверку сам — себе уведомления нет.
      const own = await x.create('Свой', x.head.id);
      await move(tx, x.head, own, 'submit_head');
      expect(await inbox(tx, x.head, own)).toEqual([]);
    }));

  it('сменили срок лица — автору; срок лица завтра и просрочен — автору, без дублей; на этапе 21 сроки не идут', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create('Регламент');
      await addParty(tx, x.owner, id, { fullName: 'Сидоров С. С.', dueDays: 1 });
      const at = (iso: string) => new Date(`${iso}T06:00:00Z`);
      // На этапе 21 предварительная дата не напоминает (решение владельца 11).
      await notifyPartyDeadlines(tx, at(addDaysIso(todayIso(), 5)));
      expect(await inbox(tx, x.owner, id)).toEqual([]);

      await moveTo(tx, x, id, '21:head_review');
      await move(tx, x.head, id, 'head_approve');
      const p = await addParty(tx, x.owner, id, { dueDate: '2026-11-10' });
      // Перенёс другой пользователь (docs.manage) — автору уведомление.
      await parties.updateParty(tx, await x.as(x.admin), id, p.id, { ...(await cur(tx, id)), dueDate: '2026-11-15', comment: 'Отсрочка' });
      expect((await inbox(tx, x.owner, id)).filter((m) => m.startsWith('doc_deadline_changed'))).toEqual([
        expect.stringMatching(/срок ответа Петров П\. П\. перенесён с 10\.11\.2026 на 15\.11\.2026$/),
      ]);
      const sid = (await tx.documentParty.findFirstOrThrow({ where: { documentId: id, fullName: 'Сидоров С. С.' } })).id;
      await parties.approveParty(tx, await x.as(x.owner), id, sid, await cur(tx, id));

      await notifyPartyDeadlines(tx, at('2026-11-14'));
      expect((await inbox(tx, x.owner, id)).at(-1)).toMatch(/^doc_party_due_tomorrow: .*срок ответа Петров П\. П\. — завтра, 15\.11\.2026$/);
      await notifyPartyDeadlines(tx, at('2026-11-14'));
      await notifyPartyDeadlines(tx, at('2026-11-17'));
      await notifyPartyDeadlines(tx, at('2026-11-18'));
      const mine = await inbox(tx, x.owner, id);
      expect(mine.filter((m) => m.startsWith('doc_party_due_tomorrow'))).toHaveLength(1);
      expect(mine.filter((m) => m.startsWith('doc_party_overdue'))).toEqual([expect.stringMatching(/Петров П\. П\. не ответил\(а\) в срок \(15\.11\.2026\)/)]);
      await svc.setDocumentArchived(tx, await x.as(x.admin), id, (await cur(tx, id)).version, true);
      await tx.documentParty.update({ where: { id: p.id }, data: { dueDate: new Date('2026-11-16T00:00:00Z') } });
      await notifyPartyDeadlines(tx, at('2026-11-20'));
      expect(await inbox(tx, x.owner, id)).toHaveLength(mine.length);
    }));
});

describe('документы: сроки переводов (1.11.0)', () => {
  it('«срок перевода завтра» и «просрочен» — автору, по одному на язык и срок; со ссылкой, на другом этапе и в архиве — нет', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create('Регламент');
      await moveTo(tx, x, id, '23');
      await addTranslation(tx, x.owner, id, 'Таджикский', { dueDate: '2026-11-15' });
      await addTranslation(tx, x.owner, id, 'Английский', { dueDate: '2026-11-15', onlyofficeUrl: URL_TJ });
      const at = (iso: string) => new Date(`${iso}T06:00:00Z`);
      const inbox = async () => (await tx.notification.findMany({ where: { userId: x.owner.id, documentId: id, kind: { startsWith: 'doc_translation' } }, orderBy: { createdAt: 'asc' } }))
        .map((n) => `${n.kind}: ${n.title}`);
      expect(await notifyTranslationDeadlines(tx, at('2026-11-14'))).toEqual({ dueTomorrow: 1, overdue: 0 });
      expect(await inbox()).toEqual([expect.stringMatching(/^doc_translation_due_tomorrow: .*срок перевода на Таджикский — завтра, 15\.11\.2026$/)]);
      await notifyTranslationDeadlines(tx, at('2026-11-14'));
      await notifyTranslationDeadlines(tx, at('2026-11-17'));
      await notifyTranslationDeadlines(tx, at('2026-11-18'));
      expect((await inbox()).map((n) => n.split(':')[0])).toEqual(['doc_translation_due_tomorrow', 'doc_translation_overdue']);
      expect((await inbox()).at(-1)).toMatch(/перевод на Таджикский не готов в срок \(15\.11\.2026\)/);
      expect((await listNotifications(tx, x.owner.id, {})).items.find((n) => n.kind === 'doc_translation_overdue')?.link).toBe(`/documents?doc=${id}`);
      // Дошли до утверждения — напоминаний больше нет, даже если строка осталась без ссылки.
      const t = await tx.documentTranslation.findFirstOrThrow({ where: { documentId: id, language: 'Таджикский' } });
      await tr.updateTranslation(tx, await x.as(x.owner), id, t.id, { ...(await cur(tx, id)), onlyofficeUrl: URL_TJ, dueDate: '2026-11-25', comment: 'Новый срок' });
      expect(await notifyTranslationDeadlines(tx, at('2026-11-30'))).toEqual({ dueTomorrow: 0, overdue: 0 });
    }));
});

describe('«Сейчас у» и «ждут вас» — одна функция (маршрут 1.11.0)', () => {
  const nowAt = async (tx: Tx, x: Fx, id: string) => {
    const item = must((await list(tx, x.staff)).find((d) => d.id === id));
    return { names: item.holders?.people.map((p) => p.fullName) ?? null, missingHead: item.holders?.missingHead ?? null };
  };
  const sameCount = async (tx: Tx, u: User) => {
    const n = (await svc.documentSummary(tx, await svc.accessOf(tx, u.id))).waitingForMe;
    expect(n).toBe((await list(tx, u)).filter((d) => d.waitingForMe).length);
    return n;
  };

  it('по местам маршрута: автор, кроме двух проверок у начальника ИБ; старшие не держат; пройденные — кто и когда', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      expect(await nowAt(tx, x, id)).toEqual({ names: ['Автор Документа'], missingHead: false });
      expect([await sameCount(tx, x.owner), await sameCount(tx, x.chief)]).toEqual([1, 0]);
      await moveTo(tx, x, id, '21:head_review');
      expect((await nowAt(tx, x, id)).names).toEqual(['Начальник ИБ']);
      expect([await sameCount(tx, x.head), await sameCount(tx, x.owner)]).toEqual([1, 0]);
      // Открытый блокер шаг вперёд останавливает, но документ по-прежнему у начальника ИБ.
      await parties.addBlocker(tx, await x.as(x.owner), id, { ...(await cur(tx, id)), text: 'Ждём ДИКТ' });
      expect(await sameCount(tx, x.head)).toBe(1);
      const b = must((await view(tx, x.head, id)).blockers[0]);
      await parties.resolveBlocker(tx, await x.as(x.head), id, b.id, { ...(await cur(tx, id)), comment: 'ДИКТ ответил' });
      await moveTo(tx, x, id, '22:parties');
      expect((await nowAt(tx, x, id)).names).toEqual(['Автор Документа']);
      await moveTo(tx, x, id, '23');
      expect([await sameCount(tx, x.head), await sameCount(tx, x.chief), await sameCount(tx, x.owner)]).toEqual([0, 0, 1]);
      await moveTo(tx, x, id, '24');
      expect((await nowAt(tx, x, id)).names).toEqual(['Автор Документа']);

      const card = await view(tx, x.staff, id);
      const byStage = new Map(card.route.map((r) => [r.stage, r]));
      expect(byStage.get(21)).toMatchObject({ state: 'done', actedBy: 'Начальник ИБ' });
      expect(byStage.get(21)?.actedAt).not.toBeNull();
      expect(byStage.get(24)).toMatchObject({ state: 'current', approvers: ['Автор Документа'], actedBy: null });
    }));

  it('отметка «Начальник ИБ» никому не стоит: «на проверке» — «Начальник ИБ не назначен»; документ не ждёт никого', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await moveTo(tx, x, id, '21:head_review');
      await tx.user.update({ where: { id: x.head.id }, data: { isIbHead: false } });
      expect(await nowAt(tx, x, id)).toEqual({ names: [], missingHead: true });
      const card = await view(tx, x.staff, id);
      expect(card.holders).toEqual({ people: [], missingHead: true });
      expect(card.route.find((r) => r.stage === 21)).toMatchObject({ approvers: [], missingHead: true });
      expect(await sameCount(tx, x.head)).toBe(0);
    }));

  it('отключённый автор остаётся в «Сейчас у» с пометкой inactive и в маршруте — «(отключён)»', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const id = await x.create();
      await tx.user.update({ where: { id: x.owner.id }, data: { isActive: false } });
      const item = must((await list(tx, x.staff)).find((d) => d.id === id));
      expect(item.holders?.people).toEqual([{ id: x.owner.id, fullName: 'Автор Документа', inactive: true }]);
      expect((await view(tx, x.staff, id)).route.find((r) => r.stage === 21)?.approvers).toEqual(['Автор Документа (отключён)']);
    }));

  it('видимость не считается — читатель без права действия видит утверждённую версию, но цифра 0', () =>
    inTx(async (tx) => {
      const x = await fixture(tx);
      const signed = await x.create('Утверждённая политика');
      await signAll(tx, x, signed);
      await svc.reviseDocument(tx, await x.as(x.owner), signed, { version: (await cur(tx, signed)).version, edition: '2.0' });
      await moveTo(tx, x, signed, '21:head_review');
      expect((await list(tx, x.legal)).find((d) => d.id === signed)).toMatchObject({ waitingForMe: false, holders: null });
      expect(await sameCount(tx, x.legal)).toBe(0);
    }));
});
