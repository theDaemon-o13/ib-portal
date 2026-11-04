// Сквозной тест цепочек задач (релиз 1.7.0, ADR-0035): подсказка под названием в быстрой строке и в «Задаче из письма»,
// добавление в цепочку при создании, «Вернуть в работу и добавить», блок «Цепочка» в карточке, отвязка.
// Заголовки вымышленные, с меткой прогона.
//
//   npm run test:e2e
//
// В конце: цепочки прогона удаляются (мягко, задачи отвязываются), задачи прогона — в архив.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { $, launchBrowser } from './browser.mjs';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const LOGIN = process.env.E2E_LOGIN;
const PASSWORD = process.env.E2E_PASSWORD;
const RUN = `E2E-${Date.now().toString(36)}`;

let ui;
let me;
let category;
let navSeq = 0;
const drawer = `document.querySelector('aside.drawer[aria-label="Задача"]')`;
const mailDrawer = `document.querySelector('aside.drawer[aria-label="Задача из письма"]')`;
const suggest = (within = 'document') => `(${within}).querySelector('[data-testid=chain-suggest]')`;
const suggestItem = (title, within = 'document') => `(${within}).querySelector(${JSON.stringify(`[data-testid=chain-suggest] [data-chain="${title}"]`)})`;

async function api(method, path, body) {
  const res = await ui.evaluate(`fetch(${JSON.stringify(path)}, ${JSON.stringify(body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })})
    .then(async (r) => ({ status: r.status, text: await r.text() }))`);
  assert.ok(res.status >= 200 && res.status < 300, `${method} ${path} → ${res.status} ${res.text}`);
  return res.text ? JSON.parse(res.text) : null;
}

const makeTask = (title, extra = {}) => api('POST', '/api/v1/tasks', { title, categoryId: category.id, assigneeId: me.id, ...extra });
/** Цепочка из одной задачи через API. */
async function makeChain(title, taskTitle = title) {
  const t = await makeTask(taskTitle);
  return api('POST', '/api/v1/task-chains', { title, tasks: [{ id: t.id, version: t.version }] });
}

async function openBoard() {
  await ui.goto(`/tasks?run=${++navSeq}`);
  await ui.waitFor(`document.querySelectorAll('.board .col').length >= 5`, 'доска');
}

before(async () => {
  assert.ok(LOGIN && PASSWORD, 'Задайте E2E_LOGIN и E2E_PASSWORD');
  ui = await launchBrowser({ baseUrl: BASE });
  await ui.goto(`/login?n=${++navSeq}`);
  await ui.type(`document.querySelector('input[name=username]')`, LOGIN);
  await ui.type(`document.querySelector('input[name=password]')`, PASSWORD);
  await ui.click(`document.querySelector('form button[type=submit]')`);
  await ui.waitFor(`location.pathname !== '/login'`, 'вход');
  me = (await api('GET', '/api/v1/auth/me')).user;
  const cats = (await api('GET', '/api/v1/catalogs/task_categories/items')).items;
  category = cats.find((c) => !c.systemKey) ?? cats[0];
});

after(async () => {
  if (!ui) return;
  try {
    for (const c of (await api('GET', `/api/v1/task-chains?q=${encodeURIComponent(RUN)}`).catch(() => ({ items: [] }))).items) {
      if (c.title.includes(RUN)) await api('POST', `/api/v1/task-chains/${c.id}/delete`, { version: c.version }).catch(() => undefined);
    }
    for (const archived of [false]) {
      const page = await api('GET', `/api/v1/tasks?archived=${archived}`).catch(() => ({ items: [] }));
      for (const t of page.items.filter((x) => x.title.includes(RUN))) await api('POST', `/api/v1/tasks/${t.id}/archive`, { version: t.version }).catch(() => undefined);
    }
    assert.deepEqual(ui.consoleErrors, [], 'ошибки JavaScript в странице');
  } finally {
    ui.close();
  }
});

