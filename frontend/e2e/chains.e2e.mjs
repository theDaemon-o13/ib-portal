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
let reader;
let head;
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

/** Войти через форму; при первом входе — смена временного пароля. */
async function loginAs(login, password) {
  await api('POST', '/api/v1/auth/logout').catch(() => undefined);
  await ui.goto(`/login?n=${++navSeq}`);
  await ui.type(`document.querySelector('input[name=username]')`, login);
  await ui.type(`document.querySelector('input[name=password]')`, password);
  await ui.click(`document.querySelector('form button[type=submit]')`);
  await ui.waitFor(`location.pathname !== '/login'`, `вход ${login}`);
  if (await ui.evaluate(`location.pathname === '/change-password'`)) {
    const next = `Цеп-${RUN.slice(4)}-Zq9!`;
    await ui.type(`document.querySelector('input[autocomplete=current-password]')`, password);
    await ui.type(`document.querySelectorAll('input[autocomplete=new-password]')[0]`, next);
    await ui.type(`document.querySelectorAll('input[autocomplete=new-password]')[1]`, next);
    await ui.click($.button('Сменить пароль'));
    await ui.waitFor(`location.pathname !== '/change-password'`, `смена пароля ${login}`);
    return next;
  }
  return password;
}

/** Выполнить задачу кнопками процесса (исполнитель — вошедший, руководителя нет). */
async function complete(id) {
  let t = await api('GET', `/api/v1/tasks/${id}`);
  for (const action of ['start', 'complete']) t = await api('POST', `/api/v1/tasks/${id}/actions/${action}`, { version: t.version, comment: 'Тестовый шаг' });
  return t;
}

before(async () => {
  assert.ok(LOGIN && PASSWORD, 'Задайте E2E_LOGIN и E2E_PASSWORD');
  ui = await launchBrowser({ baseUrl: BASE });
  await ui.goto(`/login?n=${++navSeq}`);
  await loginAs(LOGIN, PASSWORD);
  me = (await api('GET', '/api/v1/auth/me')).user;
  const cats = (await api('GET', '/api/v1/catalogs/task_categories/items')).items;
  category = cats.find((c) => !c.systemKey) ?? cats[0];
});

