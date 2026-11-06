// Маршруты учебных писем (1.9.0, ADR-0039; docs/specs/awareness.md, разделы 13–14, 21). Все — ib.work; утвердить и
// вернуть — пользователь с отметкой «Является начальником ИБ» (проверяет flow.ts). Шаблоны — ib.work; «Подпись ИБ»
// читает ib.work (редактор и предпросмотр), правит settings.manage и ib.work. Модуль вне группы open (app.ts):
// служебной учётной записи — 403 SERVICE_ACCOUNT.
import type { FastifyReply } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { ErrorResponse } from '../../plugins/errors.js';
import { requireAllPerms, requirePerm } from '../../plugins/rbac.js';
import { actorOf } from '../settings/common.js';
import { LETTER_KINDS, LETTER_STATUSES, COMMENT_MAX, AUDIENCE_MAX } from './flow.js';
import * as letters from './letters.service.js';
import * as templates from './templates.service.js';
import * as exporter from './export.service.js';
import * as rules from './rules.service.js';
import { checkRuleNow } from './schedule.service.js';
import { letterRefs } from './mailings.js';
import { audienceSuggestions, AUDIENCE_LIMIT } from './audiences.js';
import { CadenceSchema, LEAD_DAYS } from './cadence.js';
import type { FileStore } from '../../lib/file-store.js';
import { fileDisposition } from './export/eml.js';
import * as layout from './layout.service.js';
import { PREVIEW_CSP, putPreview, takePreview } from './preview-store.js';
import { notFound } from '../../lib/errors.js';

const tags = ['awareness-letters'];
const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 413: ErrorResponse };
const IdParams = z.object({ id: z.string().uuid() });
const Version = z.object({ version: z.number().int().positive() });
const Person = z.object({ id: z.string(), fullName: z.string() });
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате ГГГГ-ММ-ДД');

/** Письмо целиком с изображениями (data:) — до лимита maxLetterKb (не больше 20 МБ) плюс запас на JSON. */
export const LETTER_BODY_LIMIT = 24 * 1024 * 1024;

/** Шапка письма (1.12.0): «Заголовок» и «Метка» языка, «Тема общая» — простой текст, пусто — по умолчанию. */
const Head = z.object({ headerRu: z.string(), headerTj: z.string(), labelRu: z.string(), labelTj: z.string(), subjectBoth: z.string() });
const Content = z.object({ subjectRu: z.string(), subjectTj: z.string(), htmlRu: z.string(), htmlTj: z.string() }).merge(Head);
const HeadInput = z.object({
  headerRu: z.string().max(10_000).optional(),
  headerTj: z.string().max(10_000).optional(),
  labelRu: z.string().max(10_000).optional(),
  labelTj: z.string().max(10_000).optional(),
  subjectBoth: z.string().max(10_000).optional(),
});
const ContentInput = z.object({
  subjectRu: z.string().max(10_000),
  subjectTj: z.string().max(10_000),
  htmlRu: z.string().max(LETTER_BODY_LIMIT),
  htmlTj: z.string().max(LETTER_BODY_LIMIT),
}).merge(HeadInput);
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
  exportLangs: z.array(z.enum(['ru', 'tj', 'both'])),
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
    /** Отметка «Отправлено» (1.12.0): языки, получатели, файл письма. */
    langs: z.enum(['ru', 'tj', 'both']).nullable(),
    recipients: z.string().nullable(),
    file: z.object({ id: z.string(), name: z.string(), sha256: z.string() }).nullable(),
  })),
  /** Кнопки для текущего пользователя (подсказка интерфейсу; решает backend). */
  actions: z.array(Action),
});

/** warnings — «Не вставлено изображений: N…» (картинки по ссылке вырезаны санитайзером). */
const SaveResult = z.object({ letter: LetterDetail, versionCreated: z.boolean(), removed: z.array(z.string()), warnings: z.array(z.string()) });