describe('Цепочки задач (1.7.0)', () => {
  it('быстрая задача «RE: …» → подсказка → «Добавить в цепочку» → задача в цепочке, блок в карточке, отвязка', async () => {
    const theme = `Тестовая тема ${RUN}`;
    const chain = await makeChain(theme);
    await openBoard();
    await ui.type(`document.querySelector('input[aria-label="Новая задача"]')`, `RE: ${theme}`);
    await ui.waitFor(`!!${suggestItem(theme)}`, 'подсказка «Похоже на цепочку»');
    assert.match(await ui.text(suggestItem(theme)), /1 задача, 0 выполнено/);
    await ui.click($.button('Добавить в цепочку', suggestItem(theme)));
    await ui.waitFor(`!!document.querySelector('[data-testid=chain-choice]')`, 'выбор запомнен до создания');
    const m = ui.mark();
    await ui.click($.button('Назначить'));
    const created = await ui.request(m, 'POST', '/api/v1/tasks');
    assert.equal(created.status, 201, created.body);
    assert.deepEqual(created.json.chain, { id: chain.id }, 'выбор из подсказки уходит вместе с задачей');
    const task = await ui.response(created);
    assert.equal(task.chain.id, chain.id);
    await ui.waitFor(`!document.querySelector('[data-testid=chain-choice]') && !${suggest()}`, 'после создания подсказка и выбор сброшены');

    // Карточка: блок «Цепочка» с хронологией из двух задач, переход к первой.
    await ui.goto(`/tasks?run=${++navSeq}&task=${task.id}`);
    const block = `${drawer}?.querySelector('[data-testid=chain-block]')`;
    await ui.waitFor(`${block}?.querySelectorAll('.chain-timeline li').length === 2`, 'хронология цепочки');
    assert.match(await ui.text(block), new RegExp(theme));
    assert.match(await ui.text(`${block}.querySelector('li.cur')`), /эта задача/);

    // Отвязать: блок цепочки пропадает, задача остаётся.
    const m2 = ui.mark();
    await ui.click($.button('Отвязать', block));
    const detached = await ui.request(m2, 'POST', `/api/v1/task-chains/${chain.id}/tasks/${task.id}/detach`);
    assert.equal(detached.status, 200, detached.body);
    await ui.waitFor(`!${block} && !!${drawer}?.querySelector('[aria-label="Цепочка"]')`, 'задача без цепочки');
    const after1 = await api('GET', `/api/v1/tasks/${task.id}`);
    assert.equal(after1.chain, null);
    assert.equal(after1.archived, false);
  });

  it('«Задача из письма» с темой «FW: RE: …»: подсказка по теме; цепочка с выполненной архивной задачей остаётся в подсказке', async () => {
    const theme = `Тема письма ${RUN}`;
    const chain = await makeChain(theme);
    // Единственная задача цепочки — выполнена и в архиве.
    const [t] = (await api('GET', `/api/v1/task-chains/${chain.id}`)).tasks;
    let task = await api('GET', `/api/v1/tasks/${t.id}`);
    for (const action of ['start', 'complete']) task = await api('POST', `/api/v1/tasks/${t.id}/actions/${action}`, { version: task.version, comment: 'Тестовый шаг' });
    await api('POST', `/api/v1/tasks/${t.id}/archive`, { version: task.version });

    await openBoard();
    await ui.click($.button('Задача из письма'));
    await ui.waitFor(`!!${mailDrawer}`, 'окно «Задача из письма»');
    const raw = `От: Отдел тестирования <test@example.local>\nОтправлено: 04.11.2026 10:15\nТема: FW: RE: ${theme}\n\nПросим проверить.`;
    await ui.type(`${mailDrawer}.querySelector('textarea[aria-label="Текст письма"]')`, raw);
    await ui.click($.button('Разобрать письмо', mailDrawer));
    await ui.waitFor(`!!${suggestItem(theme, mailDrawer)}`, 'подсказка по теме письма');
    assert.match(await ui.text(suggestItem(theme, mailDrawer)), /1 задача, 1 выполнена/);
    await ui.click($.button('Добавить в цепочку', suggestItem(theme, mailDrawer)));
    const m = ui.mark();
    await ui.click($.button('Создать задачу', mailDrawer));
    const created = await ui.request(m, 'POST', '/api/v1/tasks');
    assert.equal(created.status, 201, created.body);
    const made = await ui.response(created);
    assert.equal(made.title, theme, 'название без «FW: RE:»');
    assert.equal(made.chain.id, chain.id);
    const detail = await api('GET', `/api/v1/task-chains/${chain.id}`);
    assert.deepEqual(detail.counts, { total: 2, done: 1 });
    assert.equal(detail.tasks[0].archived, true, 'архивная задача — в хронологии');
  });

  it('закрытая цепочка: «Вернуть в работу и добавить» открывает её заново', async () => {
    const theme = `Закрытая тема ${RUN}`;
    const chain = await makeChain(theme);
    const closed = await api('POST', `/api/v1/task-chains/${chain.id}/close`, { version: chain.version });
    assert.equal(closed.status, 'closed');
    await openBoard();
    await ui.type(`document.querySelector('input[aria-label="Новая задача"]')`, `Отв: ${theme}`);
    await ui.waitFor(`!!${suggestItem(theme)}`, 'подсказка с закрытой цепочкой');
    assert.match(await ui.text(suggestItem(theme)), /закрыта, есть незавершённые задачи/);
    await ui.click($.button('Вернуть в работу и добавить', suggestItem(theme)));
    const m = ui.mark();
    await ui.click($.button('Назначить'));
    const created = await ui.request(m, 'POST', '/api/v1/tasks');
    assert.equal(created.status, 201, created.body);
    const detail = await api('GET', `/api/v1/task-chains/${chain.id}`);
    assert.equal(detail.status, 'open');
    assert.equal(detail.counts.total, 2);
  });
});
