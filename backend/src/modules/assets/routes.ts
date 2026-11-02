// Сверка активов (релиз 1.6.0, ADR-0031). Только чтение; настройки — «Параметры портала».
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../lib/db.js';
import { ErrorResponse } from '../../plugins/errors.js';
import { requirePerm } from '../../plugins/rbac.js';
import { assetFacts, assetRegisterIds, assetSections } from './service.js';

const tags = ['assets'];
const errors = { 401: ErrorResponse, 403: ErrorResponse };

const FactRecord = z.object({ id: z.string(), title: z.string(), href: z.string().nullable(), detail: z.string().nullable() });
const Fact = z.object({
  code: z.string(),
  section: z.string(),
  relatedSections: z.array(z.string()),
  title: z.string(),
  status: z.enum(['ok', 'violations', 'no_data']),
  numerator: z.number().int().nullable(),
  denominator: z.number().int().nullable(),
  percent: z.number().nullable(),
  records: z.array(FactRecord),
  calculatedAt: z.string(),
  message: z.string().nullable(),
  warnings: z.array(z.object({ code: z.string(), message: z.string(), records: z.array(FactRecord) })),
});
const Section = z.object({
  code: z.string(),
  name: z.string(),
  domainNo: z.number().int(),
  domainName: z.string(),
  key: z.boolean(),
  target: z.string(),
  levels: z.array(z.object({ level: z.number().int(), name: z.string(), criteria: z.string() })),
});
export const assetRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.get('/assets/checks', {
    preHandler: requirePerm('ib.work'),
    schema: { tags, summary: 'Сверка активов: факты по проверкам, считаются при запросе', response: { 200: z.object({ items: z.array(Fact), sections: z.array(Section), registers: z.object({ services: z.string().nullable(), components: z.string().nullable(), hosts: z.string().nullable() }) }), ...errors } },
  }, async () => {
    const items = await assetFacts(db);
    return { items, sections: await assetSections(db, items), registers: await assetRegisterIds(db) };
  });

};
