// Сквозной тест служебной роли «Администратор портала» (релиз 1.8.0, ADR-0036): видит только «Настройки», не видит
// задач, реестров, документов и поиска; роль не совмещается с другими в форме пользователя; его нет в выборе
// исполнителя; его действия с доступом видны держателю «Журнала действий» цифрой у «Журнала». Люди вымышленные.
//
//   npm run test:e2e
//
// В конце: пользователи прогона отключаются.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { $, launchBrowser } from './browser.mjs';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const LOGIN = process.env.E2E_LOGIN;
const PASSWORD = process.env.E2E_PASSWORD;
const RUN = `E2E-${Date.now().toString(36)}`;

let ui;
let navSeq = 0;
const made = [];
let svc;
let auditor;

async function api(method, path, body) {
  const res = await ui.evaluate(`fetch(${JSON.stringify(path)}, ${JSON.stringify(body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })})
    .then(async (r) => ({ status: r.status, text: await r.text() }))`);
  assert.ok(res.status >= 200 && res.status < 300, `${method} ${path} → ${res.status} ${res.text}`);
  return res.text ? JSON.parse(res.text) : null;
}
const status = (path) => ui.evaluate(`fetch(${JSON.stringify(path)}).then(async (r) => ({ status: r.status, code: (await r.json().catch(() => ({})))?.error?.code ?? null }))`);

async function loginAs(login, password) {
  await api('POST', '/api/v1/auth/logout').catch(() => undefined);
  await ui.goto(`/login?n=${++navSeq}`);
  await ui.type(`document.querySelector('input[name=username]')`, login);
  await ui.type(`document.querySelector('input[name=password]')`, password);
  await ui.click(`document.querySelector('form button[type=submit]')`);
  await ui.waitFor(`location.pathname !== '/login'`, `вход ${login}`);
  if (await ui.evaluate(`location.pathname === '/change-password'`)) {
    const next = `Адм-${RUN.slice(4)}-Zq9!`;
    await ui.type(`document.querySelector('input[autocomplete=current-password]')`, password);
    await ui.type(`document.querySelectorAll('input[autocomplete=new-password]')[0]`, next);
    await ui.type(`document.querySelectorAll('input[autocomplete=new-password]')[1]`, next);
    await ui.click($.button('Сменить пароль'));
    await ui.waitFor(`location.pathname !== '/change-password'`, `смена пароля ${login}`);
    return next;
  }
  return password;
}

async function newUser(suffix, fullName, roleCodes) {
  const roles = (await api('GET', '/api/v1/roles')).items;
  const r = await api('POST', '/api/v1/users', { login: `${RUN.toLowerCase()}.${suffix}`, fullName, roleIds: roleCodes.map((c) => roles.find((x) => x.code === c).id) });
  const u = { id: r.user.id, login: r.user.login, password: r.temporaryPassword, fullName };
  made.push(u);
  return u;
}

before(async () => {
  assert.ok(LOGIN && PASSWORD, 'Задайте E2E_LOGIN и E2E_PASSWORD (пользователь с ролью «Супер-администратор»)');
  ui = await launchBrowser({ baseUrl: BASE });
  await loginAs(LOGIN, PASSWORD);
  svc = await newUser('svc', `Администратор Портала ${RUN}`, ['portal_admin']);
  auditor = await newUser('aud', `Сидорова С.С. ${RUN}`, ['ib_staff', 'ib_head']);
  svc.password = await loginAs(svc.login, svc.password);
  await loginAs(LOGIN, PASSWORD);
  auditor.password = await loginAs(auditor.login, auditor.password);
  await loginAs(LOGIN, PASSWORD);
});

after(async () => {
  if (!ui) return;
  try {
    await loginAs(LOGIN, PASSWORD).catch(() => undefined);
    // Уведомления прогона о действиях служебного администратора — прочитать: иначе у «Журнала» копится цифра.
    const unread = await api('GET', '/api/v1/notifications?unread=true&limit=100').catch(() => ({ items: [] }));
    for (const n of unread.items ?? []) {
      if (n.kind === 'service_admin_action' && n.title.includes(RUN)) await api('POST', `/api/v1/notifications/${n.id}/read`).catch(() => undefined);
    }
    for (const u of made) {
      const cur = (await api('GET', `/api/v1/users?q=${encodeURIComponent(u.login)}`).catch(() => ({ items: [] }))).items.find((x) => x.id === u.id);
      if (cur?.isActive) await api('POST', `/api/v1/users/${u.id}/disable`, { version: cur.version }).catch(() => undefined);
    }
    assert.deepEqual(ui.consoleErrors.filter((e) => !/403/.test(e)), [], 'ошибки JavaScript в странице');
  } finally {
    ui.close();
  }
});

