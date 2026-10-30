// Уведомления (релиз 1.2.0, ADR-0023): значок в меню, число в заголовке вкладки, список, переход к задаче, «Прочитать все».
// С 1.4.0 число на значке и в заголовке — «ждёт вашего действия» (GET /me/attention), непрочитанные — только в списке.
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
  it('исполнитель: назначение — уведомление в списке (выделено), на значке и в заголовке цифры нет; щелчок открывает задачу', async () => {
    const category = (await api('GET', '/api/v1/catalogs/task_categories/items')).items.find((c) => !c.systemKey);
    task = await api('POST', '/api/v1/tasks', { title: `${RUN} проверить доступ`, categoryId: category.id, assigneeId: staff.id });
    staff.password = await loginAs(staff.login, staff.password);
    await ui.goto(`/dashboard?n=${++navSeq}`);
    // Цифра на значке — только «ждёт вашего действия» (1.4.0): у исполнителя ничего не ждёт его проверки.
    const att = await api('GET', '/api/v1/me/attention');
    assert.deepEqual([att.tasks, att.total], [0, att.documents]);
    await ui.waitFor(`document.querySelectorAll('nav.nav a').length > 0`, 'меню');
    assert.equal(await ui.evaluate(`document.querySelector('[data-testid=bell-count]')?.textContent ?? null`), att.total ? String(att.total) : null, 'на значке — сумма «ждёт вашего действия»');
    assert.equal(await ui.evaluate(`!!document.querySelector('[data-testid=nav-tasks-n]')`), false, 'у «Задачи» цифры нет');
    await ui.click(bell, 'значок');
    await ui.waitFor(`${item(`${RUN} проверить доступ`)}?.classList.contains('unread')`, 'непрочитанное выделено в списке');
    assert.match(await ui.text(`[...${pop}.querySelectorAll('.notif-tabs button')][0]`), /^Непрочитанные · \d+$/);
    assert.match(await ui.text(item(`${RUN} проверить доступ`)), /Вам назначена задача .*Назначил: Начальник Уведомлений/);
    const m = ui.mark();
    await ui.click(item(`${RUN} проверить доступ`));
    assert.equal((await ui.request(m, 'POST', '/read')).status, 204);
    await ui.waitFor(`location.pathname === '/tasks' && location.search.includes(${JSON.stringify(task.id)})`, 'переход к задаче');
    await ui.waitFor(`!!document.querySelector('aside.drawer form.task-form')`, 'карточка задачи');

    // Шаги процесса: в работу и на проверку — проверяет руководитель (начальник прогона).
    let t = await api('POST', `/api/v1/tasks/${task.id}/actions/start`, { version: (await api('GET', `/api/v1/tasks/${task.id}`)).version });
    t = await api('POST', `/api/v1/tasks/${task.id}/actions/submit`, { version: t.version, comment: 'Доступ проверен' });
    assert.equal(t.reviewer?.id, head.id);
    task = t;
  });

  it('проверяющий: на значке, в заголовке и у «Задачи» — 1; «Прочитать все» цифру не меняет; принял — цифра пропала; у исполнителя — 0', async () => {
    head.password = await loginAs(head.login, head.password);
    await ui.goto(`/dashboard?n=${++navSeq}`);
    const att = await api('GET', '/api/v1/me/attention');
    assert.equal(att.tasks, 1, 'одна задача на проверке у начальника');
    const total = String(att.total);
    await ui.waitFor(`document.querySelector('[data-testid=bell-count]')?.textContent === ${JSON.stringify(total)}`, `значок: ${total}`);
    await ui.waitFor(`document.title === ${JSON.stringify(`(${total}) Портал ИБ`)}`, 'число в заголовке вкладки');
    await ui.waitFor(`document.querySelector('[data-testid=nav-tasks-n]')?.textContent === '1'`, '«Задачи»: 1');

    await ui.click(bell, 'значок');
    await ui.waitFor(`${item('ждёт вашей проверки')}?.textContent.includes('Доступ проверен')`, '«ждёт вашей проверки» с комментарием');
    const m = ui.mark();
    await ui.click($.button('Прочитать все', pop));
    assert.deepEqual((await ui.request(m, 'POST', '/notifications/read-all')).status, 200);
    await ui.waitFor(`${pop}?.textContent.includes('Новых уведомлений нет')`, 'непрочитанных нет');
    assert.equal(await ui.evaluate(`document.querySelector('[data-testid=bell-count]')?.textContent`), total, 'прочитанные уведомления не меняют цифру: задача всё ещё ждёт проверки');
    await ui.click(`[...${pop}.querySelectorAll('.notif-tabs button')].find((b) => b.textContent === 'Все')`);
    await ui.waitFor(`!!${item('ждёт вашей проверки')} && !${item('ждёт вашей проверки')}.classList.contains('unread')`, 'во «Все» — прочитанным');
    await ui.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    await ui.waitFor(`!${pop}`, 'панель закрыта');

    // Начальник принимает в карточке — цифра пропадает сразу (действие пересчитывает «ждёт вашего действия»).
    await ui.goto(`/tasks?task=${task.id}&n=${++navSeq}`);
    await ui.waitFor(`!!document.querySelector('aside.drawer .process')`, 'карточка проверки');
    await ui.click($.button('Принять', `document.querySelector('aside.drawer')`));
    await ui.type(`document.querySelector('aside.drawer textarea[aria-label="Комментарий к шагу"]')`, 'Принято');
    const acc = ui.mark();
    await ui.click($.button('Принять', `document.querySelector('aside.drawer')`));
    assert.equal((await ui.request(acc, 'POST', `/api/v1/tasks/${task.id}/actions/accept`)).status, 200);
    await ui.waitFor(`!document.querySelector('[data-testid=nav-tasks-n]')`, '«Задачи»: цифры нет');
    const after = await api('GET', '/api/v1/me/attention');
    assert.equal(after.tasks, 0);
    assert.equal(await ui.evaluate(`document.querySelector('[data-testid=bell-count]')?.textContent ?? null`), after.total ? String(after.total) : null);
    const count = await api('GET', '/api/v1/notifications/count');
    assert.equal(count.unread, 0, 'о собственном действии уведомления нет');
  });
});