after(async () => {
  if (!ui) return;
  try {
    await loginAs(LOGIN, PASSWORD).catch(() => undefined);
    for (const who of [reader, head].filter(Boolean)) {
      const u = (await api('GET', `/api/v1/users?q=${encodeURIComponent(who.login)}`).catch(() => ({ items: [] }))).items.find((x) => x.id === who.id);
      if (u?.isActive) await api('POST', `/api/v1/users/${u.id}/disable`, { version: u.version }).catch(() => undefined);
    }
    for (const c of (await api('GET', `/api/v1/task-chains?q=${encodeURIComponent(RUN)}`).catch(() => ({ items: [] }))).items) {
      if (c.title.includes(RUN)) await api('POST', `/api/v1/task-chains/${c.id}/delete`, { version: c.version }).catch(() => undefined);
    }
    for (const archived of [false, true]) {
      const page = await api('GET', `/api/v1/tasks?archived=${archived}`).catch(() => ({ items: [] }));
      for (const t of page.items.filter((x) => x.title.includes(RUN) && !archived)) await api('POST', `/api/v1/tasks/${t.id}/archive`, { version: t.version }).catch(() => undefined);
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
  it('доска: цепочка с задачами в двух колонках — свёрнутая карточка в каждой, раскрытие, без группировки — метка; поиск и фильтр', async () => {
    const theme = `Доска тема ${RUN}`;
    const a = await makeTask(theme);
    const b = await makeTask(`RE: ${theme}`);
    const c = await makeTask(`FW: ${theme}`, { assigneeId: null });
    const chain = await api('POST', '/api/v1/task-chains', { title: theme, tasks: [a, b, c].map((t) => ({ id: t.id, version: t.version })) });
    await openBoard();
    const groups = `[...document.querySelectorAll(${JSON.stringify(`.chain-group[data-chain="${theme}"]`)})]`;
    await ui.waitFor(`${groups}.length === 2`, 'цепочка в двух колонках');
    const assigned = `${groups}.find((g) => g.querySelector('.cc-m')?.textContent.includes('здесь 2'))`;
    assert.match(await ui.text(`${assigned}.querySelector('.cc-m')`), /3 задачи, 0 выполнено · здесь 2/);
    assert.equal(await ui.evaluate(`${assigned}.querySelectorAll('article.card').length`), 0, 'свёрнута');
    await ui.click(`${assigned}.querySelector('.cc-toggle')`, 'раскрыть цепочку');
    await ui.waitFor(`${assigned}.querySelectorAll('article.card').length === 2`, 'задачи колонки внутри цепочки');
    // Задача внутри цепочки — обычная карточка: открывается щелчком.
    await ui.click(`${assigned}.querySelector('article.card[data-task="${b.id}"]')`, 'открыть задачу из цепочки');
    await ui.waitFor(`!!${drawer}?.querySelector('[data-testid=chain-block]')`, 'карточка задачи с блоком цепочки');
    await ui.goto(`/tasks?run=${++navSeq}`);
    await ui.waitFor(`${groups}.length === 2`, 'доска');
    await ui.click($.button('Группировать по цепочкам'));
    await ui.waitFor(`${groups}.length === 0 && !!document.querySelector('article.card[data-task="${c.id}"] .card-chain')`, 'без группировки — метка цепочки на карточке');
    await ui.click($.button('Группировать по цепочкам'));
    // Поиск над доской — по названию цепочки; фильтр «Цепочка» — запрос с chainId.
    await ui.type(`document.querySelector('input[aria-label="Поиск по доске"]')`, theme);
    await ui.waitFor(`${groups}.length === 2 && document.querySelectorAll('.board .chain-group, .board > .col > article.card').length === 2`, 'на доске только задачи цепочки');
    const m = ui.mark();
    await ui.select(`document.querySelector('select[aria-label="Цепочка"]')`, chain.id);
    await ui.request(m, 'GET', `chainId=${chain.id}`);
    await ui.waitFor(`location.search.includes('chainId=${chain.id}')`, 'фильтр в адресе');
  });

  it('панель цепочки: все задачи выполнены — «Закрыть цепочку»; удаление с диалогом — задачи отвязаны и остаются', async () => {
    const theme = `Панель тема ${RUN}`;
    const a = await makeTask(theme);
    const b = await makeTask(`RE: ${theme}`);
    const chain = await api('POST', '/api/v1/task-chains', { title: theme, tasks: [a, b].map((t) => ({ id: t.id, version: t.version })) });
    await complete(a.id);
    await complete(b.id);
    await ui.goto(`/tasks/chains?run=${++navSeq}&chain=${chain.id}`);
    const panel = `document.querySelector('[data-testid=chain-panel]')`;
    await ui.waitFor(`${panel}?.querySelectorAll('.chain-timeline li').length === 2`, 'панель с хронологией');
    await ui.waitFor(`!!${panel}.querySelector('[data-testid=chain-all-done]')`, 'предложение закрыть');
    let m = ui.mark();
    await ui.click($.button('Закрыть цепочку', `${panel}.querySelector('[data-testid=chain-all-done]')`));
    assert.equal((await ui.request(m, 'POST', `/api/v1/task-chains/${chain.id}/close`)).status, 200);
    await ui.waitFor(`${panel}?.textContent.includes('Открыть заново')`, 'цепочка закрыта');
    // Удаление: диалог объясняет, что задачи останутся.
    await ui.click($.button('Удалить', panel));
    await ui.waitFor(`${panel}.querySelector('.danger-zone')?.textContent.includes('Задачи (2) будут отвязаны от цепочки, сами задачи останутся')`, 'диалог удаления');
    m = ui.mark();
    await ui.click($.button('Удалить', `${panel}.querySelector('.danger-zone')`));
    assert.equal((await ui.request(m, 'POST', `/api/v1/task-chains/${chain.id}/delete`)).status, 204);
    await ui.waitFor(`!${panel}`, 'панель закрыта');
    for (const t of [a, b]) {
      const cur = await api('GET', `/api/v1/tasks/${t.id}`);
      assert.equal(cur.chain, null);
      assert.ok(cur.completedAt, 'задача осталась выполненной');
    }
  });

  it('пользователь без ib.work: цепочек нет ни в API, ни в меню', async () => {
    const roles = (await api('GET', '/api/v1/roles')).items;
    const r = await api('POST', '/api/v1/users', { login: `${RUN.toLowerCase()}.reader`, fullName: `Читатель Цепочек ${RUN}`, roleIds: [roles.find((x) => x.code === 'doc_reader').id] });
    reader = { id: r.user.id, login: r.user.login };
    await loginAs(reader.login, r.temporaryPassword);
    const res = await ui.evaluate(`fetch('/api/v1/task-chains').then((x) => x.status)`);
    assert.equal(res, 403);
    const sug = await ui.evaluate(`fetch('/api/v1/task-chains/suggest?title=' + encodeURIComponent('Тестовая тема')).then((x) => x.status)`);
    assert.equal(sug, 403);
    assert.equal(await ui.evaluate(`!![...document.querySelectorAll('nav a')].find((a) => a.getAttribute('href') === '/tasks')`), false, 'раздела «Задачи» нет в меню');
    await loginAs(LOGIN, PASSWORD);
  });
  it('«Найти цепочки среди старых задач»: предпросмотр, выбор группы, подтверждение; повторный запуск её не находит', async () => {
    const roles = (await api('GET', '/api/v1/roles')).items;
    const r = await api('POST', '/api/v1/users', {
      login: `${RUN.toLowerCase()}.head`, fullName: `Начальник Цепочек ${RUN}`, roleIds: ['ib_staff', 'ib_head'].map((c) => roles.find((x) => x.code === c).id),
    });
    head = { id: r.user.id, login: r.user.login };
    await loginAs(head.login, r.temporaryPassword);
    const theme = `Старая тема ${RUN}`;
    const a = await api('POST', '/api/v1/tasks', { title: theme, categoryId: category.id });
    const b = await api('POST', '/api/v1/tasks', { title: `RE: ${theme}`, categoryId: category.id });
    await ui.goto(`/tasks/chains?run=${++navSeq}`);
    await ui.click($.button('Найти цепочки среди старых задач'));
    const dialog = `document.querySelector('[role=dialog][aria-labelledby=dc-title]')`;
    const group = `${dialog}?.querySelector(${JSON.stringify(`li[data-group="${theme}"]`)})`;
    await ui.waitFor(`!!${group}`, 'группа прогона в предпросмотре');
    assert.match(await ui.text(group), /новая цепочка · 2 задачи/);
    await ui.click($.button('Снять все', dialog));
    await ui.click(`${group}.querySelector('input[type=checkbox]')`, 'выбрать группу прогона');
    await ui.click($.button('Объединить выбранные (1)', dialog));
    await ui.waitFor(`!!${dialog}.querySelector('[data-testid=discover-confirm]')`, 'подтверждение');
    assert.match(await ui.text(`${dialog}.querySelector('[data-testid=discover-confirm]')`), /Будет создано цепочек: 1, дополнено: 0, задач привязано: 2/);
    const m = ui.mark();
    await ui.click($.button('Подтвердить', dialog));
    const applied = await ui.request(m, 'POST', '/api/v1/task-chains/discover/apply');
    assert.equal(applied.status, 200, applied.body);
    assert.equal(applied.json.groups.length, 1, 'применяется только выбранная группа');
    await ui.waitFor(`!${dialog}`, 'окно закрыто');
    const ta = await api('GET', `/api/v1/tasks/${a.id}`);
    const tb = await api('GET', `/api/v1/tasks/${b.id}`);
    assert.ok(ta.chain && tb.chain && ta.chain.id === tb.chain.id, 'обе задачи в одной цепочке');
    assert.equal(ta.chain.title, theme);
    // Повторный запуск: группа прогона больше не находится.
    const again = await api('POST', '/api/v1/task-chains/discover/preview');
    assert.equal(again.groups.some((g) => g.title === theme), false);
    // Уборка своей цепочки (удалить может создатель).
    const c = await api('GET', `/api/v1/task-chains/${ta.chain.id}`);
    await api('POST', `/api/v1/task-chains/${c.id}/delete`, { version: c.version });
    await loginAs(LOGIN, PASSWORD);
  });
});