const Variable = z.object({ key: z.string(), label: z.string() });
const Limits = z.object({ maxImageKb: z.number().int(), maxLetterKb: z.number().int(), warnLetterKb: z.number().int() });
export const TemplateItem = z.object({
  id: z.string(),
  title: z.string(),
  subjectRu: z.string(),
  subjectTj: z.string(),
  /** Переменные {{…}} из тем и текстов, без служебной {{подпись}} — поля формы «Письмо из шаблона». */
  variables: z.array(Variable),
  archived: z.boolean(),
  archivedAt: z.string().nullable(),
  rules: z.number().int(),
  /** «Больше текущего лимита» (лимиты уменьшили после сохранения): текст с размерами; null — укладывается. */
  tooLarge: z.string().nullable(),
  createdBy: Person,
  createdAt: z.string(),
  updatedBy: Person,
  updatedAt: z.string(),
  version: z.number().int(),
});
export const TemplateDetail = TemplateItem.extend({
  content: Content,
  size: z.object({ bytes: z.number().int(), warn: z.boolean(), limits: Limits }),
});
const TemplateSave = z.object({ template: TemplateDetail, removed: z.array(z.string()), warnings: z.array(z.string()) });
const TemplateInput = ContentInput.extend({ title: z.string().max(1000) });
export const Signature = z.object({
  htmlRu: z.string(), htmlTj: z.string(), version: z.number().int(),
  updatedBy: Person.nullable(), updatedAt: z.string().nullable(), canEdit: z.boolean(),
});