describe('Служебная роль «Администратор портала» (1.8.0)', () => {
  it('видит только «Настройки»; задачи, реестры, документы, поиск — нет; «Ответственных лиц» в справочниках нет', async () => {
    await loginAs(svc.login, svc.password);
    await ui.waitFor(`location.pathname.startsWith('/settings')`, 'стартовая — «Настройки»');
    assert.deepEqual(await ui.evaluate(`[...document.querySelectorAll('nav.nav a span')].map((s) => s.textContent)`), ['Настройки']);
    assert.equal(await ui.evaluate(`!!document.querySelector('input[aria-label="Поиск по порталу"]')`), false, 'строки поиска нет');
    for (const path of ['/api/v1/tasks', '/api/v1/registers', '/api/v1/documents', '/api/v1/search?q=тест', '/api/v1/settings/party-directory']) {
      assert.deepEqual(await status(path), { status: 403, code: 'SERVICE_ACCOUNT' }, path);
    }
    // Прямая ссылка на раздел ИБ — обратно в настройки.
    await ui.goto(`/tasks?n=${++navSeq}`);
    await ui.waitFor(`location.pathname.startsWith('/settings')`, 'раздел «Задачи» закрыт');
    await ui.goto(`/settings/catalogs?n=${++navSeq}`);
    await ui.waitFor(`document.querySelectorAll('.reglist button').length > 0`, 'справочники');
    assert.equal(await ui.evaluate(`[...document.querySelectorAll('.reglist button')].some((b) => b.textContent.includes('Ответственные лица'))`), false);
  });

  it('форма пользователя: служебная роль не совмещается с другими', async () => {
    await loginAs(svc.login, svc.password);
    await ui.goto(`/settings/users?n=${++navSeq}`);
    const form = `document.querySelector('form.user-add')`;
    await ui.waitFor(`${form}?.querySelectorAll('.role-checks input').length > 1`, 'форма с ролями');
    const box = (name) => `[...${form}.querySelectorAll('.role-checks label')].find((l) => l.textContent.startsWith(${JSON.stringify(name)}))?.querySelector('input')`;
    await ui.click(box('Сотрудник ИБ'), 'роль «Сотрудник ИБ»');
    assert.equal(await ui.evaluate(`${box('Администратор портала')}.disabled`), true, 'с другой ролью служебная недоступна');
    await ui.click(box('Сотрудник ИБ'), 'снять «Сотрудник ИБ»');
    await ui.click(box('Администратор портала'), 'служебная роль');
    assert.equal(await ui.evaluate(`${box('Сотрудник ИБ')}.disabled`), true, 'со служебной остальные недоступны');
  });

  it('действия с доступом видны держателю «Журнала действий»; служебного нет в выборе исполнителя', async () => {
    await loginAs(svc.login, svc.password);
    // Служебный администратор заводит пользователя с ролью — держатель audit.view получает запись в индикаторе.
    await newUser('new', `Петров П.П. ${RUN}`, ['ib_staff']);
    await loginAs(auditor.login, auditor.password);
    const attention = await api('GET', '/api/v1/me/attention');
    assert.ok(attention.audit >= 1, 'в индикаторе есть действие служебного администратора');
    await ui.goto(`/tasks?n=${++navSeq}`);
    await ui.waitFor(`!!document.querySelector('[data-testid=nav-audit-n]')`, 'цифра у «Журнала»');
    // Выбор исполнителя (начальник ИБ — «постановка другим»): служебного нет, сотрудники есть.
    await ui.waitFor(`document.querySelector('form.quick select[aria-label="Ответственный"]')?.options.length > 2`, 'список исполнителей');
    const names = await ui.evaluate(`[...document.querySelector('form.quick select[aria-label="Ответственный"]').options].map((o) => o.textContent)`);
    assert.equal(names.some((n) => n.includes(svc.fullName)), false, 'служебного нет среди исполнителей');
    assert.equal(names.some((n) => n.includes(auditor.fullName)), true);
    // Уведомление ведёт в журнал по служебному пользователю.
    const list = await api('GET', '/api/v1/notifications?unread=true');
    const note = list.items.find((n) => n.kind === 'service_admin_action');
    assert.ok(note, 'уведомление о действии служебного администратора');
    assert.equal(note.link, `/audit?userId=${svc.id}`);
  });
});
