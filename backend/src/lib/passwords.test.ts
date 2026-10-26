import { describe, expect, it } from 'vitest';
import { argon2Hasher } from './passwords.js';

describe('хранение паролей', () => {
  it('argon2id с параметрами OWASP, проверка верного и неверного пароля', async () => {
    const hash = await argon2Hasher.hash('Correct-Horse-42');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await argon2Hasher.verify(hash, 'Correct-Horse-42')).toBe(true);
    expect(await argon2Hasher.verify(hash, 'correct-horse-42')).toBe(false);
  });

  it('повреждённый хэш не роняет проверку', async () => {
    expect(await argon2Hasher.verify('not-a-hash', 'x')).toBe(false);
  });
});