export const letterRoutes: FastifyPluginAsyncZod<{ db: Db; portalUrl: string; store?: FileStore }> = async (app, { db, portalUrl, store }) => {
  const work = requirePerm('ib.work');
  const deps: letters.LetterDeps = { portalUrl, store };

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
      tags, summary: 'Вернуть на доработку: начальник ИБ, комментарий обязателен; задача «Доработать письмо» — исполнителю задачи письма или автору',
      params: IdParams, body: Version.extend({ comment: z.string().max(COMMENT_MAX * 2) }), response: { 200: LetterDetail, ...errors },
    },
  }, async (request) => letters.returnLetter(db, actorOf(request), request.params.id, request.body, deps));

  app.post('/awareness/letters/:id/send', {
    preHandler: work,
    schema: {
      tags,
      summary: '«Отметить отправленным»: дата (не позже сегодня и не раньше утверждения), аудитория, языки, получатели, файл письма. Утверждённое — если последняя версия утверждена; '
        + 'срочное без согласования — с комментарием-причиной. Первая отметка создаёт версию sent и замораживает письмо; '
        + 'повторная — новая дата и аудитория, текст не меняется',
      params: IdParams,
      body: Version.extend({
        sentOn: IsoDate, audience: z.string().max(AUDIENCE_MAX * 2), comment: z.string().max(COMMENT_MAX * 2).optional(),
        /** 1.12.0: языки (по умолчанию — последней выгрузки), получатели, выгрузка (нет — последняя с этими языками или собрать). */
        langs: z.enum(['ru', 'tj', 'both']).optional(),
        recipients: z.string().max(letters.RECIPIENTS_MAX * 2).optional(),
        exportId: z.string().uuid().optional(),
      }),
      /** warnings — что не получилось рядом с отметкой: «Запись в „Рассылках“ не создана: реестр в архиве». */
      response: { 200: LetterDetail.extend({ warnings: z.array(z.string()) }), ...errors },
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

  // ———————————————————————————————————————— шаблоны (раздел 17)

  app.get('/awareness/templates', {
    preHandler: work,
    schema: {
      tags, summary: 'Шаблоны писем по названию; фильтр архива, поиск',
      querystring: z.object({
        scope: z.enum(['active', 'archived', 'all']).default('active'),
        q: z.string().max(300).optional(),
        limit: z.coerce.number().int().min(1).max(templates.TEMPLATE_LIST_LIMIT).default(100),
        cursor: z.string().max(20).optional(),
      }),
      response: { 200: z.object({ items: z.array(TemplateItem), nextCursor: z.string().nullable(), total: z.number().int() }), ...errors },
    },
  }, async (request) => templates.listTemplates(db, request.query));

  app.post('/awareness/templates', {
    preHandler: work,
    bodyLimit: LETTER_BODY_LIMIT,
    schema: {
      tags, summary: 'Новый шаблон: санитизация и лимиты письма; переменные — 400 BAD_TEMPLATE (пустые, длинные, больше 30, {{подпись}} в теме)',
      body: TemplateInput, response: { 201: TemplateSave, ...errors },
    },
  }, async (request, reply) => reply.status(201).send(await templates.createTemplate(db, actorOf(request), request.body, portalUrl)));

  app.get('/awareness/templates/:id', {
    preHandler: work,
    schema: { tags, summary: 'Шаблон с содержимым и переменными', params: IdParams, response: { 200: TemplateDetail, ...errors } },
  }, async (request) => templates.getTemplate(db, request.params.id));

  app.put('/awareness/templates/:id', {
    preHandler: work,
    bodyLimit: LETTER_BODY_LIMIT,
    schema: {
      tags, summary: 'Изменить шаблон (version). Архивный — 409 TEMPLATE_ARCHIVED. Созданные письма не меняются',
      params: IdParams, body: TemplateInput.merge(Version), response: { 200: TemplateSave, ...errors },
    },
  }, async (request) => templates.updateTemplate(db, actorOf(request), request.params.id, request.body, portalUrl));

  app.post('/awareness/templates/:id/archive', {
    preHandler: work,
    schema: { tags, summary: 'В архив: в новых правилах и «Письме из шаблона» не выбирается', params: IdParams, body: Version, response: { 200: TemplateDetail, ...errors } },
  }, async (request) => templates.archiveTemplate(db, actorOf(request), request.params.id, { version: request.body.version, archived: true }));

  app.post('/awareness/templates/:id/unarchive', {
    preHandler: work,
    schema: { tags, summary: 'Вернуть из архива', params: IdParams, body: Version, response: { 200: TemplateDetail, ...errors } },
  }, async (request) => templates.archiveTemplate(db, actorOf(request), request.params.id, { version: request.body.version, archived: false }));

  app.post('/awareness/templates/:id/letter', {
    preHandler: work,
    schema: {
      tags,
      summary: '«Письмо из шаблона»: значения переменных (простой текст) → черновик, версия template. Пустая переменная — '
        + '400 UNFILLED_VARIABLES, черновик не создаётся; шаблон в архиве — 409 TEMPLATE_ARCHIVED',
      params: IdParams,
      body: z.object({
        title: z.string().max(1000), kind: Kind, reason: z.string().max(10_000).optional(),
        values: z.record(z.string().max(200), z.string().max(templates.VALUE_MAX * 2)),
      }),
      response: { 201: SaveResult, ...errors },
    },
  }, async (request, reply) => reply.status(201).send(await templates.letterFromTemplate(db, actorOf(request), request.params.id, request.body, deps)));

  // ———————————————————————————————————————— «Подпись ИБ» (раздел 17.3)

  app.get('/awareness/signature', {
    preHandler: work,
    schema: { tags, summary: '«Подпись ИБ» — текущая: показывается в незамороженных письмах', response: { 200: Signature, ...errors } },
  }, async (request) => templates.getSignature(db, request.user?.permissions ?? new Set<string>()));

  app.put('/awareness/signature', {
    preHandler: requireAllPerms(['settings.manage', 'ib.work']),
    bodyLimit: LETTER_BODY_LIMIT,
    schema: {
      tags, summary: 'Изменить «Подпись ИБ» (settings.manage и ib.work): санитизация, лимиты, без переменных; version (0 — строки ещё нет)',
      body: z.object({ htmlRu: ContentInput.shape.htmlRu, htmlTj: ContentInput.shape.htmlTj, version: z.number().int().min(0) }),
      response: { 200: z.object({ signature: Signature, removed: z.array(z.string()), warnings: z.array(z.string()) }), ...errors },
    },
  }, async (request) => templates.updateSignature(db, { ...actorOf(request), perms: request.user?.permissions ?? new Set<string>() }, request.body, portalUrl));

  // ———————————————————————————————————————— экспорт (раздел 16)

  const ExportQuery = z.object({
    lang: z.enum(['ru', 'tj', 'both']),
    /** Номер версии; без него — последняя (у отправленного — версия sent). */
    version: z.coerce.number().int().positive().optional(),
  });
  const exportErrors = 'Язык без текста — 400 LANG_NOT_AVAILABLE. В журнал — awareness_letter.exported';

  app.get('/awareness/letters/:id/export.eml', {
    preHandler: work,
    schema: {
      tags,
      summary: `«Скачать для Outlook»: .eml по макету (X-Unsent, Content-Language, без From/To/Cc/Date; логотип и изображения — по Content-ID). `
        + `Выгрузка сохраняется файлом — её возьмёт «Отметить отправленным»; размер — по готовому файлу (413). ${exportErrors}`,
      params: IdParams, querystring: ExportQuery,
    },
  }, async (request, reply) => {
    const { fileName, eml } = await exporter.exportEml(db, store, actorOf(request), request.params.id, request.query, deps);
    return reply
      .header('Content-Type', 'message/rfc822')
      .header('Content-Disposition', fileDisposition(fileName))
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'no-store')
      .send(eml);
  });

  app.get('/awareness/letters/:id/export/html', {
    preHandler: work,
    schema: {
      tags, summary: `«Скопировать с оформлением»: HTML со встроенными стилями (изображения data:) и простой текст. ${exportErrors}`,
      params: IdParams, querystring: ExportQuery,
      response: { 200: z.object({ subject: z.string(), html: z.string(), text: z.string(), versionNo: z.number().int() }), ...errors },
    },
  }, async (request) => exporter.exportHtml(db, store, actorOf(request), request.params.id, request.query));

  app.get('/awareness/letters/:id/export/preview', {
    preHandler: work,
    schema: {
      tags, summary: `«Предпросмотр как в почте» сохранённой версии: HTML, который уйдёт в .eml (изображения data:); не экспорт, без журнала. ${exportErrors}`,
      params: IdParams, querystring: ExportQuery,
      response: { 200: z.object({ subject: z.string(), html: z.string(), versionNo: z.number().int() }), ...errors },
    },
  }, async (request) => exporter.previewVersion(db, store, request.params.id, request.query));

  /** Документ предпросмотра для iframe: свой CSP (стили письма inline), без скриптов, только в окне портала. */
  const sendPreview = (reply: FastifyReply, html: string) => reply
    .header('Content-Type', 'text/html; charset=utf-8')
    .header('Content-Security-Policy', PREVIEW_CSP)
    .header('X-Content-Type-Options', 'nosniff')
    .header('Cache-Control', 'no-store')
    .send(html);

  app.get('/awareness/letters/:id/export/preview.html', {
    preHandler: work,
    schema: { tags, summary: 'Документ «Предпросмотр как в почте» сохранённой версии для iframe (CSP sandbox, стили inline)', params: IdParams, querystring: ExportQuery },
  }, async (request, reply) => sendPreview(reply, (await exporter.previewVersion(db, store, request.params.id, request.query)).html));

  app.get('/awareness/mail-preview/:token', {
    preHandler: work,
    schema: { tags, summary: 'Документ предпросмотра несохранённого содержимого (ключ из POST /awareness/mail-preview, 10 минут, только автор)', params: z.object({ token: z.string().max(64) }) },
  }, async (request, reply) => {
    const html = takePreview(actorOf(request).id, request.params.token);
    if (html === null) throw notFound('Предпросмотр');
    return sendPreview(reply, html);
  });

  app.get('/awareness/letters/:id/exports', {
    preHandler: work,
    schema: {
      tags, summary: 'Выгрузки .eml письма (для «Отметить отправленным») и «Получатели» последней отметки — значение по умолчанию',
      params: IdParams,
      response: {
        200: z.object({
          items: z.array(z.object({
            id: z.string(), langs: z.enum(['ru', 'tj', 'both']), versionNo: z.number().int(), fileName: z.string(), size: z.number().int(), sha256: z.string(),
            createdBy: Person, createdAt: z.string(),
          })),
          lastRecipients: z.string(),
        }),
        ...errors,
      },
    },
  }, async (request) => ({ ...(await exporter.listExports(db, request.params.id)), lastRecipients: await letters.lastRecipients(db) }));

  app.post('/awareness/mail-preview', {
    preHandler: work,
    bodyLimit: LETTER_BODY_LIMIT,
    schema: {
      tags,
      summary: '«Предпросмотр как в почте» из несохранённого содержимого письма или шаблона: тот же HTML, что уйдёт в .eml '
        + '(изображения — data:). Санитайзер и лимиты как при сохранении; ничего не сохраняется',
      body: ContentInput.extend({ kind: Kind, lang: z.enum(['ru', 'tj', 'both']) }),
      response: { 200: z.object({ subject: z.string(), html: z.string(), token: z.string(), warnings: z.array(z.string()), removed: z.array(z.string()) }), ...errors },
    },
  }, async (request) => {
    const r = await exporter.previewMail(db, store, request.body, deps);
    return { ...r, token: putPreview(actorOf(request).id, r.html) };
  });

  // ———————————————————————————————————————— «Оформление писем» (1.12.0, раздел 22)

  const LayoutFields = {
    deptRu: z.string(), deptTj: z.string(), email: z.string(), closingRu: z.string(), closingTj: z.string(), footerRu: z.string(), footerTj: z.string(),
    labelUrgentRu: z.string(), labelUrgentTj: z.string(), labelPlannedRu: z.string(), labelPlannedTj: z.string(), tjHint: z.string(),
  };
  const Layout = z.object({
    ...LayoutFields,
    logo: z.object({ id: z.string(), name: z.string(), size: z.number().int(), sha256: z.string() }).nullable(),
    version: z.number().int(), updatedBy: Person.nullable(), updatedAt: z.string().nullable(), canEdit: z.boolean(),
  });

  app.get('/awareness/layout', {
    preHandler: work,
    schema: { tags, summary: '«Оформление писем»: логотип, отдел, адрес ИБ, прощание, подвал, метки по типу, подсказка о таджикском тексте', response: { 200: Layout, ...errors } },
  }, async (request) => layout.getLayout(db, request.user?.permissions ?? new Set<string>()));

  app.put('/awareness/layout', {
    preHandler: requireAllPerms(['settings.manage', 'ib.work']),
    schema: {
      tags, summary: 'Изменить «Оформление писем» (settings.manage и ib.work): логотип — PNG до 100 КБ из POST /files; version (0 — строки ещё нет)',
      body: z.object({ ...Object.fromEntries(Object.keys(LayoutFields).map((k) => [k, z.string().max(5000)])) as Record<keyof typeof LayoutFields, z.ZodString>, logoFileId: z.string().uuid().nullable(), version: z.number().int().min(0) }),
      response: { 200: Layout, ...errors },
    },
  }, async (request) => {
    await layout.updateLayout(db, actorOf(request), request.body);
    return layout.getLayout(db, request.user?.permissions ?? new Set<string>());
  });

  app.get('/awareness/letters/:id/export/print', {
    preHandler: work,
    schema: {
      tags, summary: `Страница печати (PDF через печать браузера): части по языкам без почтовых стилей. ${exportErrors}`,
      params: IdParams, querystring: ExportQuery,
      response: {
        200: z.object({
          number: z.number().int(), title: z.string(), versionNo: z.number().int(), lang: z.enum(['ru', 'tj', 'both']),
          parts: z.array(z.object({ lang: z.enum(['ru', 'tj']), subject: z.string(), html: z.string() })),
        }),
        ...errors,
      },
    },
  }, async (request) => exporter.exportPrint(db, actorOf(request), request.params.id, request.query));

  // ———————————————————————————————————————— расписание: правила (раздел 19.1–19.4)

  const RuleBody = z.object({
    title: z.string().max(1000),
    cadence: CadenceSchema,
    startsOn: IsoDate,
    leadDays: z.number().int().min(LEAD_DAYS.min).max(LEAD_DAYS.max).optional(),
    roleId: z.string().uuid(),
    templateId: z.string().uuid().nullable().optional(),
    active: z.boolean().optional(),
  });
  const PreviewDate = z.object({ nominal: z.string(), planned: z.string(), shifted: z.boolean(), reason: z.string().nullable() });
  const Rule = z.object({
    id: z.string(), title: z.string(), cadence: CadenceSchema, cadenceText: z.string(), startsOn: z.string(), leadDays: z.number().int(),
    role: z.object({ id: z.string(), name: z.string() }), roleHolders: z.number().int(),
    template: z.object({ id: z.string(), title: z.string(), archived: z.boolean() }).nullable(),
    active: z.boolean(), archived: z.boolean(), archivedAt: z.string().nullable(),
    createdBy: Person, createdAt: z.string(), updatedAt: z.string(), version: z.number().int(),
  });
  const RuleDetail = Rule.extend({
    dates: z.array(PreviewDate),
    runs: z.array(z.object({
      id: z.string(), nominalDate: z.string(), plannedDate: z.string(), draftDue: z.string(), reviewDue: z.string(), escalatedAt: z.string().nullable(),
      task: z.object({ id: z.string(), number: z.number().int(), title: z.string(), done: z.boolean(), archived: z.boolean() }).nullable(),
      letter: z.object({ id: z.string(), number: z.number().int(), status: Status }).nullable(),
    })),
  });

  app.get('/awareness/rules', {
    preHandler: work,
    schema: {
      tags, summary: 'Правила расписания: активные сверху; у каждого — ближайшая плановая дата', querystring: z.object({ scope: z.enum(['active', 'archived', 'all']).default('active') }),
      response: { 200: z.object({ items: z.array(Rule.extend({ next: PreviewDate.nullable() })) }), ...errors },
    },
  }, async (request) => rules.listRules(db, request.query));

  app.get('/awareness/rules/roles', {
    preHandler: work,
    schema: {
      tags, summary: 'Роли для исполнителя правила: с ib.work, без служебной; число держателей, участвующих в работе',
      response: { 200: z.object({ items: z.array(z.object({ id: z.string(), name: z.string(), holders: z.number().int() })) }), ...errors },
    },
  }, async () => rules.listWorkRoles(db));

  app.post('/awareness/rules/preview', {
    preHandler: work,
    schema: {
      tags, summary: `Предпросмотр формы: ближайшие ${rules.PREVIEW_COUNT} дат — номинальная, плановая, перенос и причина`,
      body: z.object({ cadence: CadenceSchema, startsOn: IsoDate }),
      response: { 200: z.object({ cadenceText: z.string(), dates: z.array(PreviewDate) }), ...errors },
    },
  }, async (request) => rules.previewForm(db, request.body));

  app.post('/awareness/rules', {
    preHandler: work,
    schema: { tags, summary: 'Новое правило. Роль не рабочая — 400 BAD_ROLE; шаблон в архиве — 409 TEMPLATE_ARCHIVED', body: RuleBody, response: { 201: RuleDetail, ...errors } },
  }, async (request, reply) => reply.status(201).send(await rules.createRule(db, actorOf(request), request.body)));

  app.get('/awareness/rules/:id', {
    preHandler: work,
    schema: { tags, summary: 'Правило: ближайшие даты и последние запуски', params: IdParams, response: { 200: RuleDetail, ...errors } },
  }, async (request) => rules.getRule(db, request.params.id));

  app.put('/awareness/rules/:id', {
    preHandler: work,
    schema: {
      tags, summary: 'Изменить правило (version), в том числе включить и отключить. Созданные запуски и задачи не меняются',
      params: IdParams, body: RuleBody.merge(Version), response: { 200: RuleDetail, ...errors },
    },
  }, async (request) => rules.updateRule(db, actorOf(request), request.params.id, request.body));

  app.post('/awareness/rules/:id/archive', {
    preHandler: work,
    schema: { tags, summary: 'В архив: задач больше не создаёт', params: IdParams, body: Version, response: { 200: RuleDetail, ...errors } },
  }, async (request) => rules.archiveRule(db, actorOf(request), request.params.id, { version: request.body.version, archived: true }));

  app.post('/awareness/rules/:id/unarchive', {
    preHandler: work,
    schema: { tags, summary: 'Вернуть из архива: догоняет только окно', params: IdParams, body: Version, response: { 200: RuleDetail, ...errors } },
  }, async (request) => rules.archiveRule(db, actorOf(request), request.params.id, { version: request.body.version, archived: false }));

  app.post('/awareness/rules/:id/run', {
    preHandler: work,
    schema: {
      tags, summary: '«Проверить сейчас»: прогон расписания для одного правила (окно, кандидаты, эскалация). Отключено — 409 RULE_INACTIVE; идёт фоновый прогон — 409 SCHEDULE_BUSY',
      params: IdParams,
      response: {
        200: z.object({
          ran: z.boolean(), today: z.string(), rules: z.number().int(), created: z.number().int(), letters: z.number().int(),
          candidatesUpdated: z.number().int(), escalated: z.number().int(),
        }),
        ...errors,
      },
    },
  }, async (request) => checkRuleNow(db, request.params.id));

  // ———————————————————————————————————————— задачи модуля (раздел 19.6)

  app.post('/awareness/urgent', {
    preHandler: work,
    schema: {
      tags, summary: '«Срочная рассылка»: письмо «Срочное» с поводом (из шаблона — переменные остаются в тексте) и задача нажавшему — 1 рабочий день, «Высокий»',
      body: z.object({ title: z.string().max(1000), reason: z.string().max(10_000), templateId: z.string().uuid().nullable().optional() }),
      response: { 201: SaveResult, ...errors },
    },
  }, async (request, reply) => reply.status(201).send(await letters.urgentMailing(db, actorOf(request), request.body, deps)));

  app.post('/awareness/tasks/:taskId/letter', {
    preHandler: work,
    schema: {
      tags,
      summary: '«Создать письмо» или «Письмо из шаблона» из задачи рассылки без черновика: письмо привязывается к задаче и запуску. '
        + 'У задачи уже есть письмо — 409 TASK_HAS_LETTER; выполнена — 409 TASK_DONE; не задача расписания — 404',
      params: z.object({ taskId: z.string().uuid() }),
      body: z.object({
        title: z.string().max(1000),
        templateId: z.string().uuid().optional(),
        values: z.record(z.string().max(200), z.string().max(templates.VALUE_MAX * 2)).optional(),
      }),
      response: { 201: SaveResult, ...errors },
    },
  }, async (request, reply) => {
    const { taskId } = request.params;
    const b = request.body;
    const link = { taskId };
    const res = b.templateId
      ? await templates.letterFromTemplate(db, actorOf(request), b.templateId, { title: b.title, kind: 'planned', values: b.values ?? {} }, deps, link)
      : await letters.createLetter(db, actorOf(request), { title: b.title, kind: 'planned' }, deps, link);
    return reply.status(201).send(res);
  });

  // ———————————————————————————————————————— реестр «Рассылки» (раздел 18)

  app.get('/awareness/letters/refs', {
    preHandler: work,
    schema: {
      tags, summary: 'Письма по номерам — для ссылки «Письмо» в реестре «Рассылки»: значение «№ N, версия V» — ссылка, только если письмо и версия есть',
      querystring: z.object({ numbers: z.string().max(2000).regex(/^\d+(,\d+)*$/, 'Номера через запятую') }),
      response: { 200: z.object({ items: z.array(z.object({ number: z.number().int(), id: z.string(), lastVersionNo: z.number().int() })) }), ...errors },
    },
  }, async (request) => letterRefs(db, request.query.numbers.split(',').map(Number).slice(0, 500)));

  app.get('/awareness/audiences', {
    preHandler: work,
    schema: {
      tags, summary: 'Подсказки аудитории «Отметить отправленным»: «Все сотрудники», подразделения из «Сотрудников», прежние аудитории',
      querystring: z.object({ q: z.string().max(200).optional() }),
      response: {
        200: z.object({ items: z.array(z.object({ value: z.string(), source: z.enum(['all', 'dept', 'previous']), count: z.number().int() })).max(AUDIENCE_LIMIT) }),
        ...errors,
      },
    },
  }, async (request) => audienceSuggestions(db, request.query.q));
};
