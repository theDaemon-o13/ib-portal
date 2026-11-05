// Маршруты учебных писем (1.9.0, ADR-0039; docs/specs/awareness.md, разделы 13–14, 21). Все — ib.work; утвердить и
// вернуть — пользователь с отметкой «Является начальником ИБ» (проверяет flow.ts). Модуль вне группы open (app.ts):
// служебной учётной записи — 403 SERVICE_ACCOUNT.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { ErrorResponse } from '../../plugins/errors.js';
import { requirePerm } from '../../plugins/rbac.js';
import { actorOf } from '../settings/common.js';
import { LETTER_KINDS, LETTER_STATUSES, COMMENT_MAX, AUDIENCE_MAX } from './flow.js';
import * as letters from './letters.service.js';

const tags = ['awareness-letters'];
const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 413: ErrorResponse };
const IdParams = z.object({ id: z.string().uuid() });
const Version = z.object({ version: z.number().int().positive() });
const Person = z.object({ id: z.string(), fullName: z.string() });
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате ГГГГ-ММ-ДД');

/** Письмо целиком с изображениями (data:) — до лимита maxLetterKb (не больше 20 МБ) плюс запас на JSON. */
export const LETTER_BODY_LIMIT = 24 * 1024 * 1024;

const Content = z.object({ subjectRu: z.string(), subjectTj: z.string(), htmlRu: z.string(), htmlTj: z.string() });
const ContentInput = z.object({
  subjectRu: z.string().max(10_000),
  subjectTj: z.string().max(10_000),
  htmlRu: z.string().max(LETTER_BODY_LIMIT),
  htmlTj: z.string().max(LETTER_BODY_LIMIT),
});
const Kind = z.enum(LETTER_KINDS);
const Status = z.enum(LETTER_STATUSES);
const LangMark = z.enum(['only_ru', 'only_tj']).nullable();

export const LetterItem = z.object({
  id: z.string(),
  number: z.number().int(),
  title: z.string(),
  kind: Kind,
  reason: z.string(),
  status: Status,
  frozen: z.boolean(),
  archived: z.boolean(),
  archivedAt: z.string().nullable(),
  /** «только RU» / «только TJ» — срочное письмо с одним языком. */
  langMark: LangMark,
  versionNo: z.number().int().nullable(),
  template: z.object({ id: z.string(), title: z.string() }).nullable(),
  task: z.object({ id: z.string(), number: z.number().int(), title: z.string() }).nullable(),
  createdBy: Person,
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number().int(),
});

const VersionReason = z.enum(['created', 'edit', 'restore', 'template', 'copy', 'sent']);
const EventAction = z.enum(['submitted', 'withdrawn', 'approved', 'returned', 'approval_dropped', 'sent', 'archived', 'unarchived']);
const Action = z.enum(['save', 'submit', 'withdraw', 'approve', 'return', 'send', 'send_without_approval', 'resend', 'restore', 'copy', 'archive', 'unarchive']);

export const LetterDetail = LetterItem.extend({
  content: Content,
  /** Размер HTML обоих языков с изображениями; warn — от warnLetterKb («каждая из 1500+ копий ляжет на сервер»). */
  size: z.object({
    bytes: z.number().int(), warn: z.boolean(),
    limits: z.object({ maxImageKb: z.number().int(), maxLetterKb: z.number().int(), warnLetterKb: z.number().int() }),
  }),
  approvedVersionNo: z.number().int().nullable(),
  sentVersionNo: z.number().int().nullable(),
  latestIsApproved: z.boolean(),
  /** Утвердил автор-начальник ИБ — «без независимого согласования». */
  selfApproved: z.boolean(),
  sentWithoutApproval: z.boolean(),
  versions: z.array(z.object({
    no: z.number().int(), reason: VersionReason, restoredFrom: z.number().int().nullable(), createdBy: Person, createdAt: z.string(),
  })),
  events: z.array(z.object({
    id: z.string(), action: EventAction, at: z.string(), actor: Person, versionNo: z.number().int().nullable(), comment: z.string(),
    selfApproved: z.boolean(), withoutApproval: z.boolean(), sentOn: z.string().nullable(), audience: z.string().nullable(),
    task: z.object({ id: z.string(), number: z.number().int() }).nullable(),
    record: z.object({ id: z.string(), number: z.number().int(), registerId: z.string() }).nullable(),
  })),
  /** Кнопки для текущего пользователя (подсказка интерфейсу; решает backend). */
  actions: z.array(Action),
});

