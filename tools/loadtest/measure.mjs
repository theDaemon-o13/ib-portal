// Замер основных экранов на стенде ibportal-releasetest (этап 5 подготовки к 1.0.0): каждый запрос — 1 прогрев
// и 3 замера, в отчёт — медиана. Время — полный ответ API через nginx (без отрисовки в браузере).
//   NODE_EXTRA_CA_CERTS=<certs/portal.crt стенда> E2E_LOGIN=… E2E_PASSWORD=… node tools/loadtest/measure.mjs [https://localhost:8443]
const BASE = process.argv[2] ?? 'https://localhost:8443';
if (!['localhost', '127.0.0.1'].includes(new URL(BASE).hostname)) throw new Error('замер — только на локальном стенде');

let cookie = '';
async function call(path, init = {}) {
  const res = await fetch(BASE + path, { ...init, headers: { ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) } });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const body = Buffer.from(await res.arrayBuffer());
  if (!res.ok) throw new Error(`${path}: ${res.status} ${body.toString().slice(0, 200)}`);
  return body;
}
const json = async (path) => JSON.parse((await call(path)).toString());

await call('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login: process.env.E2E_LOGIN, password: process.env.E2E_PASSWORD }) });

const regs = await json('/api/v1/registers');
const reg = (name) => (regs.items ?? regs).find((r) => r.name === name);
const def = async (r) => { const d = await json(`/api/v1/registers/${r.id}`); return d.fields ?? d.register.fields; };
const vulns = reg('Реестр уязвимостей');
const devices = reg('Устройства DLP');
const perms = reg('Разрешения на доступ');
const vf = await def(vulns);
const pf = await def(perms);
const crit = vf.find((f) => f.label === 'Критичность' && f.options?.length) ?? vf.find((f) => f.type === 'select' && f.options?.length);
const permDate = pf.find((f) => f.label === 'Дата документа');
const from = new Date(Date.now() - 1095 * 864e5).toISOString().slice(0, 10);
const to = new Date().toISOString().slice(0, 10);

const cases = [
  ['Уязвимости: список, 1-я страница', `/api/v1/registers/${vulns.id}/records?limit=50`],
  ['Уязвимости: открытые, сортировка по сроку', `/api/v1/registers/${vulns.id}/records?limit=50&state=open&sort=deadline`],
  ['Уязвимости: фильтр по сроку «просрочено»', `/api/v1/registers/${vulns.id}/records?limit=50&deadline=overdue`],
  [`Уязвимости: фильтр «${crit.label}» = значение`, `/api/v1/registers/${vulns.id}/records?limit=50&f=${crit.id}:${crit.options[0].id}`],
  ['Уязвимости: поиск в реестре «закрыть порт»', `/api/v1/registers/${vulns.id}/records?limit=50&q=${encodeURIComponent('закрыть порт')}`],
  ['Устройства DLP: список', `/api/v1/registers/${devices.id}/records?limit=50`],
  ['Разрешения: список', `/api/v1/registers/${perms.id}/records?limit=50`],
  ['Задачи: доска', '/api/v1/tasks?archived=false&limit=200'],
  ['Дашборд: KPI', '/api/v1/dashboard/kpis'],
  ['Дашборд: виджеты', '/api/v1/dashboard/widgets'],
  ['Дашборд: плитки', '/api/v1/dashboard/tiles'],
  ['Монитор', '/api/v1/monitor'],
  ['Глобальный поиск «WS-»', `/api/v1/search?q=${encodeURIComponent('WS-')}`],
  ['Глобальный поиск по тексту PDF «облачного хранилища»', `/api/v1/search?q=${encodeURIComponent('облачного хранилища')}`],
  ['Выгрузка Excel: уязвимости (20 тыс.)', `/api/v1/registers/${vulns.id}/export`],
  ['Выгрузка zip: разрешения за 3 года (1 000 PDF)', `/api/v1/registers/${perms.id}/export.zip?dateFieldId=${permDate.id}&from=${from}&to=${to}`],
];

const rows = [];
for (const [name, path] of cases) {
  let size = 0;
  await call(path);
  const times = [];
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    size = (await call(path)).length;
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  rows.push({ name, ms: Math.round(times[1]), size });
  console.log(`${(times[1] / 1000).toFixed(2).padStart(6)} с  ${(size / 1024).toFixed(0).padStart(7)} КБ  ${name}`);
}
