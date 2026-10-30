// Уведомления (релиз 1.2.0, ADR-0023): значок в меню, число в заголовке вкладки, список, переход к задаче, «Прочитать все».
// Пользователи прогона: начальник ИБ и его подчинённый; создаёт их супер-администратор из E2E_LOGIN.
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
let head;
let staff;
let task;

async function api(method, path, body) {
  const res = await ui.evaluate(`fetch(${JSON.stringify(path)}, ${JSON.stringify(body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })})
    .then(async (r) => ({ status: r.status, text: await r.text() }))`);
  assert.ok(res.status >= 200 && res.status < 300, `${method} ${path} → ${res.status} ${res.text}`);
  return res.text ? JSON.parse(res.text) : null;
}

async function loginAs(login, password) {
  if (!(await ui.evaluate(`location.origin.startsWith('http')`))) await ui.goto(`/login?n=${++navSeq}`);
  await ui.evaluate(`fetch('/api/v1/auth/logout', { method: 'POST' })`);
  await ui.goto(`/login?n=${++navSeq}`);
  await ui.type(`document.querySelector('input[name=username]')`, login);
  await ui.type(`document.querySelector('input[name=password]')`, password);
  await ui.click(`document.querySelector('form button[type=submit]')`);
  await ui.waitFor(`location.pathname !== '/login'`, `вход ${login}`);
  if (await ui.evaluate(`location.pathname === '/change-password'`)) {
    const next = `Уведом-${RUN.slice(4)}-Zq9!`;
    await ui.type(`document.querySelector('input[autocomplete=current-password]')`, password);
    await ui.type(`document.querySelectorAll('input[autocomplete=new-password]')[0]`, next);
    await ui.type(`document.querySelectorAll('input[autocomplete=new-password]')[1]`, next);
    await ui.click($.button('Сменить пароль'));
    await ui.waitFor(`location.pathname !== '/change-password'`, `смена пароля ${login}`);
    return next;
  }
  return password;
}

const bell = `document.querySelector('button.bell')`;
const pop = `document.querySelector('.notif-pop')`;
const item = (text) => `[...document.querySelectorAll('.notif-pop .notif')].find((n) => n.textContent.includes(${JSON.stringify(text)}))`;

before(async () => {
  assert.ok(LOGIN && PASSWORD, 'Задайте E2E_LOGIN и E2E_PASSWORD (пользователь с ролью «Супер-администратор»)');
  ui = await launchBrowser({ baseUrl: BASE });
  await loginAs(LOGIN, PASSWORD);
  const roles = (await api('GET', '/api/v1/roles')).items;
  const id = (code) => roles.find((r) => r.code === code).id;
  const h = await api('POST', '/api/v1/users', { login: `${RUN.toLowerCase()}.nhead`, fullName: `Начальник Уведомлений ${RUN}`, roleIds: [id('ib_staff'), id('ib_head')] });
  head = { id: h.user.id, login: h.user.login, password: h.temporaryPassword };
  const s = await api('POST', '/api/v1/users', { login: `${RUN.toLowerCase()}.nstaff`, fullName: `Исполнитель Уведомлений ${RUN}`, roleIds: [id('ib_staff')], managerId: head.id });
  staff = { id: s.user.id, login: s.user.login, password: s.temporaryPassword };
  // Первый вход каждого — смена временного пароля.
  staff.password = await loginAs(staff.login, staff.password);
  head.password = await loginAs(head.login, head.password);
});

after(async () => {
  if (!ui) return;
  await loginAs(LOGIN, PASSWORD).catch(() => undefined);
  if (task) {
    const t = await api('GET', `/api/v1/tasks/${task.id}`).catch(() => null);
    if (t && !t.archived) await api('POST', `/api/v1/tasks/${task.id}/archive`, { version: t.version }).catch(() => undefined);
  }
  for (const u of [staff, head].filter(Boolean)) {
    const cur = (await api('GET', `/api/v1/users?q=${encodeURIComponent(u.login)}`).catch(() => ({ items: [] }))).items.find((x) => x.id === u.id);
    if (cur?.isActive) await api('POST', `/api/v1/users/${u.id}/disable`, { version: cur.version }).catch(() => undefined);
  }
  assert.deepEqual(ui.consoleErrors, [], 'ошибки JavaScript в странице');
  ui.close();
});

