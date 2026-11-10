import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { ErrorResponse } from '../../plugins/errors.js';
import { requireAuth, requirePerm } from '../../plugins/rbac.js';
import { actorOf } from '../settings/common.js';
import * as parties from './parties.js';
import * as svc from './service.js';
import { exportApproved } from './export.js';
import * as controls from './controls.js';
import * as automations from './automations.js';
import * as translations from './translations.js';
import { DOC_ACTIONS, DOC_DUE_FILTERS, DOC_SORTS, DOC_STATUSES, ROUTE_STATES } from './status.js';

const tags = ['documents'];
const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse };
const IdParams = z.object({ id: z.string().uuid() });
const Version = z.object({ version: z.number().int().positive() });

const Person = z.object({ id: z.string(), fullName: z.string() });
const Status = z.enum(DOC_STATUSES);
const DocItem = z.object({
  id: z.string(),
  number: z.number().int(),
  title: z.string(),
  /** «Редакция» для отображения, например «3.1». */
  edition: z.string(),
  /** Номер показанной версии (1, 2, 3…). */
  versionNo: z.number().int(),
  type: z.object({ id: z.string(), value: z.string() }),
  owner: Person,
  approvedVersionNo: z.number().int().nullable(),
  approvedAt: z.string().nullable(),
  /** Дата подписания действующей версии (маршрут 1.2.0); null — утверждена до 1.2.0 или не подписана. */
  signedOn: z.string().nullable(),
  /** Реестр утверждённых (1.11.0): редакция и номер приказа действующей версии; есть ли рабочая версия (на пересмотре). */
  approvedEdition: z.string().nullable(),
  approvedOrderNo: z.string(),
  onReview: z.boolean(),
  /** Активных механизмов контроля (сотрудникам ИБ). */
  controlsActive: z.number().int(),
  /** Активных автоматизаций контроля (сотрудникам ИБ). */
  automationsActive: z.number().int(),
  reviewMonths: z.number().int(),
  reviewDue: z.string().nullable(),
  status: Status,
  statusName: z.string(),
  stage: z.number().int().nullable(),
  stageName: z.string().nullable(),
  waitingForMe: z.boolean(),
  /** «Сейчас у» (1.4.0): кто действует на текущем этапе; missingHead — этап начальника ИБ, отметка никому не стоит. */
  holders: z.object({ people: z.array(z.object({ id: z.string(), fullName: z.string(), inactive: z.boolean().optional() })), missingHead: z.boolean() }).nullable(),
  /** Этап 14: ближайший срок несогласовавшего ответственного лица и просрочка (сотрудникам ИБ). */
  partiesDue: z.string().nullable(),
  partiesOverdue: z.boolean(),
  openBlockers: z.number().int(),
  archived: z.boolean(),
  version: z.number().int(),
});
/** Итоговый PDF версии (этап 7): файл в хранилище портала, sha256 — в истории каждого решения. */
const Pdf = z.object({ id: z.string(), name: z.string(), sha256: z.string(), size: z.number().int() });
const FileRef = z.object({ id: z.string(), name: z.string(), sha256: z.string(), size: z.number().int(), mime: z.string() });
const Version_ = z.object({
  id: z.string(), no: z.number().int(), edition: z.string(), title: z.string(), onlyofficeUrl: z.string(), changeNote: z.string(),
  stage: z.number().int(), stageName: z.string(), round: z.number().int(), approvedAt: z.string().nullable(), createdAt: z.string(),
  /** Маршрут 1.11.0: состояние внутри этапа и «Этап — состояние» для показа. */
  state: z.enum(ROUTE_STATES).nullable(), placeName: z.string(),
  signedOn: z.string().nullable(),
  /** Этап 24: исходный документ Word и приказ об утверждении. */
  docx: Pdf.nullable(), orderNo: z.string(), orderDate: z.string().nullable(),
  /** Пересмотр отменён: версия в истории, действующей осталась подписанная. */
  cancelledAt: z.string().nullable(),
  pdf: Pdf.nullable(),
  /** false у утверждённой версии без PDF (утверждена до этапа 7): «текст не зафиксирован». */
  textFrozen: z.boolean(),
});
const DocDetail = DocItem.extend({
  current: Version_,
  working: Version_.nullable(),
  approved: Version_.nullable(),
  route: z.array(z.object({
    stage: z.number().int(), name: z.string(), state: z.enum(['done', 'current', 'todo']),
    /** Состояние внутри текущего этапа: «На проверке у начальника ИБ», «На повторной проверке». */
    place: z.string().nullable(),
    /** Кто действует на этапе (та же функция, что «Сейчас у»); missingHead — «Начальник ИБ не назначен». */
    approvers: z.array(z.string()), missingHead: z.boolean(), hint: z.string(), actedBy: z.string().nullable(), actedAt: z.string().nullable(),
    /** Этап не требуется (старый маршрут: согласовать мог только владелец): причина. */
    skipped: z.string().nullable(),
    /** Свой документ одобрил начальник ИБ — без независимого согласования. */
    selfApproved: z.boolean(),
  })),
  can: z.object({
    edit: z.boolean(),
    actions: z.array(z.enum(DOC_ACTIONS)),
    sign: z.boolean(),
    /** Этап 24: загрузить PDF и .docx (основной язык и переводы). */
    approvalFiles: z.boolean(),
    draftFiles: z.boolean(),
    comment: z.boolean(),
    revise: z.boolean(),
    cancelRevision: z.boolean(),
    delete: z.boolean(),
    parties: z.boolean(),
    approveParties: z.boolean(),
    blockers: z.boolean(),
    translations: z.boolean(),
    manage: z.boolean(),
  }),
  blockedReason: z.string().nullable(),
  /** Показанную версию вернули на доработку, и с тех пор её не отправляли: кто, когда, с какого этапа, замечание. Видят все, кто видит документ. */
  returned: z.object({
    at: z.string(), actor: z.string(), stageName: z.string(), comment: z.string(),
    /** Записка к возврату (1.4.0), если приложена. */
    file: z.object({ id: z.string(), name: z.string(), sha256: z.string(), size: z.number().int(), mime: z.string() }).nullable(),
  }).nullable(),
  /** Файлы прежнего маршрута (до 1.11.0): драфт, одобренная начальником ИБ, финальная — только просмотр. */
  files: z.array(z.object({
    id: z.string(), kind: z.enum(['draft', 'head_approved', 'final']), kindName: z.string(),
    /** Все отметки файла (1.4.0): файл автора, согласованный начальником ИБ, — одна строка с двумя отметками. */
    marks: z.array(z.string()), round: z.number().int(),
    file: z.object({ id: z.string(), name: z.string(), sha256: z.string(), size: z.number().int(), mime: z.string() }),
    addedBy: z.string(), addedAt: z.string(), removable: z.boolean(),
  })),
  /** Комментарии сотрудников ИБ к показанной версии (любой этап). */
  comments: z.array(z.object({ id: z.string(), author: z.string(), body: z.string(), at: z.string() })),
  /** Ответственные лица этапа 22 (сотрудникам ИБ): внешние. email и user — только у строк до 1.4.0, показываются текстом. */
  parties: z.array(z.object({
    id: z.string(), fullName: z.string(), department: z.string(), email: z.string(), user: Person.nullable(), dueDate: z.string(), overdue: z.boolean(),
    /** Срок на этапе 1 — дней от перехода на этап 2; на этапе 2 — null (срок датой). */
    dueDays: z.number().int().nullable(),
    approvedAt: z.string().nullable(), approvedBy: z.string().nullable(), approveComment: z.string(),
    /** Дата согласования, указанная автором; «до доработки от <дата>»; история «Запросить повторно». */
    approvedOn: z.string().nullable(), reworkedAt: z.string().nullable(),
    rechecks: z.array(z.object({
      prevApprovedOn: z.string().nullable(), prevApprovedAt: z.string(), reworkedAt: z.string().nullable(),
      fromDue: z.string(), toDue: z.string(), comment: z.string(), actor: z.string(), at: z.string(),
    })),
    files: z.array(z.object({ id: z.string(), file: z.object({ id: z.string(), name: z.string(), sha256: z.string(), size: z.number().int(), mime: z.string() }) })),
    /** История сроков: было, стало, комментарий. */
    deadlines: z.array(z.object({ from: z.string(), to: z.string(), comment: z.string(), actor: z.string(), at: z.string() })),
  })),
  /** Переводы этапа 23 (сотрудникам ИБ): язык, имя переводчика текстом, срок, ссылка OnlyOffice; готов, когда есть ссылка. */
  translations: z.array(z.object({
    id: z.string(), language: z.string(), translatorName: z.string(), dueDate: z.string(), done: z.boolean(), overdue: z.boolean(),
    onlyofficeUrl: z.string(),
    /** Этап 24: Word перевода (обязателен) и подписанный PDF (по желанию). */
    docx: FileRef.nullable(), pdf: FileRef.nullable(),
    files: z.array(z.object({ id: z.string(), file: z.object({ id: z.string(), name: z.string(), sha256: z.string(), size: z.number().int(), mime: z.string() }) })),
    deadlines: z.array(z.object({ from: z.string(), to: z.string(), comment: z.string(), actor: z.string(), at: z.string() })),
    canUpload: z.boolean(),
  })),
  blockers: z.array(z.object({
    id: z.string(), text: z.string(), openedBy: z.string(), openedAt: z.string(),
    resolvedAt: z.string().nullable(), resolvedBy: z.string().nullable(), resolveComment: z.string(),
  })),
  versions: z.array(z.object({
    no: z.number().int(), edition: z.string(), title: z.string(), onlyofficeUrl: z.string(), approvedAt: z.string().nullable(), changeNote: z.string(),
    signedOn: z.string().nullable(), cancelledAt: z.string().nullable(),
    pdf: Pdf.nullable(), textFrozen: z.boolean(),
    docx: Pdf.nullable(), orderNo: z.string(), orderDate: z.string().nullable(),
  })),
  history: z.array(z.object({
    id: z.string(), at: z.string(), actor: z.string(), stage: z.number().int(), stageName: z.string(),
    toStage: z.number().int().nullable(), toStageName: z.string().nullable(),
    decision: z.enum(svc.HISTORY_DECISIONS), comment: z.string(), versionNo: z.number().int(), round: z.number().int(),
    /** Точный вид решения маршрута 1.11.0; у прежних решений — null. */
    event: z.string().nullable(),
    /** sha256 файла решения: PDF (до 1.2.0), файл версии (13 → 14, 14 → 15), подписанный PDF (16). */
    pdfSha256: z.string().nullable(),
    selfApproved: z.boolean(),
  })),
});
type DetailOut = z.infer<typeof DocDetail>;
/** Ответ действий: карточка после изменения или null, если документ вам больше не виден (вернули на доработку). */
const Result = z.object({ document: DocDetail.nullable() });

