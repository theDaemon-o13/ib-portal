// Экспорт контракта API в backend/openapi.json (из него frontend генерирует типы) и списка языков для frontend:
//   cd backend && npm run openapi:export && cd ../frontend && npm run gen:api
import { writeFile } from 'node:fs/promises';
import { buildApp } from '../src/app.js';
import { frontendLanguagesModule } from '../src/lib/languages.js';
import { createPrisma } from '../src/lib/db.js';
import { argon2Hasher } from '../src/lib/passwords.js';
import { MemoryAuditWriter } from '../src/modules/audit/audit.js';
import { MemoryAuthRepository } from '../src/modules/auth/repository.memory.js';

// Клиент без подключения: экспорт не обращается к базе.
const db = createPrisma('postgresql://openapi:export@127.0.0.1:1/none');
const app = await buildApp({
  db,
  repo: new MemoryAuthRepository(),
  audit: new MemoryAuditWriter(),
  hasher: argon2Hasher,
  sessionSecret: 'openapi-export-only-openapi-export-only',
  portalUrl: 'https://portal.invalid',
});
await app.ready();
const out = new URL('../openapi.json', import.meta.url);
await writeFile(out, `${JSON.stringify(app.swagger(), null, 2)}\n`);
await app.close();
console.log(`OpenAPI записан в ${out.pathname}`);
// Список языков для frontend (1.13.7): тот же, что в backend, — один источник.
const langs = new URL('../../frontend/src/api/generated/languages.ts', import.meta.url);
await writeFile(langs, frontendLanguagesModule());
console.log(`Список языков записан в ${langs.pathname}`);
