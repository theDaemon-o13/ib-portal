// Сквозной тест раздела «Журнал» (релиз 1.2.0, ADR-0021): Chrome → Vite (прокси /api) → backend → PostgreSQL.
//
//   npm run test:e2e   (логин и пароль администратора — из frontend/.env.e2e или E2E_LOGIN / E2E_PASSWORD)
//
// Администратор (право «Журнал действий») находит своё действие по фильтрам и переходит к задаче.
// Сотрудник ИБ без права не видит пункта меню, прямой адрес уводит из раздела, API отвечает 403.
// В конце задача прогона уходит в архив, тестовый пользователь отключается.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { $, launchBrowser } from './browser.mjs';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const LOGIN = process.env.E2E_LOGIN;
const PASSWORD = process.env.E2E_PASSWORD;
const RUN = `E2E-${Date.now().toString(36)}`;

let ui;
let navSeq = 0;
let staff;
let task;

async function api(method, path, body) {
  const res = await ui.evaluate(`fetch(${JSON.stringify(path)}, ${JSON.stringify(body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })})
    .then(async (r) => ({ status: r.status, text: await r.text() }))`);
  return { status: res.status, json: res.text ? JSON.parse(res.text) : null };
}

async function ok(method, path, body) {
  const r = await api(method, path, body);
  assert.ok(r.status >= 200 && r.status < 300, `${method} ${path} → ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

/** Выйти и войти через форму; при первом входе — смена временного пароля. */
async function loginAs(login, password) {
  // Новая вкладка — about:blank: запрос к API возможен только со страницы портала.
  if (!(await ui.evaluate(`location.origin.startsWith('http')`))) await ui.goto(`/login?n=${++navSeq}`);
  await api('POST', '/api/v1/auth/logout');
  await ui.goto(`/login?n=${++navSeq}`);
  await ui.type(`document.querySelector('input[name=username]')`, login);
  await ui.type(`document.querySelector('input[name=password]')`, password);
  await ui.click(`document.querySelector('form button[type=submit]')`);
  await ui.waitFor(`location.pathname !== '/login'`, `вход ${login}`);
  if (await ui.evaluate(`location.pathname === '/change-password'`)) {
    const next = `Журнал-${RUN.slice(4)}-Zq9!`;
    await ui.type(`document.querySelector('input[autocomplete=current-password]')`, password);
    await ui.type(`document.querySelectorAll('input[autocomplete=new-password]')[0]`, next);
    await ui.type(`document.querySelectorAll('input[autocomplete=new-password]')[1]`, next);
    await ui.click($.button('Сменить пароль'));
    await ui.waitFor(`location.pathname !== '/change-password'`, `смена пароля ${login}`);
    return next;
  }
  return password;
}

// Название пункта — без счётчика (.nav-n): у «Журнала» бывает цифра действий служебного администратора (1.8.0).
const navTitles = () => ui.evaluate(`[...document.querySelectorAll('nav.nav a span:not(.nav-n)')].map((s) => s.textContent.trim())`);
const auditRow = (text) => `[...document.querySelectorAll('.audit-tbl tbody tr[data-audit]')].find((tr) => tr.textContent.includes(${JSON.stringify(text)}))`;

before(async () => {
  assert.ok(LOGIN && PASSWORD, 'Задайте E2E_LOGIN и E2E_PASSWORD (пользователь с ролью «Супер-администратор»)');
  ui = await launchBrowser({ baseUrl: BASE });
  await loginAs(LOGIN, PASSWORD);
  const roles = (await ok('GET', '/api/v1/roles')).items;
  const created = await ok('POST', '/api/v1/users', {
    login: `${RUN.toLowerCase()}.staff`, fullName: `Сотрудник Журнала ${RUN}`, roleIds: [roles.find((r) => r.code === 'ib_staff').id],
  });
  staff = { id: created.user.id, login: created.user.login, password: created.temporaryPassword };
  const category = (await ok('GET', '/api/v1/catalogs/task_categories/items')).items[0];
  task = await ok('POST', '/api/v1/tasks', { title: `${RUN} задача для журнала`, categoryId: category.id });
});

after(async () => {
  if (!ui) return;
  await loginAs(LOGIN, PASSWORD).catch(() => undefined);
  if (task) {
    const t = (await api('GET', `/api/v1/tasks/${task.id}`)).json;
    if (t && !t.archived) await api('POST', `/api/v1/tasks/${task.id}/archive`, { version: t.version });
  }
  if (staff) {
    const cur = (await ok('GET', `/api/v1/users?q=${encodeURIComponent(staff.login)}`)).items.find((u) => u.id === staff.id);
    if (cur?.isActive) await api('POST', `/api/v1/users/${staff.id}/disable`, { version: cur.version });
  }
  await ui.close();
});

describe('Журнал', () => {
  it('с правом: пункт меню, поиск своего действия, подробности, переход к задаче', async () => {
    await ui.goto('/dashboard');
    assert.ok((await navTitles()).includes('Журнал'), 'пункт «Журнал» в меню');
    await ui.click(`[...document.querySelectorAll('nav.nav a')].find((a) => a.querySelector('span:not(.nav-n)')?.textContent.trim() === 'Журнал')`, 'пункт «Журнал»');
    await ui.waitFor(`location.pathname === '/audit' && !!document.querySelector('.audit-tbl')`, 'раздел «Журнал»');

    // Поиск по названию задачи из прогона: запись «Задача создана».
    await ui.type(`[...document.querySelectorAll('.audit-filters label')].find((l) => l.textContent.startsWith('Поиск'))?.querySelector('input')`, RUN);
    let m = ui.mark();
    await ui.click($.button('Найти'));
    const req = await ui.request(m, 'GET', '/api/v1/audit?');
    assert.match(req.url, /q=E2E-/);
    await ui.waitFor(`!!${auditRow('Задача создана')}`, 'запись о создании задачи');

    // Щелчок по строке — подробности: код действия.
    await ui.click(auditRow('Задача создана'), 'строка журнала');
    await ui.waitFor(`document.querySelector('.audit-open')?.textContent.includes('task.created')`, 'подробности записи');

    // «Открыть» — карточка задачи.
    await ui.click(`[...${auditRow('Задача создана')}.querySelectorAll('a')].find((a) => a.textContent === 'Открыть')`, '«Открыть»');
    await ui.waitFor(`location.pathname === '/tasks' && new URLSearchParams(location.search).get('task') === ${JSON.stringify(task.id)}`, 'переход к задаче');

    // В карточке задачи администратор видит историю изменений (право «История в карточках»).
    await ui.waitFor(`[...document.querySelectorAll('aside.drawer .eyebrow')].some((e) => e.textContent === 'История изменений')`, 'история в карточке задачи');

    // Старая вкладка настроек ведёт в раздел «Журнал».
    await ui.goto('/settings/journal');
    await ui.waitFor(`location.pathname === '/audit'`, '«Журнал изменений» настроек → раздел «Журнал»');
  });

  it('без права: пункта нет, прямой адрес уводит из раздела, API — 403', async () => {
    staff.password = await loginAs(staff.login, staff.password);
    await ui.goto('/dashboard');
    await ui.waitFor(`document.querySelectorAll('nav.nav a').length > 0`, 'меню');
    assert.ok(!(await navTitles()).includes('Журнал'), 'пункта «Журнал» нет');
    await ui.goto('/audit');
    await ui.waitFor(`location.pathname !== '/audit'`, 'прямой адрес /audit уводит из раздела');
    assert.equal((await api('GET', '/api/v1/audit')).status, 403);
    // Карточка задачи: комментарии есть, истории нет; API истории — 403.
    await ui.goto(`/tasks?task=${task.id}`);
    await ui.waitFor(`document.querySelector('aside.drawer .dr-title')?.textContent === ${JSON.stringify(task.title)}`, 'карточка задачи');
    await ui.waitFor(`[...document.querySelectorAll('aside.drawer .eyebrow')].some((e) => e.textContent.startsWith('Комментарии'))`, 'комментарии видны');
    assert.ok(!(await ui.evaluate(`[...document.querySelectorAll('aside.drawer .eyebrow')].some((e) => e.textContent === 'История изменений')`)), 'истории в карточке нет');
    assert.equal((await api('GET', `/api/v1/tasks/${task.id}/history`)).status, 403);
    assert.equal((await api('GET', '/api/v1/audit/export')).status, 403);
  });
});