describe('Уведомления', () => {
  it('исполнитель: значок и «(1) Портал ИБ», щелчок открывает задачу и гасит значок', async () => {
    const category = (await api('GET', '/api/v1/catalogs/task_categories/items')).items.find((c) => !c.systemKey);
    task = await api('POST', '/api/v1/tasks', { title: `${RUN} проверить доступ`, categoryId: category.id, assigneeId: staff.id });
    staff.password = await loginAs(staff.login, staff.password);
    await ui.goto(`/dashboard?n=${++navSeq}`);
    await ui.waitFor(`document.querySelector('[data-testid=bell-count]')?.textContent === '1'`, 'значок: 1');
    await ui.waitFor(`document.title === '(1) Портал ИБ'`, 'число в заголовке вкладки');
    await ui.click(bell, 'значок');
    await ui.waitFor(`!!${item(`${RUN} проверить доступ`)}`, 'уведомление в списке');
    assert.match(await ui.text(item(`${RUN} проверить доступ`)), /Вам назначена задача .*Назначил: Начальник Уведомлений/);
    const m = ui.mark();
    await ui.click(item(`${RUN} проверить доступ`));
    assert.equal((await ui.request(m, 'POST', '/read')).status, 204);
    await ui.waitFor(`location.pathname === '/tasks' && location.search.includes(${JSON.stringify(task.id)})`, 'переход к задаче');
    await ui.waitFor(`!!document.querySelector('aside.drawer form.task-form')`, 'карточка задачи');
    await ui.waitFor(`!document.querySelector('[data-testid=bell-count]') && document.title === 'Портал ИБ'`, 'значок погас');

    // Шаги процесса: в работу и на проверку — уведомление руководителю.
    let t = await api('POST', `/api/v1/tasks/${task.id}/actions/start`, { version: (await api('GET', `/api/v1/tasks/${task.id}`)).version });
    t = await api('POST', `/api/v1/tasks/${task.id}/actions/submit`, { version: t.version, comment: 'Доступ проверен' });
    task = t;
  });

  it('руководитель-проверяющий: «ждёт вашей проверки» с комментарием; «Прочитать все» обнуляет; о своём действии — ничего', async () => {
    head.password = await loginAs(head.login, head.password);
    await ui.goto(`/dashboard?n=${++navSeq}`);
    await ui.waitFor(`document.querySelector('[data-testid=bell-count]')?.textContent === '1'`, 'значок: 1');
    await ui.click(bell, 'значок');
    await ui.waitFor(`${item('ждёт вашей проверки')}?.textContent.includes('Доступ проверен')`, '«ждёт вашей проверки» с комментарием');
    const m = ui.mark();
    await ui.click($.button('Прочитать все', pop));
    assert.deepEqual((await ui.request(m, 'POST', '/notifications/read-all')).status, 200);
    await ui.waitFor(`!document.querySelector('[data-testid=bell-count]') && document.title === 'Портал ИБ'`, 'значок погас');
    await ui.waitFor(`${pop}?.textContent.includes('Новых уведомлений нет')`, 'непрочитанных нет');
    await ui.click(`[...${pop}.querySelectorAll('.notif-tabs button')].find((b) => b.textContent === 'Все')`);
    await ui.waitFor(`!!${item('ждёт вашей проверки')} && !${item('ждёт вашей проверки')}.classList.contains('unread')`, 'во «Все» — прочитанным');
    await ui.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    await ui.waitFor(`!${pop}`, 'панель закрыта');

    // Начальник принимает — уведомление получает исполнитель, сам начальник — нет.
    await api('POST', `/api/v1/tasks/${task.id}/actions/accept`, { version: task.version, comment: 'Принято' });
    const count = await api('GET', '/api/v1/notifications/count');
    assert.equal(count.unread, 0, 'о собственном действии уведомления нет');
  });
});
