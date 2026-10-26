// Экспорт контракта API в backend/openapi.json. Из него frontend генерирует типы:
//   cd backend && npm run openapi:export && cd ../frontend && npm run gen:api
import { writeFile } from 'node:fs/promises';
import { buildApp } from '../src/app.js';
import { argon2Hasher } from '../src/lib/passwords.js';
import { MemoryAuditWriter } from '../src/modules/audit/audit.js';
import { MemoryAuthRepository } from '../src/modules/auth/repository.memory.js';

const app = await buildApp({
  repo: new MemoryAuthRepository(),
  audit: new MemoryAuditWriter(),
  hasher: argon2Hasher,
  sessionSecret: 'openapi-export-only-openapi-export-only',
});
await app.ready();
const out = new URL('../openapi.json', import.meta.url);
await writeFile(out, `${JSON.stringify(app.swagger(), null, 2)}\n`);
await app.close();
console.log(`OpenAPI записан в ${out.pathname}`);
