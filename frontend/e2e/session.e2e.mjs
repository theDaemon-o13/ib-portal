// Сессия (ADR-0023): опрос по таймеру помечен X-Background: 1; с 1.10.0 сессия не завершается по бездействию —
// «Профиль → Мои сессии» и «Завершить все, кроме текущей», администратор завершает сессии пользователя
// («Пользователи и роли» → «Сессии»); после завершения — вход с объяснением и возврат на ту же страницу.
//
//   npm run test:e2e   (логин и пароль — из frontend/.env.e2e или E2E_LOGIN / E2E_PASSWORD)
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { $, launchBrowser } from './browser.mjs';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const LOGIN = process.env.E2E_LOGIN;
const PASSWORD = process.env.E2E_PASSWORD;
const RUN = `E2E-${Date.now().toString(36)}`;
let ui;
let navSeq = 0;
let task;
let staff;
const STAFF_PASSWORD = 'E2e-Sessions-Pass-2026!';

/** Отдельная сессия «с другого устройства»: вход из node, cookie остаётся здесь. */
async function nodeLogin(login, password) {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE }, body: JSON.stringify({ login, password, remember: true }),
  });
  assert.equal(res.status, 200, `вход ${login}: ${res.status}`);
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('ib_session='));
  assert.ok(cookie, 'cookie сессии');
  return cookie;
}
const nodeMe = async (cookie) => (await fetch(`${BASE}/api/v1/auth/me`, { headers: { cookie } })).status;

async function logoutUi() {
  await ui.evaluate(`fetch('/api/v1/auth/logout', { method: 'POST' })`);
  await ui.goto(`/login?n=${++navSeq}`);
  await ui.waitFor(`!!document.querySelector('input[name=password]')`, 'форма входа');
}

async function loginAs(login, password) {
  await ui.type(`document.querySelector('input[name=username]')`, login);
  await ui.type(`document.querySelector('input[name=password]')`, password);
  await ui.click(`document.querySelector('form button[type=submit]')`);
  await ui.waitFor(`location.pathname !== '/login'`, `вход ${login}`);
}

async function api(method, path, body) {
  const res = await ui.evaluate(`fetch(${JSON.stringify(path)}, ${JSON.stringify(body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })})
    .then(async (r) => ({ status: r.status, text: await r.text() }))`);
  assert.ok(res.status >= 200 && res.status < 300, `${method} ${path} → ${res.status} ${res.text}`);
  return res.text ? JSON.parse(res.text) : null;
}

async function login() {
  await ui.type(`document.querySelector('input[name=username]')`, LOGIN);
  await ui.type(`document.querySelector('input[name=password]')`, PASSWORD);
  await ui.click(`document.querySelector('form button[type=submit]')`);
  await ui.waitFor(`location.pathname !== '/login'`, 'вход');
}

