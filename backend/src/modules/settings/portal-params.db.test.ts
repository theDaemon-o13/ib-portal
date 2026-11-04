// «Настройки → Параметры портала» (релиз 1.6.0): только супер-администратор, схема ключа, журнал, значение по умолчанию.
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { actorFor, expectCode, inTx, lastAudit, makeUser, must, type Tx } from '../../test/db.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { seedAssets } from '../../../prisma/seed/assets.js';
import { assetSettingsView, getAssetSettings } from '../assets/service.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import { getVulnSettings } from '../vulns/profiles.js';
import { PORTAL_PARAMS, listPortalParams, resetPortalParam, updatePortalParam } from './portal-params.js';

const PASSWORD = 'Params-Test-Pass-2026';
const actor = async (tx: Tx) => actorFor(tx, (await makeUser(tx, ['super_admin'])).id);
const param = async (tx: Tx, key: string) => must((await listPortalParams(tx)).items.find((p) => p.key === key));
const dropRow = (tx: Tx, key: string) => tx.appSetting.deleteMany({ where: { key } });

describe('параметры портала', () => {
  it('значение по умолчанию каждого ключа проходит его схему', () =>
    inTx(async (tx) => {
      for (const def of PORTAL_PARAMS) expect(def.schema.safeParse(await def.defaults(tx)).success, def.key).toBe(true);
      expect(PORTAL_PARAMS.map((p) => p.key)).toEqual(['vulns', 'assets', 'assets.teamProducts', 'assets.osNormalization', 'assets.unsupportedOs', 'assets.hostTypeRules', 'assets.minProtectionVersion', 'documents.stageDays', 'documents.reviewRole', 'tasks.chainSuggest']);
    }));

  it('ключа нет — видно значение по умолчанию; изменение — журнал было → стало; сброс удаляет строку', () =>
    inTx(async (tx) => {
      const a = await actor(tx);
      await dropRow(tx, 'vulns');
      expect(await param(tx, 'vulns')).toMatchObject({ isDefault: true, version: 0, value: { scanMaxAgeDays: 90, profileAliases: {} }, defaultValue: { scanMaxAgeDays: 90 } });

      const saved = await updatePortalParam(tx, a, 'vulns', { version: 0, value: { scanMaxAgeDays: 30, profileAliases: {} } });
      expect(saved).toMatchObject({ isDefault: false, version: 1, value: { scanMaxAgeDays: 30 } });
      expect((await getVulnSettings(tx)).scanMaxAgeDays).toBe(30);
      expect(await lastAudit(tx)).toMatchObject({ action: 'portal_param.updated', entity: 'app_setting', entityId: 'vulns', diff: { before: { value: { scanMaxAgeDays: 90 }, isDefault: true }, after: { value: { scanMaxAgeDays: 30 } } } });

      await expectCode(updatePortalParam(tx, a, 'vulns', { version: 0, value: { scanMaxAgeDays: 40, profileAliases: {} } }), 'VERSION_CONFLICT');
      const back = await resetPortalParam(tx, a, 'vulns', { version: 1 });
      expect(back).toMatchObject({ isDefault: true, version: 0, value: { scanMaxAgeDays: 90 } });
      expect(await tx.appSetting.findUnique({ where: { key: 'vulns' } })).toBeNull();
      expect(await lastAudit(tx)).toMatchObject({ action: 'portal_param.reset', diff: { before: { value: { scanMaxAgeDays: 30 } }, after: { value: { scanMaxAgeDays: 90 }, isDefault: true } } });
    }));

  it.each([
    ['vulns', { scanMaxAgeDays: 0, profileAliases: {} }, 'Порог'],
    ['vulns', { scanMaxAgeDays: 'много', profileAliases: {} }, 'Порог'],
    ['vulns', { scanMaxAgeDays: 90 }, 'profileAliases'],
    ['vulns', { scanMaxAgeDays: 90, profileAliases: {}, лишнее: 1 }, 'лишнее'],
    ['assets.teamProducts', ['не объект'], ''],
    ['assets.unsupportedOs', ['CentOS 7', ''], 'ОС'],
    ['assets.minProtectionVersion', 'двенадцать', 'Версия'],
    ['assets.hostTypeRules', { server: { products: [], groups: [], namePatterns: ['('] }, workstation: { namePatterns: [] } }, 'регулярное'],
  ])('%s: неверное значение %j не сохраняется', (key, value, message) =>
    inTx(async (tx) => {
      const a = await actor(tx);
      await dropRow(tx, key);
      await expect(updatePortalParam(tx, a, key, { version: 0, value })).rejects.toMatchObject({ code: 'BAD_PARAM', message: expect.stringContaining(message) });
      expect(await tx.appSetting.findUnique({ where: { key } })).toBeNull();
    }));

  it('проверка по данным: неизвестный тип, уровень и реестр; неизвестный ключ', () =>
    inTx(async (tx) => {
      const a = await actor(tx);
      await seedAssets(tx);
      await dropRow(tx, 'vulns');
      const missing = '00000000-0000-4000-8000-000000000000';
      await expectCode(updatePortalParam(tx, a, 'vulns', { version: 0, value: { scanMaxAgeDays: 90, profileAliases: { [missing]: ['x'] } } }), 'BAD_PARAM');
      const { version } = await getAssetSettings(tx);
      const base = { significantLevelOptionIds: [], dlpRegisterId: null };
      await expectCode(updatePortalParam(tx, a, 'assets', { version, value: { ...base, significantLevelOptionIds: [missing] } }), 'BAD_PARAM');
      await expectCode(updatePortalParam(tx, a, 'assets', { version, value: { ...base, dlpRegisterId: missing } }), 'BAD_PARAM');
      await expectCode(updatePortalParam(tx, a, 'нет такого', { version: 0, value: 1 }), 'NOT_FOUND');
    }));

  it('сброс «assets» возвращает Mission и Business Critical', () =>
    inTx(async (tx) => {
      const a = await actor(tx);
      await seedAssets(tx);
      const before = await assetSettingsView(tx);
      await updatePortalParam(tx, a, 'assets', { version: before.version, value: { significantLevelOptionIds: [], dlpRegisterId: null } });
      await resetPortalParam(tx, a, 'assets', { version: before.version + 1 });
      const view = await assetSettingsView(tx);
      expect(view.levelOptions.filter((o) => view.significantLevelOptionIds.includes(o.id)).map((o) => o.label)).toEqual(['Mission Critical', 'Business Critical']);
    }));

  it('маршруты — только супер-администратор, право settings.manage не даёт доступа', () =>
    inTx(async (tx) => {
      const passwordHash = await argon2Hasher.hash(PASSWORD);
      const admin = await makeUser(tx, ['super_admin'], { passwordHash });
      const head = await makeUser(tx, ['ib_head'], { passwordHash });
      await tx.rolePermission.createMany({ data: [{ roleId: (await tx.role.findUniqueOrThrow({ where: { code: 'ib_head' } })).id, permissionCode: 'settings.manage' }], skipDuplicates: true });
      await dropRow(tx, 'vulns');
      const app = await buildApp({ db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher, sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL, logger: false });
      const login = async (name: string) => `ib_session=${(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: name, password: PASSWORD } })).cookies.find((c) => c.name === 'ib_session')?.value}`;
      const [A, H] = [await login(admin.login), await login(head.login)];
      const url = '/api/v1/settings/portal-params';
      const put = { method: 'PUT' as const, url: `${url}/vulns`, payload: { version: 0, value: { scanMaxAgeDays: 45, profileAliases: {} } } };
      expect((await app.inject({ url })).statusCode).toBe(401);
      expect((await app.inject({ url, headers: { cookie: H } })).statusCode).toBe(403);
      expect((await app.inject({ ...put, headers: { cookie: H } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: `${url}/vulns/reset`, payload: { version: 0 }, headers: { cookie: H } })).statusCode).toBe(403);
      expect((await app.inject({ url, headers: { cookie: A } })).statusCode).toBe(200);
      expect((await app.inject({ ...put, headers: { cookie: A } })).statusCode).toBe(200);
      const bad = await app.inject({ ...put, headers: { cookie: A }, payload: { version: 1, value: { scanMaxAgeDays: -1, profileAliases: {} } } });
      expect(bad.statusCode).toBe(400);
      expect(bad.json<{ error: { message: string } }>().error.message).toContain('Порог');
    }));
});
