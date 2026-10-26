import argon2 from 'argon2';

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

// Параметры argon2id по рекомендации OWASP.
const OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const argon2Hasher: PasswordHasher = {
  hash: (password) => argon2.hash(password, OPTIONS),
  async verify(hash, password) {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  },
};