before(async () => {
  assert.ok(LOGIN && PASSWORD, 'Задайте E2E_LOGIN и E2E_PASSWORD (пользователь с ролью «Супер-администратор»)');
  ui = await launchBrowser({ baseUrl: BASE });
  await ui.goto('/login');
  await login();
  const category = (await api('GET', '/api/v1/catalogs/task_categories/items')).items[0];
  task = await api('POST', '/api/v1/tasks', { title: `${RUN} сессия`, categoryId: category.id });
  // Свой пользователь: «Завершить все, кроме текущей» не трогает сессии учётной записи e2e.
  const roles = (await api('GET', '/api/v1/roles')).items;
  const created = await api('POST', '/api/v1/users', {
    login: `e2e.sess.${RUN.toLowerCase()}`, fullName: `Сессиев Тест ${RUN}`, roleIds: [roles.find((r) => r.code === 'ib_staff').id],
  });
  staff = created.user;
  const first = await nodeLogin(staff.login, created.temporaryPassword);
  const changed = await fetch(`${BASE}/api/v1/auth/change-password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE, cookie: first },
    body: JSON.stringify({ currentPassword: created.temporaryPassword, newPassword: STAFF_PASSWORD }),
  });
  assert.equal(changed.status, 200, 'смена временного пароля');
});

after(async () => {
  if (!ui) return;
  const t = await api('GET', `/api/v1/tasks/${task.id}`).catch(() => null);
  if (t && !t.archived) await api('POST', `/api/v1/tasks/${task.id}/archive`, { version: t.version }).catch(() => undefined);
  if (staff) {
    const u = (await api('GET', `/api/v1/users?q=${encodeURIComponent(staff.login)}`).catch(() => ({ items: [] }))).items?.find((x) => x.id === staff.id);
    if (u?.isActive) await api('POST', `/api/v1/users/${u.id}/disable`, { version: u.version }).catch(() => undefined);
  }
  assert.deepEqual(ui.consoleErrors, [], 'ошибки JavaScript в странице');
  ui.close();
});

describe('Сессия', () => {
  it('опрос по таймеру — с X-Background: 1; действие пользователя — без него', async () => {
    await ui.goto(`/tasks?n=${++navSeq}`);
    await ui.waitFor(`document.querySelectorAll('.board .col').length >= 5`, 'доска');
    await new Promise((r) => setTimeout(r, 5500));
    // Возвращение на вкладку — повторный опрос без щелчка.
    let m = ui.mark();
    await ui.evaluate(`window.dispatchEvent(new Event('visibilitychange'))`);
    const polled = await ui.request(m, 'GET', '/api/v1/tasks');
    assert.equal(polled.headers['X-Background'], '1', 'фоновый опрос помечен');
    m = ui.mark();
    await ui.click(`document.querySelector('.filters .arch-btn')`, '«Архив»');
    const clicked = await ui.request(m, 'GET', 'archived=true');
    assert.equal(clicked.headers['X-Background'], undefined, 'запрос по щелчку — действие пользователя');
  });

  it('форма входа: «Запомнить меня» включена по умолчанию и уходит в запросе; окна «Продолжить работу» больше нет', async () => {
    await logoutUi();
    assert.equal(await ui.evaluate(`document.querySelector('form.auth-card').getAttribute('method')`), 'post');
    assert.equal(await ui.evaluate(`document.querySelector('input[name=remember-me]').checked`), true);
    const m = ui.mark();
    await loginAs(staff.login, STAFF_PASSWORD);
    const req = await ui.request(m, 'POST', '/api/v1/auth/login');
    assert.equal(req.json.remember, true, 'remember в запросе');
    assert.equal((await ui.response(req)).session.remember, true, 'сессия «Запомнить меня»');
    assert.equal(await ui.evaluate(`!!document.querySelector('[aria-labelledby="sw-title"]')`), false);
  });

  it('«Профиль → Мои сессии»: текущая отмечена, «Завершить все, кроме текущей» закрывает остальные', async () => {
    const other = await nodeLogin(staff.login, STAFF_PASSWORD);
    await ui.click(`document.querySelector('a.me-t')`, 'имя в меню');
    await ui.waitFor(`location.pathname === '/profile'`, 'профиль');
    const rows = `document.querySelectorAll('.sessions-tbl tbody tr')`;
    await ui.waitFor(`${rows}.length >= 3`, 'сессии: браузер и две «других устройства»');
    assert.equal(await ui.evaluate(`[...${rows}].filter((tr) => tr.textContent.includes('Это устройство')).length`), 1);
    const m = ui.mark();
    await ui.click($.button('Завершить все, кроме текущей'));
    const res = await ui.request(m, 'POST', '/auth/sessions/revoke-others');
    assert.equal(res.status, 200);
    assert.ok((await ui.response(res)).revoked >= 2);
    await ui.waitFor(`${rows}.length === 1`, 'осталась текущая');
    assert.equal(await nodeMe(other), 401, 'сессия «другого устройства» закрыта');
    assert.equal(await ui.evaluate(`fetch('/api/v1/auth/me').then((r) => r.status)`), 200, 'текущая жива');
  });

  it('администратор: «Пользователи и роли» → «Сессии» → «Завершить все»', async () => {
    const device = await nodeLogin(staff.login, STAFF_PASSWORD);
    await logoutUi();
    await loginAs(LOGIN, PASSWORD);
    await ui.goto(`/settings/users?n=${++navSeq}`);
    // Пользователей на dev много (данные e2e): «Показать ещё», пока не появится строка.
    for (let i = 0; i < 40 && !(await ui.evaluate(`!!${$.row(staff.login)}`)); i++) {
      const more = $.button('Показать ещё');
      await ui.waitFor(`!!${$.row(staff.login)} || !!${more}`, 'строка пользователя или «Показать ещё»');
      if (await ui.evaluate(`!${$.row(staff.login)}`)) await ui.click(more, '«Показать ещё»');
    }
    await ui.waitFor(`!!${$.row(staff.login)}`, 'строка пользователя');
    await ui.click($.button('Сессии', $.row(staff.login)));
    const dlg = `document.querySelector('[role=dialog][aria-labelledby="us-title"]')`;
    await ui.waitFor(`${dlg}?.querySelectorAll('.sessions-tbl tbody tr').length === 1`, 'одна сессия пользователя');
    const m = ui.mark();
    await ui.click($.button('Завершить все', dlg));
    const res = await ui.request(m, 'POST', '/sessions/revoke-all');
    assert.equal(res.status, 200);
    assert.equal((await ui.response(res)).revoked, 1);
    await ui.waitFor(`${dlg}?.textContent.includes('Открытых сессий нет')`, 'сессий нет');
    assert.equal(await nodeMe(device), 401, 'сессия пользователя закрыта');
    await ui.click($.button('Закрыть', dlg));
  });

  it('сессия завершилась — вход с объяснением, после входа — та же страница', async () => {
    const path = `/tasks?task=${task.id}`;
    await ui.goto(path);
    await ui.waitFor(`!!document.querySelector('aside.drawer form.task-form')`, 'карточка задачи');
    // Сессию закрыл сервер (как по бездействию): cookie больше не действует.
    await ui.evaluate(`fetch('/api/v1/auth/logout', { method: 'POST' })`);
    await ui.evaluate(`window.dispatchEvent(new Event('visibilitychange'))`);
    await ui.waitFor(`location.pathname === '/login'`, 'страница входа');
    await ui.waitFor(`document.querySelector('.auth-card .note')?.textContent.includes('Сессия завершена')`, 'объяснение');
    await login();
    await ui.waitFor(`location.pathname + location.search === ${JSON.stringify(path)}`, 'та же страница');
    await ui.waitFor(`!!document.querySelector('aside.drawer form.task-form')`, 'карточка открыта снова');
  });
});
