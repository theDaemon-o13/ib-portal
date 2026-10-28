// Сквозной тест страницы входа: «показать пароль» и «Запомнить логин».
// Пароль не должен оказаться ни в localStorage, ни в sessionStorage, ни в cookie, доступной странице.
//
//   npm run test:e2e   (логин и пароль — из frontend/.env.e2e или E2E_LOGIN / E2E_PASSWORD)
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { launchBrowser } from './browser.mjs';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const LOGIN = process.env.E2E_LOGIN;
const PASSWORD = process.env.E2E_PASSWORD;

const username = `document.querySelector('input[name=username]')`;
const password = `document.querySelector('input[name=password]')`;
const toggle = `document.querySelector('.pass-toggle')`;
const remember = `document.querySelector('input[name=remember-login]')`;

let ui;

before(async () => {
  assert.ok(LOGIN && PASSWORD, 'Задайте E2E_LOGIN и E2E_PASSWORD');
  ui = await launchBrowser({ baseUrl: BASE });
});

after(() => {
  if (!ui) return;
  assert.deepEqual(ui.consoleErrors, [], 'ошибки JavaScript в странице');
  ui.close();
});

async function logout() {
  await ui.evaluate(`fetch('/api/v1/auth/logout', { method: 'POST' })`);
  await ui.goto('/login');
  await ui.waitFor(`!!${password}`, 'форма входа');
}

/** Всё, что страница может прочитать сама: хранилища и cookie без HttpOnly. */
const pageStorage = () => ui.evaluate(`JSON.stringify({
  local: Object.fromEntries(Object.entries(localStorage)),
  session: Object.fromEntries(Object.entries(sessionStorage)),
  cookie: document.cookie,
})`);

describe('Вход', () => {
  it('кнопка показывает и скрывает пароль', async () => {
    await ui.goto('/login');
    await ui.evaluate(`localStorage.removeItem('ibportal.login')`);
    await ui.goto('/login');
    await ui.type(password, 'Secret-Typed-123');
    assert.equal(await ui.evaluate(`${password}.type`), 'password');
    assert.equal(await ui.evaluate(`${toggle}.getAttribute('aria-pressed')`), 'false');

    await ui.click(toggle, '«Показать пароль»');
    await ui.waitFor(`${password}.type === 'text'`, 'пароль виден');
    assert.equal(await ui.evaluate(`${toggle}.getAttribute('aria-label')`), 'Скрыть пароль');
    assert.equal(await ui.evaluate(`${password}.value`), 'Secret-Typed-123');

    await ui.click(toggle, '«Скрыть пароль»');
    await ui.waitFor(`${password}.type === 'password'`, 'пароль скрыт');
  });

  it('«Запомнить логин» сохраняет только логин; без галочки он забывается', async () => {
    await ui.goto('/login');
    assert.equal(await ui.evaluate(`${remember}.checked`), false);
    await ui.type(username, LOGIN);
    await ui.type(password, PASSWORD);
    await ui.click(remember, '«Запомнить логин»');
    await ui.click(toggle, '«Показать пароль»');
    await ui.click(`document.querySelector('form button[type=submit]')`, '«Войти»');
    await ui.waitFor(`location.pathname !== '/login'`, 'вход');

    const stored = await pageStorage();
    assert.ok(!stored.includes(PASSWORD), `пароль попал в хранилище страницы: ${stored}`);
    assert.equal(await ui.evaluate(`localStorage.getItem('ibportal.login')`), LOGIN);

    await logout();
    assert.equal(await ui.evaluate(`${username}.value`), LOGIN, 'логин подставлен');
    assert.equal(await ui.evaluate(`${remember}.checked`), true);
    assert.equal(await ui.evaluate(`${password}.value`), '', 'пароль портал не подставляет');

    await ui.type(password, PASSWORD);
    await ui.click(remember, 'снять «Запомнить логин»');
    await ui.click(`document.querySelector('form button[type=submit]')`, '«Войти»');
    await ui.waitFor(`location.pathname !== '/login'`, 'вход');
    assert.equal(await ui.evaluate(`localStorage.getItem('ibportal.login')`), null);
    assert.ok(!(await pageStorage()).includes(PASSWORD));
  });
});
