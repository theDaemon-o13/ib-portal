// Сессия (релиз 1.2.0, ADR-0023): опрос по таймеру не продлевает сессию (X-Background: 1),
// за 2 минуты до завершения — «Продолжить работу», после завершения — вход с объяснением и возврат на ту же страницу.
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
});

after(async () => {
  if (!ui) return;
  const t = await api('GET', `/api/v1/tasks/${task.id}`).catch(() => null);
  if (t && !t.archived) await api('POST', `/api/v1/tasks/${task.id}/archive`, { version: t.version }).catch(() => undefined);
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

  it('за 2 минуты — «Сессия завершится через 2 минуты»; «Продолжить работу» продлевает', async () => {
    await ui.goto(`/tasks?n=${++navSeq}`);
    await ui.waitFor(`document.querySelectorAll('.board .col').length >= 5`, 'доска');
    // Сервер «сообщает», что до завершения 90 секунд: подмена заголовка ответа в странице.
    await ui.evaluate(`(() => { const orig = window.fetch; window.__origFetch = orig;
      window.fetch = async (...a) => { const r = await orig(...a); const h = new Headers(r.headers);
        if (h.has('X-Session-Idle-Ms')) h.set('X-Session-Idle-Ms', '90000');
        return new Response(r.status === 204 ? null : await r.blob(), { status: r.status, statusText: r.statusText, headers: h }); }; })()`);
    await ui.evaluate(`window.dispatchEvent(new Event('visibilitychange'))`);
    const dlg = `document.querySelector('[role=alertdialog][aria-labelledby="sw-title"]')`;
    await ui.waitFor(`${dlg}?.textContent.includes('Сессия завершится через 2 минуты')`, 'предупреждение');
    await ui.evaluate(`window.fetch = window.__origFetch`);
    const m = ui.mark();
    await ui.click($.button('Продолжить работу', dlg));
    const ping = await ui.request(m, 'GET', '/api/v1/auth/me');
    assert.equal(ping.status, 200);
    assert.equal(ping.headers['X-Background'], undefined, '«Продолжить работу» продлевает сессию');
    await ui.waitFor(`!${dlg}`, 'предупреждение закрыто');
  });

  it('сессия завершилась — вход с объяснением, после входа — та же страница', async () => {
    const path = `/tasks?task=${task.id}`;
    await ui.goto(path);
    await ui.waitFor(`!!document.querySelector('aside.drawer form.task-form')`, 'карточка задачи');
    // Сессию закрыл сервер (как по бездействию): cookie больше не действует.
    await ui.evaluate(`fetch('/api/v1/auth/logout', { method: 'POST' })`);
    await ui.evaluate(`window.dispatchEvent(new Event('visibilitychange'))`);
    await ui.waitFor(`location.pathname === '/login'`, 'страница входа');
    await ui.waitFor(`document.querySelector('.auth-card .note')?.textContent.includes('Сессия завершилась')`, 'объяснение');
    await login();
    await ui.waitFor(`location.pathname + location.search === ${JSON.stringify(path)}`, 'та же страница');
    await ui.waitFor(`!!document.querySelector('aside.drawer form.task-form')`, 'карточка открыта снова');
  });
});
