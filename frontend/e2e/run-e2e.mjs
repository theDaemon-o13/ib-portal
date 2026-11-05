// Полный e2e на одноразовой базе (npm run test:e2e): ibportal_dev прогон не трогает, мусор тестов не копится.
//   1. backend/scripts/e2e-db.ts create — ibportal_e2e с нуля: права ролей, миграции, seed, пользователь e2e;
//   2. отдельный backend на хосте (порт 3100, база ibportal_e2e, файлы — во временном каталоге) и Vite (порт 5174);
//   3. node --test по всем e2e/*.e2e.mjs (или по файлам из аргументов) против http://localhost:5174;
//   4. всё останавливается, база удаляется (E2E_KEEP_DB=1 — оставить для разбора).
// Нужна запущенная dev-БД (ibportal-dev, 127.0.0.1:5433); dev-backend и dev-Vite (5173) не трогаются.
// Флаги node --test (например --test-timeout=600000) передаются как есть.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendDir = fileURLToPath(new URL('..', import.meta.url));
const backendDir = join(frontendDir, '..', 'backend');
const BACKEND_PORT = Number(process.env.E2E_BACKEND_PORT ?? 3100);
const VITE_PORT = Number(process.env.E2E_VITE_PORT ?? 5174);
const BASE = `http://localhost:${VITE_PORT}`;
const DB = process.env.E2E_DB_NAME ?? 'ibportal_e2e';

if (process.env.NODE_ENV === 'production') throw new Error('e2e запрещён при NODE_ENV=production');
if (!DB.endsWith('_e2e')) throw new Error(`база e2e должна оканчиваться на _e2e, а не «${DB}»`);

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const files = args.filter((a) => !a.startsWith('--'));

/** Журнал раннера — в stdout/stderr напрямую (console в e2e запрещён правилами lint). */
const say = (m) => process.stdout.write(`[e2e] ${m}\n`);
const warn = (m) => process.stderr.write(`[e2e] ${m}\n`);

const children = [];
function start(name, cmd, cmdArgs, opts) {
  const p = spawn(cmd, cmdArgs, { ...opts, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const log = [];
  const keep = (d) => { log.push(d.toString()); if (log.length > 200) log.shift(); };
  p.stdout.on('data', keep);
  p.stderr.on('data', keep);
  p.on('exit', (code) => { if (code && !stopping) warn(`${name} завершился с кодом ${code}:\n${log.join('').slice(-4000)}`); });
  children.push(p);
  return p;
}

function run(cmd, cmdArgs, opts) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, cmdArgs, { stdio: 'inherit', ...opts });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${cmdArgs.join(' ')}: код ${code}`))));
  });
}

async function waitHttp(url, what, timeoutMs = 120_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return;
    } catch { /* ещё стартует */ }
    if (Date.now() - t0 > timeoutMs) throw new Error(`не дождались: ${what} (${url})`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

let stopping = false;
let filesDir = '';
async function cleanup() {
  stopping = true;
  for (const p of children) {
    try { process.kill(-p.pid, 'SIGTERM'); } catch { /* уже остановлен */ }
  }
  if (filesDir) rmSync(filesDir, { recursive: true, force: true });
  if (process.env.E2E_KEEP_DB === '1') {
    say(`база ${DB} оставлена (E2E_KEEP_DB=1)`);
    return;
  }
  await run('npx', ['tsx', 'scripts/e2e-db.ts', 'drop'], { cwd: backendDir, env: { ...process.env, E2E_DB_NAME: DB } }).catch((e) => warn(e.message));
}

let code = 1;
try {
  say(`база ${DB}: создание с нуля`);
  await run('npx', ['tsx', 'scripts/e2e-db.ts', 'create'], { cwd: backendDir, env: { ...process.env, E2E_DB_NAME: DB } });

  // Строка подключения роли приложения — та же, что у test:db (deploy/.env.dev).
  const appUrl = await appUrlFromBackend();
  filesDir = mkdtempSync(join(tmpdir(), 'ibportal-e2e-files-'));
  start('backend', 'npx', ['tsx', 'src/server.ts'], {
    cwd: backendDir,
    env: {
      ...process.env, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(BACKEND_PORT), DATABASE_URL: appUrl,
      SESSION_SECRET: randomBytes(32).toString('hex'), FILES_DIR: filesDir, PORTAL_URL: BASE,
      TRUSTED_PROXY_IPS: '127.0.0.1,::1', MONITOR_ALLOWED_IPS: '', ADMIN_ALLOWED_IPS: '', ONLYOFFICE_URL_PREFIX: '',
      APP_TZ: process.env.APP_TZ ?? 'Asia/Dushanbe', AUTOMATION_INTERVAL_MIN: '60', LOG_LEVEL: 'warn',
    },
  });
  await waitHttp(`http://127.0.0.1:${BACKEND_PORT}/api/health`, 'backend e2e');
  start('vite', 'npx', ['vite', '--port', String(VITE_PORT), '--strictPort'], {
    cwd: frontendDir, env: { ...process.env, VITE_HOST: 'localhost', VITE_BACKEND_URL: `http://127.0.0.1:${BACKEND_PORT}` },
  });
  await waitHttp(`${BASE}/api/health`, 'Vite e2e');

  const targets = files.length ? files : ['e2e/**/*.e2e.mjs'];
  say(`прогон против ${BASE}: ${targets.join(' ')}`);
  await run(process.execPath, ['--test', '--test-concurrency=1', ...flags, ...targets], {
    cwd: frontendDir, env: { ...process.env, E2E_BASE_URL: BASE, E2E_DB_NAME: DB },
  });
  code = 0;
} catch (err) {
  warn(String(err instanceof Error ? err.message : err));
} finally {
  await cleanup();
}
process.exit(code);

/** Строка подключения роли приложения к базе e2e — из backend/scripts/e2e-db.ts (deploy/.env.dev). */
async function appUrlFromBackend() {
  const out = [];
  await new Promise((resolve, reject) => {
    const p = spawn('npx', ['tsx', '-e', `import('./scripts/e2e-db.ts').then((m) => process.stdout.write(m.e2eDbConfig().appUrl))`], {
      cwd: backendDir, env: { ...process.env, E2E_DB_NAME: DB }, stdio: ['ignore', 'pipe', 'inherit'],
    });
    p.stdout.on('data', (d) => out.push(d));
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error('не удалось получить адрес базы e2e'))));
  });
  return Buffer.concat(out).toString().trim();
}