// Раздел «Документы» открыт всем вошедшим (и без ib.work). Кто что видит и может — решает сервис:
// автор — владелец или docs.manage, старший над автором, начальник ИБ — отметка «Является начальником ИБ» (1.4.0, ADR-0027).
const anyUser = requireAuth();

export const documentRoutes: FastifyPluginAsyncZod<{ db: Db; docUrlPrefix?: string }> = async (app, { db, docUrlPrefix = '' }) => {
  const policy: svc.DocPolicy = { urlPrefix: docUrlPrefix };
  const access = (request: Parameters<typeof actorOf>[0]) => svc.accessOf(db, actorOf(request).id);
  const detail = async (request: Parameters<typeof actorOf>[0], id: string) =>
    (await svc.getDocument(db, await access(request), id)) as DetailOut;
  const result = async (request: Parameters<typeof actorOf>[0], id: string) => ({
    document: await detail(request, id).catch((err: unknown) => {
      if ((err as { statusCode?: number }).statusCode === 404) return null;
      throw err;
    }),
  });

  app.get('/documents', {
    preHandler: anyUser,
    schema: {
      tags, summary: 'Реестр документов. Без ib.work — утверждённые, «ждёт вас» и согласованные вами в текущем круге. Фильтры: тип, автор, срок пересмотра; sort — по типам или по алфавиту',
      querystring: z.object({
        archived: z.enum(['true', 'false']).optional(),
        status: Status.optional(),
        typeId: z.string().uuid().optional(),
        ownerId: z.string().uuid().optional(),
        due: z.enum(DOC_DUE_FILTERS).optional(),
        dueTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        q: z.string().max(200).optional(),
        waiting: z.enum(['me']).optional(),
        review: z.enum(['due']).optional(),
        sort: z.enum(DOC_SORTS).optional(),
        view: z.enum(svc.DOC_VIEWS).optional(),
        stage: z.coerce.number().int().min(21).max(24).optional(),
        onReview: z.enum(['true']).optional(),
        limit: z.coerce.number().int().min(1).max(svc.LIST_LIMIT).default(200),
        cursor: z.string().max(20).optional(),
      }),
      response: {
        200: z.object({
          items: z.array(DocItem), nextCursor: z.string().nullable(), total: z.number().int(), archivedTotal: z.number().int(),
          /** Значения фильтров «Автор» и «Тип» из видимых документов (без учёта других фильтров). */
          facets: z.object({ owners: z.array(z.object({ id: z.string(), fullName: z.string() })), types: z.array(z.object({ id: z.string(), value: z.string() })) }),
        }),
        ...errors,
      },
    },
  }, async (request) => {
    const q = request.query;
    return svc.listDocuments(db, await access(request), {
      archived: q.archived === 'true', status: q.status, typeId: q.typeId, ownerId: q.ownerId, due: q.due, dueTo: q.dueTo, q: q.q,
      waiting: q.waiting === 'me', review: q.review === 'due', sort: q.sort, limit: q.limit, cursor: q.cursor,
      view: q.view, stage: q.stage, onReview: q.onReview === 'true',
    });
  });

  app.get('/documents/approved.xlsx', {
    preHandler: anyUser,
    schema: {
      tags, summary: 'Реестр утверждённых документов в Excel (1.11.0): те же фильтры, что у списка «Утверждённые»; выгрузка — в журнал',
      querystring: z.object({
        typeId: z.string().uuid().optional(),
        ownerId: z.string().uuid().optional(),
        due: z.enum(DOC_DUE_FILTERS).optional(),
        dueTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        q: z.string().max(200).optional(),
        onReview: z.enum(['true']).optional(),
        sort: z.enum(DOC_SORTS).optional(),
      }),
    },
  }, async (request, reply) => {
    const q = request.query;
    const { fileName, buffer } = await exportApproved(db, actorOf(request), await access(request), {
      typeId: q.typeId, ownerId: q.ownerId, due: q.due, dueTo: q.dueTo, q: q.q, onReview: q.onReview === 'true', sort: q.sort,
    });
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="documents-approved.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName)}`)
      .header('Cache-Control', 'no-store')
      .send(buffer);
  });

  app.get('/documents/summary', {
    preHandler: anyUser,
    schema: {
      tags, summary: 'Счётчик в меню: ждут вас; просроченный пересмотр (только с ib.work)',
      response: { 200: z.object({ waitingForMe: z.number().int(), reviewOverdue: z.number().int() }), ...errors },
    },
  }, async (request) => svc.documentSummary(db, await access(request)));

  app.post('/documents', {
    preHandler: requirePerm('docs.manage'),
    schema: {
      tags, summary: 'Новый документ: версия 1 на этапе «Драфт»',
      body: z.object({
        title: z.string().max(svc.TITLE_MAX),
        typeId: z.string().uuid(),
        ownerId: z.string().uuid(),
        onlyofficeUrl: z.string().max(svc.URL_MAX),
        edition: z.string().max(svc.EDITION_MAX).optional(),
        changeNote: z.string().max(svc.NOTE_MAX).optional(),
        reviewMonths: z.number().int().min(1).max(60).optional(),
      }),
      response: { 201: Result, ...errors },
    },
  }, async (request, reply) => {
    const id = await svc.createDocument(db, actorOf(request), request.body, policy);
    return reply.status(201).send(await result(request, id));
  });

  app.get('/documents/:id', {
    preHandler: anyUser,
    schema: { tags, summary: 'Карточка: версии, маршрут и кто может согласовать этапы, история согласования', params: IdParams, response: { 200: DocDetail, ...errors } },
  }, async (request) => detail(request, request.params.id));

  app.patch('/documents/:id', {
    preHandler: anyUser,
    schema: {
      tags,
      summary: 'Правка: содержимое черновика — владелец или docs.manage; тип, владелец, цикл — docs.manage. Нужна version; 409 — документ изменили',
      params: IdParams,
      body: Version.extend({
        title: z.string().max(svc.TITLE_MAX).optional(),
        edition: z.string().max(svc.EDITION_MAX).optional(),
        onlyofficeUrl: z.string().max(svc.URL_MAX).optional(),
        changeNote: z.string().max(svc.NOTE_MAX).optional(),
        typeId: z.string().uuid().optional(),
        ownerId: z.string().uuid().optional(),
        reviewMonths: z.number().int().min(1).max(60).optional(),
      }),
      response: { 200: Result, ...errors },
    },
  }, async (request) => {
    await svc.updateDocument(db, actorOf(request), request.params.id, request.body, policy);
    return result(request, request.params.id);
  });

  const Stage = z.number().int().min(0).max(24);
  app.post('/documents/:id/actions/:action', {
    preHandler: anyUser,
    schema: {
      tags,
      summary: 'Действие маршрута (ADR-0042): submit_head 21→«на проверке», head_approve →22, head_return →21 (комментарий), '
        + 'request_recheck 22→«повторная проверка», to_translation 22→23 (confirmUnchanged), head_reapprove →23, recheck_return →22 (комментарий), '
        + 'to_approval 23→24. 403 — не ваша роль; 409 — документ уже в другом месте маршрута; файлы — 409 FILES_ONLY_AT_APPROVAL',
      params: IdParams.extend({ action: z.enum(DOC_ACTIONS) }),
      body: Version.extend({
        stage: Stage,
        comment: z.string().max(svc.COMMENT_MAX).optional(),
        /** to_translation: «Документ не изменялся после проверки начальником ИБ». */
        confirmUnchanged: z.boolean().optional(),
        /** До 1.11.0 — файл версии; теперь — 409 FILES_ONLY_AT_APPROVAL. */
        fileId: z.string().uuid().optional(),
      }),
      response: { 200: Result, ...errors },
    },
  }, async (request) => {
    await svc.moveDocument(db, actorOf(request), request.params.id, request.params.action, request.body);
    return result(request, request.params.id);
  });

  app.post('/documents/:id/sign', {
    preHandler: anyUser,
    schema: {
      tags, summary: 'Этап 24 «Утвердить» (автор или начальник ИБ): нужны PDF и .docx основного языка и .docx каждого перевода (409 APPROVAL_FILES_REQUIRED). Пересмотр — от даты утверждения',
      params: IdParams,
      body: Version.extend({
        stage: Stage, signedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        orderNo: z.string().max(100).optional(), orderDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      }),
      response: { 200: Result, ...errors },
    },
  }, async (request) => {
    await svc.signDocument(db, actorOf(request), request.params.id, request.body);
    return result(request, request.params.id);
  });

  app.post('/documents/:id/approval-files', {
    preHandler: anyUser,
    schema: {
      tags, summary: 'Этап 24: файл утверждения — pdf (подписанный PDF), docx (исходный Word), translation_docx, translation_pdf (с translationId); fileId null — снять. Тип — по содержимому',
      params: IdParams,
      body: Version.extend({
        stage: Stage, slot: z.enum(['pdf', 'docx', 'translation_docx', 'translation_pdf']), translationId: z.string().uuid().optional(),
        fileId: z.string().uuid().nullable(),
      }),
      response: { 200: Result, ...errors },
    },
  }, async (request) => {
    await svc.setApprovalFile(db, actorOf(request), request.params.id, request.body);
    return result(request, request.params.id);
  });

  app.post('/documents/:id/cancel-revision', {
    preHandler: anyUser,
    schema: {
      tags, summary: 'Отменить пересмотр (автор или начальник ИБ, с комментарием): версия — в историю, действующей остаётся подписанная',
      params: IdParams,
      body: Version.extend({ comment: z.string().max(svc.COMMENT_MAX) }),
      response: { 200: Result, ...errors },
    },
  }, async (request) => {
    await svc.cancelRevision(db, actorOf(request), request.params.id, request.body);
    return result(request, request.params.id);
  });

  app.post('/documents/:id/files', {
    preHandler: anyUser,
    schema: {
      tags, summary: 'Файлы драфта — до 1.11.0; теперь 409 FILES_ONLY_AT_APPROVAL (файлы — только на этапе 24, /approval-files)',
      params: IdParams,
      body: Version.extend({ stage: Stage, fileIds: z.array(z.string().uuid()).min(1).max(20) }),
      response: { 200: Result, ...errors },
    },
  }, async (request) => {
    await svc.addDraftFiles(db, actorOf(request), request.params.id, request.body);
    return result(request, request.params.id);
  });

  app.post('/documents/:id/files/:linkId/remove', {
    preHandler: anyUser,
    schema: {
      tags, summary: 'Снять файл драфта — до 1.11.0; теперь 409 FILES_ONLY_AT_APPROVAL',
      params: IdParams.extend({ linkId: z.string().uuid() }),
      body: Version.extend({ stage: Stage }),
      response: { 200: Result, ...errors },
    },
  }, async (request) => {
    await svc.removeDraftFile(db, actorOf(request), request.params.id, request.params.linkId, request.body);
    return result(request, request.params.id);
  });

  app.post('/documents/:id/comments', {
    preHandler: requirePerm('ib.work'),
    schema: {
      tags, summary: 'Комментарий сотрудника ИБ к документу в работе (любой этап)',
      params: IdParams,
      body: z.object({ body: z.string().max(svc.COMMENT_MAX) }),
      response: { 200: Result, ...errors },
    },
  }, async (request) => {
    await svc.addDocumentComment(db, actorOf(request), request.params.id, request.body);
    return result(request, request.params.id);
  });

  const PartyBody = {
    fullName: z.string().max(parties.NAME_MAX),
    department: z.string().max(parties.DEPARTMENT_MAX).optional(),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    /** Этап 21: срок ответа днями от перехода на этап 22 (1–90). */
    dueDays: z.number().int().min(1).max(90).optional(),
  };
  const PartyParams = IdParams.extend({ partyId: z.string().uuid() });
  const At = Version.extend({ stage: Stage });

  app.post('/documents/:id/parties', {
    preHandler: anyUser,
    schema: { tags, summary: 'Ответственное лицо (автор): этап 21 — срок днями (dueDays), этап 22 — датой (dueDate)', params: IdParams, body: At.extend(PartyBody), response: { 200: Result, ...errors } },
  }, async (request) => {
    await parties.addParty(db, actorOf(request), request.params.id, request.body);
    return result(request, request.params.id);
  });

  app.post('/documents/:id/parties/batch', {
    preHandler: anyUser,
    schema: {
      tags,
      summary: 'Несколько ответственных лиц с одним сроком (1.13.5): одной транзакцией — все или никто; ошибка строки — «Строка N (ФИО): …», details.row; не больше 50',
      params: IdParams,
      body: At.extend({
        // Верхняя граница схемы с запасом: понятный текст о лимите (PARTIES_BATCH_LIMIT) даёт сервис.
        people: z.array(z.object({ fullName: PartyBody.fullName, department: PartyBody.department })).max(500),
        dueDate: PartyBody.dueDate,
        dueDays: PartyBody.dueDays,
      }),
      response: { 200: Result, ...errors },
    },
  }, async (request) => {
    await parties.addParties(db, actorOf(request), request.params.id, request.body);
    return result(request, request.params.id);
  });

  app.patch('/documents/:id/parties/:partyId', {
    preHandler: anyUser,
    schema: {
      tags, summary: 'Правка ответственного лица; смена срока — только с комментарием (история сроков)', params: PartyParams,
      body: At.extend({ ...PartyBody, fullName: PartyBody.fullName.optional(), comment: z.string().max(svc.COMMENT_MAX).optional() }),
      response: { 200: Result, ...errors },
    },
  }, async (request) => {
    await parties.updateParty(db, actorOf(request), request.params.id, request.params.partyId, request.body);
    return result(request, request.params.id);
  });

  app.post('/documents/:id/parties/:partyId/remove', {
    preHandler: anyUser,
    schema: { tags, summary: 'Снять ответственное лицо, которое ещё не согласовало', params: PartyParams, body: At, response: { 200: Result, ...errors } },
  }, async (request) => {
    await parties.removeParty(db, actorOf(request), request.params.id, request.params.partyId, request.body);
    return result(request, request.params.id);
  });

  app.post('/documents/:id/parties/:partyId/approve', {
    preHandler: anyUser,
    schema: {
      tags, summary: 'Этап 22: отметить согласование лица — дата согласования и, по желанию, комментарий; без файла (fileIds — 409)', params: PartyParams,
      body: At.extend({
        comment: z.string().max(svc.COMMENT_MAX).optional(), approvedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        fileIds: z.array(z.string().uuid()).max(20).optional(),
      }),
      response: { 200: Result, ...errors },
    },
  }, async (request) => {
    await parties.approveParty(db, actorOf(request), request.params.id, request.params.partyId, request.body);
    return result(request, request.params.id);
  });

  app.post('/documents/:id/parties/:partyId/recheck', {
    preHandler: anyUser,
    schema: {
      tags, summary: 'Этап 22: «Запросить повторно» — отметка лица снимается, новый срок, запись в историю', params: PartyParams,
      body: At.extend({ dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), comment: z.string().max(svc.COMMENT_MAX).optional() }),
      response: { 200: Result, ...errors },
    },
  }, async (request) => {
    await parties.recheckParty(db, actorOf(request), request.params.id, request.params.partyId, request.body);
    return result(request, request.params.id);
  });

  app.post('/documents/:id/parties/:partyId/files', {
    preHandler: anyUser,
    schema: { tags, summary: 'Приложить ответ ответственного лица (файлы)', params: PartyParams, body: At.extend({ fileIds: z.array(z.string().uuid()).min(1).max(20) }), response: { 200: Result, ...errors } },
  }, async (request) => {
    await parties.addResponseFiles(db, actorOf(request), request.params.id, request.params.partyId, request.body);
    return result(request, request.params.id);
  });

  app.post('/documents/:id/responses/:linkId/remove', {
    preHandler: anyUser,
    schema: { tags, summary: 'Снять файл ответа ответственного лица', params: IdParams.extend({ linkId: z.string().uuid() }), body: At, response: { 200: Result, ...errors } },
  }, async (request) => {
    await parties.removeResponseFile(db, actorOf(request), request.params.id, request.params.linkId, request.body);
    return result(request, request.params.id);
  });

  const TrParams = IdParams.extend({ translationId: z.string().uuid() });
  app.post('/documents/:id/translations', {
    preHandler: anyUser,
    schema: {
      tags, summary: 'Этап 23: строка перевода — язык, имя переводчика текстом (необязательно), срок, ссылка OnlyOffice; ведёт автор, только на этапе 23',
      params: IdParams,
      body: At.extend({
        language: z.string().max(translations.LANGUAGE_MAX), translatorName: z.string().max(translations.TRANSLATOR_NAME_MAX).optional(),
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), onlyofficeUrl: z.string().max(svc.URL_MAX).optional(),
      }),
      response: { 200: Result, ...errors },
    },
  }, async (request) => {
    await translations.addTranslation(db, actorOf(request), request.params.id, request.body, policy);
    return result(request, request.params.id);
  });

  app.patch('/documents/:id/translations/:translationId', {
    preHandler: anyUser,
    schema: {
      tags, summary: 'Правка перевода; смена срока — только с комментарием (история сроков)', params: TrParams,
      body: At.extend({
        language: z.string().max(translations.LANGUAGE_MAX).optional(), translatorName: z.string().max(translations.TRANSLATOR_NAME_MAX).optional(),
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), comment: z.string().max(svc.COMMENT_MAX).optional(),
        onlyofficeUrl: z.string().max(svc.URL_MAX).optional(),
      }),
      response: { 200: Result, ...errors },
    },
  }, async (request) => {
    await translations.updateTranslation(db, actorOf(request), request.params.id, request.params.translationId, request.body, policy);
    return result(request, request.params.id);
  });

  app.post('/documents/:id/translations/:translationId/remove', {
    preHandler: anyUser,
    schema: { tags, summary: 'Снять язык без файла перевода', params: TrParams, body: At, response: { 200: Result, ...errors } },
  }, async (request) => {
    await translations.removeTranslation(db, actorOf(request), request.params.id, request.params.translationId, request.body);
    return result(request, request.params.id);
  });

  app.post('/documents/:id/translations/:translationId/files', {
    preHandler: anyUser,
    schema: {
      tags, summary: 'Файл перевода — до 1.11.0; теперь 409 FILES_ONLY_AT_APPROVAL (Word и PDF перевода — /approval-files на этапе 24)', params: TrParams,
      body: At.extend({ fileIds: z.array(z.string().uuid()).min(1).max(20) }), response: { 200: Result, ...errors },
    },
  }, async (request) => {
    await translations.addTranslationFiles(db, actorOf(request), request.params.id, request.params.translationId, request.body);
    return result(request, request.params.id);
  });

  app.post('/documents/:id/translations/:translationId/files/:linkId/remove', {
    preHandler: anyUser,
    schema: { tags, summary: 'Снять файл перевода', params: TrParams.extend({ linkId: z.string().uuid() }), body: At, response: { 200: Result, ...errors } },
  }, async (request) => {
    await translations.removeTranslationFile(db, actorOf(request), request.params.id, request.params.translationId, request.params.linkId, request.body);
    return result(request, request.params.id);
  });

  // ---------------------------------------------------------------- механизмы контроля (1.11.0, ADR-0043)
  const ControlFields = z.object({
    clause: z.string().max(controls.CONTROL_LIMITS.clause).optional(),
    requirement: z.string().max(controls.CONTROL_LIMITS.requirement).optional(),
    mechanism: z.string().max(controls.CONTROL_LIMITS.mechanism).optional(),
    checkMethod: z.string().max(controls.CONTROL_LIMITS.checkMethod).optional(),
    expectedEvidence: z.string().max(controls.CONTROL_LIMITS.expectedEvidence).optional(),
    executorUnit: z.string().max(controls.CONTROL_LIMITS.executorUnit).optional(),
  });
  const ControlOut = z.object({
    id: z.string(), position: z.number().int(), clause: z.string(), requirement: z.string(), mechanism: z.string(), checkMethod: z.string(),
    expectedEvidence: z.string(), executorUnit: z.string(), active: z.boolean(), version: z.number().int(), creator: z.string(),
    createdAt: z.string(), updatedAt: z.string(),
  });
  const ib = requirePerm('ib.work');

  app.get('/documents/:id/controls', {
    preHandler: ib,
    schema: {
      tags, summary: 'Механизмы контроля утверждённого документа (сотрудники ИБ); canManage — владелец, начальник ИБ, docs.manage', params: IdParams,
      response: { 200: z.object({ items: z.array(ControlOut), canManage: z.boolean() }), ...errors },
    },
  }, async (request) => controls.listControls(db, actorOf(request), request.params.id));

  app.post('/documents/:id/controls', {
    preHandler: ib,
    schema: {
      tags, summary: 'Добавить механизм контроля (владелец, начальник ИБ, docs.manage); требование и механизм обязательны', params: IdParams,
      body: ControlFields, response: { 200: z.object({ item: ControlOut }), ...errors },
    },
  }, async (request) => ({ item: await controls.createControl(db, actorOf(request), request.params.id, request.body) }));

  app.patch('/documents/:id/controls/:controlId', {
    preHandler: ib,
    schema: {
      tags, summary: 'Изменить или отключить механизм контроля (version; чужая — 409). Физически не удаляется', params: IdParams.extend({ controlId: z.string().uuid() }),
      body: ControlFields.extend({ version: z.number().int().positive(), active: z.boolean().optional() }), response: { 200: z.object({ item: ControlOut }), ...errors },
    },
  }, async (request) => ({ item: await controls.updateControl(db, actorOf(request), request.params.id, request.params.controlId, request.body) }));

  // ---------------------------------------------------------------- автоматизации механизмов контроля (1.11.0, ADR-0043)
  const AutomationFields = z.object({
    title: z.string().max(300),
    description: z.string().max(4000).optional(),
    controlId: z.string().uuid().nullable().optional(),
    cadence: automations.ControlCadenceSchema,
    startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    dueDays: z.number().int().min(1).max(365),
    dueKind: z.enum(['calendar', 'working']),
    assigneeId: z.string().uuid(),
    active: z.boolean().optional(),
  });
  const RunOut = z.object({
    nominalDate: z.string(), plannedDate: z.string(), status: z.enum(['created', 'skipped_late', 'no_assignee', 'doc_archived']), at: z.string(),
    task: z.object({ id: z.string(), number: z.number().int(), status: z.string(), completed: z.boolean(), archived: z.boolean() }).nullable(),
  });
  const AutomationOut = z.object({
    id: z.string(), title: z.string(), description: z.string(), cadence: automations.ControlCadenceSchema, cadenceLabel: z.string(), startsOn: z.string(),
    dueDays: z.number().int(), dueKind: z.enum(['calendar', 'working']), assignee: z.object({ id: z.string(), fullName: z.string() }),
    control: z.object({ id: z.string(), position: z.number().int(), requirement: z.string() }).nullable(), active: z.boolean(), version: z.number().int(),
    noAssignee: z.boolean(), next: z.object({ nominal: z.string(), planned: z.string() }).nullable(), runs: z.array(RunOut),
  });
  const AutomationParams = IdParams.extend({ automationId: z.string().uuid() });

  app.get('/documents/:id/automations', {
    preHandler: ib,
    schema: {
      tags, summary: 'Автоматизации механизмов контроля утверждённого документа: следующий запуск, история запусков (сотрудники ИБ)', params: IdParams,
      response: { 200: z.object({ items: z.array(AutomationOut), canManage: z.boolean() }), ...errors },
    },
  }, async (request) => automations.listAutomations(db, actorOf(request), request.params.id));

  app.post('/documents/:id/automations', {
    preHandler: ib,
    schema: {
      tags, summary: 'Добавить автоматизацию (владелец, начальник ИБ, docs.manage); ответственный — активный сотрудник ИБ', params: IdParams,
      body: AutomationFields, response: { 200: z.object({ item: AutomationOut }), ...errors },
    },
  }, async (request) => ({ item: await automations.createAutomation(db, actorOf(request), request.params.id, request.body) }));

  app.patch('/documents/:id/automations/:automationId', {
    preHandler: ib,
    schema: {
      tags, summary: 'Изменить, отключить или включить автоматизацию (version; чужая — 409). Не удаляется', params: AutomationParams,
      body: AutomationFields.partial().extend({ version: z.number().int().positive() }), response: { 200: z.object({ item: AutomationOut }), ...errors },
    },
  }, async (request) => ({ item: await automations.updateAutomation(db, actorOf(request), request.params.id, request.params.automationId, request.body) }));

  app.post('/documents/:id/automations/:automationId/run', {
    preHandler: ib,
    schema: {
      tags, summary: '«Проверить сейчас»: прогон автоматизации — запуски на сегодня и пропущенные (до 7 дней) создаются, повтор — без дублей', params: AutomationParams,
      response: { 200: z.object({ ran: z.boolean(), today: z.string(), created: z.number().int(), skipped: z.number().int(), noAssignee: z.number().int() }), ...errors },
    },
  }, async (request) => {
    const r = await automations.runAutomationNow(db, actorOf(request), request.params.id, request.params.automationId);
    return { ran: r.ran, today: r.today, created: r.created, skipped: r.skipped, noAssignee: r.noAssignee };
  });

  app.post('/documents/:id/blockers', {
    preHandler: anyUser,
    schema: {
      tags, summary: 'Открыть блокер (автор, старший над автором, начальник ИБ): останавливает шаги вперёд', params: IdParams,
      body: At.extend({ text: z.string().max(parties.BLOCKER_MAX) }), response: { 200: Result, ...errors },
    },
  }, async (request) => {
    await parties.addBlocker(db, actorOf(request), request.params.id, request.body);
    return result(request, request.params.id);
  });

  app.post('/documents/:id/blockers/:blockerId/resolve', {
    preHandler: anyUser,
    schema: {
      tags, summary: 'Снять блокер — с комментарием', params: IdParams.extend({ blockerId: z.string().uuid() }),
      body: At.extend({ comment: z.string().max(svc.COMMENT_MAX) }), response: { 200: Result, ...errors },
    },
  }, async (request) => {
    await parties.resolveBlocker(db, actorOf(request), request.params.id, request.params.blockerId, request.body);
    return result(request, request.params.id);
  });

  app.post('/documents/:id/delete', {
    preHandler: requirePerm('docs.delete'),
    schema: {
      tags, summary: 'Мягкое удаление документа без подписанной версии (docs.delete); подписанный — только в архив (409)',
      params: IdParams,
      body: Version.extend({ comment: z.string().max(svc.COMMENT_MAX).optional() }),
      response: { 200: Result, ...errors },
    },
  }, async (request) => {
    await svc.deleteDocument(db, actorOf(request), request.params.id, request.body);
    return result(request, request.params.id);
  });

  app.post('/documents/:id/revise', {
    preHandler: anyUser,
    schema: {
      tags, summary: 'Новая версия подписанного документа (правка или пересмотр без изменений): владелец или docs.manage',
      params: IdParams,
      body: Version.extend({
        title: z.string().max(svc.TITLE_MAX).optional(),
        edition: z.string().max(svc.EDITION_MAX).optional(),
        onlyofficeUrl: z.string().max(svc.URL_MAX).optional(),
        changeNote: z.string().max(svc.NOTE_MAX).optional(),
      }),
      response: { 200: Result, ...errors },
    },
  }, async (request) => {
    await svc.reviseDocument(db, actorOf(request), request.params.id, request.body, policy);
    return result(request, request.params.id);
  });

  for (const [path, archived, summary] of [['archive', true, 'В архив'], ['restore', false, 'Вернуть из архива']] as const) {
    app.post(`/documents/:id/${path}`, {
      preHandler: requirePerm('docs.manage'),
      schema: { tags, summary, params: IdParams, body: Version, response: { 200: Result, ...errors } },
    }, async (request) => {
      await svc.setDocumentArchived(db, actorOf(request), request.params.id, request.body.version, archived);
      return result(request, request.params.id);
    });
  }
};
