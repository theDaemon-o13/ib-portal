import { Writable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../../app.js';
import { createPrisma } from '../../lib/db.js';
import { LOG_REDACT } from '../../lib/log-redact.js';
import { FakeClock, TEST_PORTAL_URL, TEST_SECRET, fakeHasher } from '../../test/helpers.js';
import { MemoryAuditWriter } from '../audit/audit.js';
import { MemoryAuthRepository } from './repository.memory.js';

// Пароль не попадает в логи, журнал аудита и тексты ошибок (задача 3 релиза 1.1.0).

const PASSWORD = 'Initial-Pass-2026';
const WRONG = 'Typed-Wrong-Secret-4821';
const NEXT = 'Brand-New-Secret-7719';
const WEAK = 'weakleak';

let audit: MemoryAuditWriter;
let logs: string;
let app: App;

beforeEach(async () => {
  const repo = new MemoryAuthRepository();
  audit = new MemoryAuditWriter();
  logs = '';
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      logs += chunk.toString();
      done();
    },
  });
  repo.addUser({ id: 'u1', login: 'ivanov', fullName: 'И. Иванов', passwordHash: `hash:${PASSWORD}` }, ['ib.work']);
  app = await buildApp({
    db: createPrisma('postgresql://unit:test@127.0.0.1:1/none'),
    repo, audit, hasher: fakeHasher(), sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL, now: new FakeClock().now,
    logger: { level: 'trace', redact: LOG_REDACT, stream },
  });
});

const post = (url: string, payload: unknown, cookie?: string) =>
  app.inject({ method: 'POST', url: `/api/v1/auth/${url}`, payload: payload as object, headers: cookie ? { cookie } : {} });

describe('пароль не утекает', () => {
  it('вход, неудачный вход, смена пароля и ошибки валидации', async () => {
    const bodies: string[] = [];
    const failed = await post('login', { login: 'ivanov', password: WRONG });
    expect(failed.statusCode).toBe(401);
    bodies.push(failed.body);

    const ok = await post('login', { login: 'ivanov', password: PASSWORD });
    const c = ok.cookies.find((x) => x.name === 'ib_session');
    const cookie = `ib_session=${c?.value ?? ''}`;

    const wrongCurrent = await post('change-password', { currentPassword: WRONG, newPassword: NEXT }, cookie);
    expect(wrongCurrent.json().error.code).toBe('WRONG_CURRENT_PASSWORD');
    const weak = await post('change-password', { currentPassword: PASSWORD, newPassword: WEAK }, cookie);
    expect(weak.json().error.code).toBe('PASSWORD_POLICY');
    // zod: лишняя длина и неверный тип — сообщение без введённого значения.
    const tooLong = await post('login', { login: 'ivanov', password: WRONG.repeat(100) });
    expect(tooLong.json().error.code).toBe('VALIDATION_ERROR');
    const badType = await post('change-password', { currentPassword: PASSWORD, newPassword: [NEXT] }, cookie);
    expect(badType.json().error.code).toBe('VALIDATION_ERROR');
    bodies.push(wrongCurrent.body, weak.body, tooLong.body, badType.body);

    const changed = await post('change-password', { currentPassword: PASSWORD, newPassword: NEXT }, cookie);
    expect(changed.statusCode).toBe(200);
    bodies.push(ok.body, changed.body);

    expect(logs.length).toBeGreaterThan(0);
    const journal = JSON.stringify(audit.entries);
    for (const secret of [PASSWORD, WRONG, NEXT, WEAK]) {
      expect(logs).not.toContain(secret);
      expect(journal).not.toContain(secret);
      for (const b of bodies) expect(b).not.toContain(secret);
    }
  });

  it('если тело запроса всё же залогировали, пароли вырезаются', () => {
    const body = { login: 'ivanov', password: PASSWORD, currentPassword: WRONG, newPassword: NEXT, temporaryPassword: WEAK };
    app.log.info({ req: { body } }, 'тело запроса');
    app.log.info({ body }, 'тело');
    app.log.info(body, 'плоско');
    for (const secret of [PASSWORD, WRONG, NEXT, WEAK]) expect(logs).not.toContain(secret);
    expect(logs).toContain('ivanov');
    expect(logs).toContain('[Redacted]');
  });
});
