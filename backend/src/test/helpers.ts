import type { PasswordHasher } from '../lib/passwords.js';

/** Быстрый «хэшер» для тестов; argon2 проверяется отдельно в passwords.test.ts. */
export function fakeHasher(): PasswordHasher & { verifyCalls: number } {
  const h = {
    verifyCalls: 0,
    async hash(password: string) {
      return `hash:${password}`;
    },
    async verify(hash: string, password: string) {
      h.verifyCalls++;
      return hash === `hash:${password}`;
    },
  };
  return h;
}

export class FakeClock {
  constructor(private t = new Date('2026-10-26T09:00:00Z').getTime()) {}
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t += ms;
  }
}

export const TEST_SECRET = 'test-secret-test-secret-test-secret-0000';
