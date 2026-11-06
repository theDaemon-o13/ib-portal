// Безопасность «Предпросмотра как в почте» (1.12.0, ADR-0044): документ отдаёт backend со своим CSP.
// Доступ — только ib.work (читатель документов и служебная учётная запись — 403); CSP: default-src 'none',
// img-src data: и свой адрес, style-src 'unsafe-inline' только на этом ответе, без script-src, frame-ancestors 'self',
// sandbox; nosniff. Ключ несохранённого предпросмотра — только автору. Остальные ответы модуля без 'unsafe-inline'.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { diskFileStore } from '../../lib/file-store.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { actorFor, inTx, makeUser } from '../../test/db.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import * as letters from './letters.service.js';

const store = diskFileStore(mkdtempSync(join(tmpdir(), 'ibportal-preview-')));
const PASSWORD = 'Preview-Test-Pass-2026';
const content = { subjectRu: 'Памятка', subjectTj: 'Ёддошт', htmlRu: '<p>Текст.</p>', htmlTj: '<p>Матн.</p>' };

/** Директивы CSP: имя → значения. */
function csp(header: string | undefined): Map<string, string[]> {
  return new Map((header ?? '').split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
    const [name = '', ...values] = d.split(/\s+/);
    return [name, values];
  }));
}

describe('предпросмотр письма: доступ и заголовки', () => {
  it('ib.work — 200 с CSP предпросмотра; читатель документов и служебная — 403; чужой ключ — 404; остальные ответы без unsafe-inline', () =>
    inTx(async (tx) => {
      const hash = await argon2Hasher.hash(PASSWORD);
      const staff = await makeUser(tx, ['ib_staff'], { passwordHash: hash });
      const other = await makeUser(tx, ['ib_staff'], { passwordHash: hash });
      const reader = await makeUser(tx, ['doc_reader'], { passwordHash: hash });
      const svc = await makeUser(tx, ['portal_admin'], { passwordHash: hash });
      const { letter } = await letters.createLetter(tx, await actorFor(tx, staff.id), { title: 'Предпросмотр', kind: 'planned', ...content });
      const app = await buildApp({
        db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher, files: store,
        sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL, logger: { level: 'silent' },
      });
      const login = async (l: string) => {
        const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: l, password: PASSWORD } });
        return `ib_session=${res.cookies.find((x) => x.name === 'ib_session')?.value}`;
      };
      const cookie = { staff: await login(staff.login), other: await login(other.login), reader: await login(reader.login), svc: await login(svc.login) };
      const docUrl = `/api/v1/awareness/letters/${letter.id}/export/preview.html?lang=both`;

      const ok = await app.inject({ url: docUrl, headers: { cookie: cookie.staff } });
      expect(ok.statusCode).toBe(200);
      expect(ok.headers['content-type']).toContain('text/html');
      expect(ok.headers['x-content-type-options']).toBe('nosniff');
      expect(ok.headers['cache-control']).toBe('no-store');
      const d = csp(ok.headers['content-security-policy'] as string);
      expect(d.has('sandbox')).toBe(true);
      expect(d.get('sandbox')).toEqual([]); // без allow-scripts и allow-same-origin
      expect(d.get('default-src')).toEqual(["'none'"]);
      expect(d.get('img-src')).toEqual(['data:', "'self'"]);
      expect(d.get('style-src')).toEqual(["'unsafe-inline'"]);
      expect(d.get('frame-ancestors')).toEqual(["'self'"]);
      expect(d.has('script-src')).toBe(false);
      expect(ok.body).not.toMatch(/<script/i);

      // Без ib.work — 403; служебная учётная запись — 403 SERVICE_ACCOUNT.
      const r = await app.inject({ url: docUrl, headers: { cookie: cookie.reader } });
      expect(r.statusCode).toBe(403);
      const s = await app.inject({ url: docUrl, headers: { cookie: cookie.svc } });
      expect([s.statusCode, s.json().error.code]).toEqual([403, 'SERVICE_ACCOUNT']);
      expect((await app.inject({ url: docUrl })).statusCode).toBe(401);

      // Несохранённое содержимое: ключ — только автору, остальным 404; без ib.work — 403 ещё на создании ключа.
      const post = (c: string) => app.inject({ method: 'POST', url: '/api/v1/awareness/mail-preview', headers: { cookie: c, origin: TEST_PORTAL_URL }, payload: { ...content, kind: 'planned', lang: 'ru' } });
      const created = await post(cookie.staff);
      expect(created.statusCode).toBe(200);
      expect(created.headers['content-security-policy']).toBeUndefined(); // JSON — без CSP предпросмотра (строгий ставит nginx)
      const token = (created.json() as { token: string }).token;
      const mine = await app.inject({ url: `/api/v1/awareness/mail-preview/${token}`, headers: { cookie: cookie.staff } });
      expect(csp(mine.headers['content-security-policy'] as string).get('style-src')).toEqual(["'unsafe-inline'"]);
      expect((await app.inject({ url: `/api/v1/awareness/mail-preview/${token}`, headers: { cookie: cookie.other } })).statusCode).toBe(404);
      expect((await app.inject({ url: `/api/v1/awareness/mail-preview/${token}`, headers: { cookie: cookie.reader } })).statusCode).toBe(403);
      expect((await post(cookie.reader)).statusCode).toBe(403);
      expect((await post(cookie.svc)).statusCode).toBe(403);

      // 'unsafe-inline' — только у документа предпросмотра: .eml, карточка письма и выдача файлов — без него.
      for (const url of [`/api/v1/awareness/letters/${letter.id}/export.eml?lang=ru`, `/api/v1/awareness/letters/${letter.id}`, `/api/v1/awareness/letters/${letter.id}/export/preview?lang=ru`]) {
        const res = await app.inject({ url, headers: { cookie: cookie.staff } });
        expect(res.statusCode, url).toBe(200);
        expect(String(res.headers['content-security-policy'] ?? ''), url).not.toContain('unsafe-inline');
      }
    }));
});