const SaveResult = z.object({ letter: LetterDetail, versionCreated: z.boolean(), removed: z.array(z.string()) });

export const letterRoutes: FastifyPluginAsyncZod<{ db: Db; portalUrl: string }> = async (app, { db, portalUrl }) => {
  const work = requirePerm('ib.work');
  const deps: letters.LetterDeps = { portalUrl };

  app.get('/awareness/letters', {
    preHandler: work,
    schema: {
      tags, summary: 'Учебные письма: новые сверху; фильтры — архив, статус, тип, поиск по названию и номеру',
      querystring: z.object({
        scope: z.enum(['active', 'archived', 'all']).default('active'),
        status: Status.optional(),
        kind: Kind.optional(),
        q: z.string().max(300).optional(),
        limit: z.coerce.number().int().min(1).max(letters.LETTER_LIST_LIMIT).default(50),
        cursor: z.string().max(20).optional(),
      }),
      response: { 200: z.object({ items: z.array(LetterItem), nextCursor: z.string().nullable(), total: z.number().int() }), ...errors },
    },
  }, async (request) => letters.listLetters(db, request.query));

  app.post('/awareness/letters', {
    preHandler: work,
    bodyLimit: LETTER_BODY_LIMIT,
    schema: {
      tags, summary: 'Новое письмо — черновик, версия 1. Срочному нужен повод (400 REASON_REQUIRED)',
      body: ContentInput.partial().extend({ title: z.string().max(1000), kind: Kind, reason: z.string().max(10_000).optional() }),
      response: { 201: SaveResult, ...errors },
    },
  }, async (request, reply) => reply.status(201).send(await letters.createLetter(db, actorOf(request), request.body, deps)));

  app.get('/awareness/letters/:id', {
    preHandler: work,
    schema: { tags, summary: 'Карточка письма: текущая версия, версии, события, кнопки', params: IdParams, response: { 200: LetterDetail, ...errors } },
  }, async (request) => letters.getLetter(db, actorOf(request).id, request.params.id));

  app.put('/awareness/letters/:id', {
    preHandler: work,
    bodyLimit: LETTER_BODY_LIMIT,
    schema: {
      tags,
      summary: 'Сохранить: новая версия, если изменились тема или текст (без изменений — версии нет). Утверждённое — только с '
        + 'confirmDropApproval (иначе 409 APPROVAL_DROP_CONFIRM), утверждение снимается. На согласовании — 409 LETTER_STATE, '
        + 'отправленное — 409 LETTER_FROZEN. Санитизация; ссылка на портал — 400 PORTAL_LINK; размер — 413',
      params: IdParams,
      body: ContentInput.merge(Version).extend({
        title: z.string().max(1000).optional(),
        kind: Kind.optional(),
        reason: z.string().max(10_000).optional(),
        confirmDropApproval: z.boolean().optional(),
      }),
      response: { 200: SaveResult, ...errors },
    },
  }, async (request) => letters.saveLetter(db, actorOf(request), request.params.id, request.body, deps));

  app.get('/awareness/letters/:id/versions/:no', {
    preHandler: work,
    schema: {
      tags, summary: 'Версия письма — только чтение', params: z.object({ id: z.string().uuid(), no: z.coerce.number().int().positive() }),
      response: {
        200: z.object({ no: z.number().int(), reason: VersionReason, restoredFrom: z.number().int().nullable(), createdBy: Person, createdAt: z.string(), content: Content }),
        ...errors,
      },
    },
  }, async (request) => letters.getVersion(db, request.params.id, request.params.no));

  app.post('/awareness/letters/:id/versions/:no/restore', {
    preHandler: work,
    schema: {
      tags, summary: '«Восстановить версию N»: новая версия с её содержимым. В утверждённом — с confirmDropApproval',
      params: z.object({ id: z.string().uuid(), no: z.coerce.number().int().positive() }),
      body: Version.extend({ confirmDropApproval: z.boolean().optional() }),
      response: { 200: LetterDetail, ...errors },
    },
  }, async (request) => letters.restoreVersion(db, actorOf(request), request.params.id, { ...request.body, no: request.params.no }));

  app.post('/awareness/letters/:id/submit', {
    preHandler: work,
    schema: {
      tags, summary: 'На согласование: языки (400 LANG_REQUIRED), без {{…}} (400 UNFILLED_VARIABLES)',
      params: IdParams, body: Version, response: { 200: LetterDetail, ...errors },
    },
  }, async (request) => letters.submitLetter(db, actorOf(request), request.params.id, request.body));

  app.post('/awareness/letters/:id/withdraw', {
    preHandler: work,
    schema: { tags, summary: 'Отозвать с согласования: отправивший или автор', params: IdParams, body: Version, response: { 200: LetterDetail, ...errors } },
  }, async (request) => letters.withdrawLetter(db, actorOf(request), request.params.id, request.body));

  app.post('/awareness/letters/:id/approve', {
    preHandler: work,
    schema: {
      tags, summary: 'Утвердить: отметка «Является начальником ИБ» (403 NOT_IB_HEAD). Своё письмо — «без независимого согласования»',
      params: IdParams, body: Version.extend({ comment: z.string().max(COMMENT_MAX).optional() }), response: { 200: LetterDetail, ...errors },
    },
  }, async (request) => letters.approveLetter(db, actorOf(request), request.params.id, request.body));

  app.post('/awareness/letters/:id/return', {
    preHandler: work,
    schema: {
      tags, summary: 'Вернуть на доработку: начальник ИБ, комментарий обязателен',
      params: IdParams, body: Version.extend({ comment: z.string().max(COMMENT_MAX * 2) }), response: { 200: LetterDetail, ...errors },
    },
  }, async (request) => letters.returnLetter(db, actorOf(request), request.params.id, request.body));

  app.post('/awareness/letters/:id/send', {
    preHandler: work,
    schema: {
      tags,
      summary: '«Отметить отправленным»: дата (не позже сегодня) и аудитория. Утверждённое — если последняя версия утверждена; '
        + 'срочное без согласования — с комментарием-причиной. Первая отметка создаёт версию sent и замораживает письмо; '
        + 'повторная — новая дата и аудитория, текст не меняется',
      params: IdParams,
      body: Version.extend({ sentOn: IsoDate, audience: z.string().max(AUDIENCE_MAX * 2), comment: z.string().max(COMMENT_MAX * 2).optional() }),
      response: { 200: LetterDetail, ...errors },
    },
  }, async (request) => letters.sendLetter(db, actorOf(request), request.params.id, request.body, deps));

  app.post('/awareness/letters/:id/copy', {
    preHandler: work,
    schema: {
      tags, summary: 'Создать копию — новый черновик с содержимым последней версии, тем же типом и поводом; без задачи и событий',
      params: IdParams, response: { 201: LetterDetail, ...errors },
    },
  }, async (request, reply) => reply.status(201).send(await letters.copyLetter(db, actorOf(request), request.params.id)));

  app.post('/awareness/letters/:id/archive', {
    preHandler: work,
    schema: { tags, summary: 'В архив (в том числе отправленное)', params: IdParams, body: Version, response: { 200: LetterDetail, ...errors } },
  }, async (request) => letters.archiveLetter(db, actorOf(request), request.params.id, { version: request.body.version, archived: true }));

  app.post('/awareness/letters/:id/unarchive', {
    preHandler: work,
    schema: { tags, summary: 'Вернуть из архива', params: IdParams, body: Version, response: { 200: LetterDetail, ...errors } },
  }, async (request) => letters.archiveLetter(db, actorOf(request), request.params.id, { version: request.body.version, archived: false }));
};
