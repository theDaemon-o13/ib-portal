// Сквозной тест раздела «Задачи» тем же путём, что и браузер пользователя:
// Chrome → Vite (прокси /api) → backend → PostgreSQL, настоящие щелчки, перетаскивание мышью и ввод с клавиатуры.
//
//   npm run test:e2e   (логин и пароль — из frontend/.env.e2e или E2E_LOGIN / E2E_PASSWORD)
//
// Каждый тест готовит свои задачи через API и начинает с полной загрузки страницы.
// В конце все задачи прогона уходят в архив (одна — удаляется в тесте удаления, мягко).
// Процесс задач (релиз 1.2.0, ADR-0022): у супер-администратора нет прав процесса — доску проверяет созданный на прогон
// начальник ИБ («Начальник ИБ» + «Супер-администратор»: свободная смена статуса, постановка другим, удаление задач),
// кнопки процесса — его подчинённый «Сотрудник ИБ» без этих прав. Проверяющий (1.4.0, ADR-0028) — начальник как руководитель
// сотрудника; «Заменить проверяющего» — на третьего сотрудника прогона.
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
let statuses;
let navSeq = 0;
let head;
let staff;
let deputy;

/** Карточка задачи этого прогона: название всегда с меткой RUN, чужие задачи на доске не мешают. */
const card = (title) => {
  const full = title.startsWith(RUN) ? title : `${RUN} ${title}`;
  return `[...document.querySelectorAll('article.card')].find((c) => c.querySelector('.card-t')?.textContent.replace(/^срочно/, '') === ${JSON.stringify(full)})`;
};
const col = (name) => `[...document.querySelectorAll('.board .col')].find((c) => c.querySelector('.col-h span')?.textContent === ${JSON.stringify(name)})`;
const drawer = `document.querySelector('aside.drawer[aria-label="Задача"]')`;
const mailDrawer = `document.querySelector('aside.drawer[aria-label="Задача из письма"]')`;
const label = (text, within) => `[...(${within}).querySelectorAll('label')].find((l) => l.firstChild?.textContent?.trim() === ${JSON.stringify(text)})?.querySelector('input, select, textarea')`;

async function api(method, path, body) {
  const res = await ui.evaluate(`fetch(${JSON.stringify(path)}, ${JSON.stringify(body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })})
    .then(async (r) => ({ status: r.status, text: await r.text() }))`);
  assert.ok(res.status >= 200 && res.status < 300, `${method} ${path} → ${res.status} ${res.text}`);
  return res.text ? JSON.parse(res.text) : null;
}

/** Задача через API: название с меткой прогона, чтобы уборка нашла всё своё. */
const makeTask = (title, extra = {}) => api('POST', '/api/v1/tasks', { title: `${RUN} ${title}`, categoryId: category.id, assigneeId: me.id, ...extra });

async function openBoard(query = '') {
  await ui.goto(`/tasks?run=${++navSeq}${query}`);
  await ui.waitFor(`document.querySelectorAll('.board .col').length === 5`, 'доска из пяти колонок');
}

/** Выйти и войти через форму; при первом входе — смена временного пароля. */
async function loginAs(login, password) {
  if (!(await ui.evaluate(`location.origin.startsWith('http')`))) await ui.goto(`/login?n=${++navSeq}`);
  await ui.evaluate(`fetch('/api/v1/auth/logout', { method: 'POST' })`);
  await ui.goto(`/login?n=${++navSeq}`);
  await ui.type(`document.querySelector('input[name=username]')`, login);
  await ui.type(`document.querySelector('input[name=password]')`, password);
  await ui.click(`document.querySelector('form button[type=submit]')`);
  await ui.waitFor(`location.pathname !== '/login'`, `вход ${login}`);
  if (await ui.evaluate(`location.pathname === '/change-password'`)) {
    const next = `Задачи-${RUN.slice(4)}-Zq9!`;
    await ui.type(`document.querySelector('input[autocomplete=current-password]')`, password);
    await ui.type(`document.querySelectorAll('input[autocomplete=new-password]')[0]`, next);
    await ui.type(`document.querySelectorAll('input[autocomplete=new-password]')[1]`, next);
    await ui.click($.button('Сменить пароль'));
    await ui.waitFor(`location.pathname !== '/change-password'`, `смена пароля ${login}`);
    return next;
  }
  return password;
}

before(async () => {
  assert.ok(LOGIN && PASSWORD, 'Задайте E2E_LOGIN и E2E_PASSWORD (пользователь с ролью «Супер-администратор»)');
  ui = await launchBrowser({ baseUrl: BASE });
  await loginAs(LOGIN, PASSWORD);
  const roles = (await api('GET', '/api/v1/roles')).items;
  const created = await api('POST', '/api/v1/users', {
    login: `${RUN.toLowerCase()}.head`, fullName: `Начальник Задач ${RUN}`,
    roleIds: ['ib_head', 'super_admin'].map((c) => roles.find((r) => r.code === c).id),
  });
  head = { id: created.user.id, login: created.user.login };
  const sub = await api('POST', '/api/v1/users', {
    login: `${RUN.toLowerCase()}.staff`, fullName: `Сотрудник Задач ${RUN}`, roleIds: [roles.find((r) => r.code === 'ib_staff').id], managerId: head.id,
  });
  staff = { id: sub.user.id, login: sub.user.login, password: sub.temporaryPassword };
  const dep = await api('POST', '/api/v1/users', {
    login: `${RUN.toLowerCase()}.deputy`, fullName: `Заместитель Задач ${RUN}`, roleIds: [roles.find((r) => r.code === 'ib_staff').id],
  });
  deputy = { id: dep.user.id, login: dep.user.login };
  head.password = await loginAs(head.login, created.temporaryPassword);
  me = (await api('GET', '/api/v1/auth/me')).user;
  const cats = (await api('GET', '/api/v1/catalogs/task_categories/items')).items;
  category = cats.find((c) => !c.systemKey) ?? cats[0];
  statuses = (await api('GET', '/api/v1/catalogs/task_statuses/items')).items;
});

after(async () => {
  // Уборка: все задачи прогона — в архив, даже если тест упал на середине.
  if (ui) {
    const page = await api('GET', '/api/v1/tasks?archived=false').catch(() => ({ items: [] }));
    for (const t of page.items.filter((x) => x.title.startsWith(RUN))) {
      await api('POST', `/api/v1/tasks/${t.id}/archive`, { version: t.version }).catch(() => undefined);
    }
    if (head) {
      await loginAs(LOGIN, PASSWORD).catch(() => undefined);
      for (const u of [staff, deputy, head].filter(Boolean)) {
        const cur = (await api('GET', `/api/v1/users?q=${encodeURIComponent(u.login)}`).catch(() => ({ items: [] }))).items.find((x) => x.id === u.id);
        if (cur?.isActive) await api('POST', `/api/v1/users/${u.id}/disable`, { version: cur.version }).catch(() => undefined);
      }
    }
    assert.deepEqual(ui.consoleErrors, [], 'ошибки JavaScript в странице');
    ui.close();
  }
});

describe('Доска задач', () => {
  it('быстрая постановка; колонки — статусы справочника; срочные и просроченные выделены; счётчик в меню', async () => {
    await makeTask('просроченная', { dueDate: '2020-01-10' });
    const high = (await api('GET', '/api/v1/catalogs/task_priorities/items')).items.find((p) => p.systemKey === 'high');
    await makeTask('срочная', { priorityId: high.id, dueDate: '2099-01-01' });
    await openBoard();
    assert.deepEqual(await ui.evaluate(`[...document.querySelectorAll('.board .col-h span:first-child')].map((s) => s.textContent)`), statuses.map((s) => s.value));

    const title = `${RUN} быстрая задача`;
    await ui.type(`document.querySelector('input[aria-label="Новая задача"]')`, title);
    await ui.select(`document.querySelector('form.quick select[aria-label="Категория"]')`, category.id);
    await ui.select(`document.querySelector('form.quick select[aria-label="Ответственный"]')`, me.id);
    const m = ui.mark();
    await ui.click($.button('Назначить'));
    const created = await ui.request(m, 'POST', '/api/v1/tasks');
    assert.equal(created.status, 201, created.body);
    assert.equal(created.json.title, title);
    // С исполнителем — сразу «Поставленные» (релиз 1.2.0).
    await ui.waitFor(`!!${card(title)} && ${col(statuses.find((s) => s.systemKey === 'assigned').value)}.contains(${card(title)})`, 'задача в колонке «Поставленные»');
    assert.match(await ui.text(card(title)), new RegExp(me.fullName));

    await ui.waitFor(`${card('просроченная')}?.classList.contains('late')`, 'просроченная выделена');
    assert.match(await ui.text(card('просроченная')), /просрочено · 10\.01\.2020/);
    assert.equal(await ui.evaluate(`!!${card('срочная')}.querySelector('.chip.crit')`), true, 'срочная — с меткой «срочно»');
    // С 1.4.0 у «Задачи» — только задачи на вашей проверке; просроченные — на доске и дашборде, не цифрой в меню.
    const att = await api('GET', '/api/v1/me/attention');
    await ui.waitFor(att.tasks ? `document.querySelector('[data-testid=nav-tasks-n]')?.textContent === '${att.tasks}'` : `!document.querySelector('[data-testid=nav-tasks-n]')`, 'цифра у «Задачи» = задачам на моей проверке');
  });

  it('перетаскивание мышью меняет статус; фильтр по категории', async () => {
    const t = await makeTask('перетащить');
    const work = statuses.find((s) => s.systemKey === 'work');
    await openBoard();
    const m = ui.mark();
    await ui.drag(card('перетащить'), col(work.value), 'карточка → «В работе»');
    const req = await ui.request(m, 'PATCH', `/api/v1/tasks/${t.id}`);
    assert.equal(req.status, 200, req.body);
    assert.deepEqual(req.json, { version: t.version, statusId: work.id }, 'уходит только статус и версия');
    await ui.waitFor(`!!${col(work.value)} && ${col(work.value)}.contains(${card('перетащить')})`, 'карточка в «В работе»');
    assert.equal(await ui.evaluate(`!!document.querySelector('aside.drawer')`), false, 'перетаскивание не открывает карточку');

    const m2 = ui.mark();
    await ui.click(`[...document.querySelectorAll('.filters button')].find((b) => b.textContent.startsWith(${JSON.stringify(category.value)}))`);
    const filtered = await ui.request(m2, 'GET', `categoryId=${category.id}`);
    assert.equal(filtered.status, 200);
    await ui.waitFor(`document.querySelectorAll('article.card').length > 0 && [...document.querySelectorAll('article.card > .meta:nth-child(2) > span:first-child')].every((s) => s.textContent === ${JSON.stringify(category.value)})`, 'только выбранная категория');
  });
});

describe('Ширина доски', () => {
  it('1366 px: пять колонок без прокрутки, «Загрузка сотрудников» свёрнута; открыть — запоминается после перезагрузки', async () => {
    const board = `document.querySelector('.board')`;
    const panel = `[...document.querySelectorAll('.tasks-grid .panel h3')].some((h) => h.textContent === 'Загрузка сотрудников')`;
    await ui.evaluate(`localStorage.removeItem('ibportal.tasks.workload')`);
    try {
      await ui.viewport(1366, 900);
      await openBoard();
      assert.equal(await ui.evaluate(panel), false, 'на 1366 панель по умолчанию свёрнута');
      assert.equal(await ui.evaluate(`${board}.scrollWidth <= ${board}.clientWidth`), true, 'колонки без горизонтальной прокрутки');
      await ui.click($.button('Загрузка сотрудников'));
      await ui.waitFor(panel, 'панель открыта');
      await openBoard();
      assert.equal(await ui.evaluate(panel), true, 'открытая панель запомнилась');
      await ui.click($.button('Скрыть'));
      await openBoard();
      assert.equal(await ui.evaluate(panel), false, 'скрытая панель запомнилась');
    } finally {
      await ui.evaluate(`localStorage.removeItem('ibportal.tasks.workload')`);
      await ui.viewport(1440, 1000);
    }
  });
});

describe('Карточка задачи', () => {
  it('правка только изменённого, комментарий, история; «Отметить выполненной» больше нет', async () => {
    await makeTask('карточка');
    await openBoard();
    await ui.click(card('карточка'), 'карточка на доске');
    await ui.waitFor(`!!${drawer}?.querySelector('form.task-form')`, 'карточка задачи');
    await ui.type(label('Название', drawer), `${RUN} карточка изменена`);
    let m = ui.mark();
    await ui.click($.button('Сохранить', drawer));
    const upd = await ui.request(m, 'PATCH', '/api/v1/tasks/');
    assert.equal(upd.status, 200, upd.body);
    assert.deepEqual(Object.keys(upd.json).sort(), ['title', 'version'], 'уходит только изменённое поле');
    await ui.waitFor(`${drawer}?.querySelector('.hist')?.textContent.includes('«Название»')`, 'история изменений');

    await ui.type(`${drawer}.querySelector('textarea[aria-label="Комментарий"]')`, 'Права проверены, жду ответа ДИКТ');
    m = ui.mark();
    await ui.click($.button('Добавить комментарий', drawer));
    assert.equal((await ui.request(m, 'POST', '/comments')).status, 201);
    await ui.waitFor(`${drawer}.querySelector('.cmt .tx')?.textContent === 'Права проверены, жду ответа ДИКТ'`, 'комментарий в карточке');
    assert.equal(await ui.evaluate(`[...${drawer}.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Отметить выполненной')`), false);

  });
});

describe('Процесс по кнопкам', () => {
  const step = (title) => `${card(title)}?.querySelector('.card-step button')`;
  const colOf = (key) => col(statuses.find((s) => s.systemKey === key).value);

  it('сотрудник без права: карточки не перетаскиваются; «Взять себе» → «Взять в работу» → «Отправить на проверку» с комментарием; свою не принять', async () => {
    const t = await makeTask('процесс', { assigneeId: null });
    staff.password = await loginAs(staff.login, staff.password);
    try {
      await openBoard();
      assert.match(await ui.text(`document.querySelector('.head p')`), /Статус меняется кнопками в карточке/);
      assert.equal(await ui.evaluate(`${card('процесс')}.classList.contains('static')`), true, 'карточка не перетаскивается');
      assert.equal(await ui.evaluate(`!!${$.button('Отчёт')}`), false, 'без права «Задачи: отчёт» кнопки нет');
      assert.deepEqual(await ui.evaluate(`[...document.querySelector('form.quick select[aria-label="Ответственный"]').options].map((o) => o.textContent)`),
        ['— не назначен', `Сотрудник Задач ${RUN} (я)`], 'без права — только «я» или «не назначен»');

      let m = ui.mark();
      await ui.click(step('процесс'), '«Взять себе»');
      assert.equal((await ui.request(m, 'POST', `/api/v1/tasks/${t.id}/actions/take`)).status, 200);
      await ui.waitFor(`${colOf('assigned')}.contains(${card('процесс')}) && ${step('процесс')}?.textContent === 'Взять в работу'`, '«Поставленные», моя');
      m = ui.mark();
      await ui.click(step('процесс'), '«Взять в работу»');
      assert.equal((await ui.request(m, 'POST', `/api/v1/tasks/${t.id}/actions/start`)).status, 200);
      await ui.waitFor(`${colOf('work')}.contains(${card('процесс')}) && ${step('процесс')}?.textContent === 'На проверку'`, '«В работе»');

      // «На проверку» требует комментария — открывается карточка.
      await ui.click(step('процесс'), '«На проверку»');
      await ui.waitFor(`!!${drawer}?.querySelector('.process')`, 'карточка с шагом процесса');
      assert.match(await ui.text(`${drawer}.querySelector('[data-testid="task-status"]')`), /В работе/, 'статус — текстом');
      await ui.click($.button('Отправить на проверку', drawer));
      await ui.waitFor(`!!${drawer}.querySelector('textarea[aria-label="Комментарий к шагу"]')`, 'поле комментария');
      assert.equal(await ui.evaluate(`!!${$.button('Отправить на проверку', drawer)}`), false, 'без комментария кнопка не активна');
      await ui.type(`${drawer}.querySelector('textarea[aria-label="Комментарий к шагу"]')`, 'Права сняты, отчёт в письме');
      m = ui.mark();
      await ui.click($.button('Отправить на проверку', drawer));
      const sub = await ui.request(m, 'POST', `/api/v1/tasks/${t.id}/actions/submit`);
      assert.equal(sub.status, 200, sub.body);
      assert.equal(sub.json.comment, 'Права сняты, отчёт в письме');
      // Проверяющий — руководитель сотрудника, зафиксирован при отправке: «Проверяет:» в карточке и «→ ФИО» в ленте.
      const headName = `Начальник Задач ${RUN}`;
      await ui.waitFor(`${drawer}.querySelector('[data-testid="task-reviewer"]')?.textContent === ${JSON.stringify(headName)}`, '«Проверяет» в карточке');
      await ui.waitFor(`[...${drawer}.querySelectorAll('.cmt')].some((c) => c.textContent.includes(${JSON.stringify(`В работе → На проверке → ${headName}`)}) && c.textContent.includes('Права сняты'))`, 'комментарий перехода «→ ФИО» в ленте');
      await ui.waitFor(`${drawer}.querySelector('.process .hint')?.textContent === ${JSON.stringify(`Задачу проверяет ${headName}`)}`, 'свою не принять: проверяет руководитель');
      await ui.click($.button('Закрыть', drawer));
      await ui.waitFor(`${card('процесс')}?.querySelector('[data-testid="card-reviewer"]')?.textContent === ${JSON.stringify(`Проверяет: ${headName}`)}`, '«Проверяет:» на доске');
    } finally {
      head.password = await loginAs(head.login, head.password);
    }

    // Руководитель исполнителя: на карточке «Проверить» → «Принять» с комментарием.
    await openBoard();
    await ui.waitFor(`${step('процесс')}?.textContent === 'Проверить'`, 'кнопка «Проверить»');
    await ui.click(step('процесс'));
    await ui.waitFor(`!!${drawer}?.querySelector('.process')`, 'карточка проверки');
    await ui.click($.button('Принять', drawer));
    await ui.type(`${drawer}.querySelector('textarea[aria-label="Комментарий к шагу"]')`, 'Проверил, принято');
    const m = ui.mark();
    await ui.click($.button('Принять', drawer));
    assert.equal((await ui.request(m, 'POST', `/api/v1/tasks/${t.id}/actions/accept`)).status, 200);
    await ui.click($.button('Закрыть', drawer));
    await ui.waitFor(`!${drawer} && ${colOf('done')}.contains(${card('процесс')})`, 'задача в «Выполнено»');
  });

  it('перетаскивание в колонку с обязательным комментарием — окно «Комментарий к переходу»; в «На проверке» — проверяющий вычислен', async () => {
    const t = await makeTask('с комментарием', { assigneeId: staff.id });
    await openBoard();
    const review = statuses.find((s) => s.systemKey === 'review');
    await ui.drag(card('с комментарием'), col(review.value), 'карточка → «На проверке»');
    const dlg = `document.querySelector('form[aria-labelledby="mv-title"]')`;
    await ui.waitFor(`!!${dlg}`, 'окно «Комментарий к переходу»');
    await ui.type(`${dlg}.querySelector('textarea')`, 'Перенёс сам');
    const m = ui.mark();
    await ui.click($.button('Перенести', dlg));
    const req = await ui.request(m, 'PATCH', `/api/v1/tasks/${t.id}`);
    assert.equal(req.status, 200, req.body);
    assert.deepEqual(req.json, { version: t.version, statusId: review.id, comment: 'Перенёс сам' });
    await ui.waitFor(`!${dlg} && ${col(review.value)}.contains(${card('с комментарием')})`, 'карточка в «На проверке»');
    await ui.waitFor(`${card('с комментарием')}?.querySelector('[data-testid="card-reviewer"]')?.textContent === ${JSON.stringify(`Проверяет: Начальник Задач ${RUN}`)}`, '«Проверяет:» на доске');
  });

  it('в «На проверке» задачу исполнителя без руководителя не перенести — 409 «Проверять некому»; «Завершить» — сам, с комментарием', async () => {
    const t = await makeTask('без руководителя');
    const started = await api('POST', `/api/v1/tasks/${t.id}/actions/start`, { version: t.version });
    await openBoard();
    const review = statuses.find((s) => s.systemKey === 'review');
    await ui.drag(card('без руководителя'), col(review.value), 'карточка → «На проверке»');
    const dlg = `document.querySelector('form[aria-labelledby="mv-title"]')`;
    await ui.waitFor(`!!${dlg}`, 'окно «Комментарий к переходу»');
    await ui.type(`${dlg}.querySelector('textarea')`, 'Пусть проверят');
    let m = ui.mark();
    await ui.click($.button('Перенести', dlg));
    const denied = await ui.request(m, 'PATCH', `/api/v1/tasks/${t.id}`);
    assert.equal(denied.status, 409, denied.body);
    // Ошибка — в самом окне, окно остаётся открытым.
    await ui.waitFor(`${dlg}?.querySelector('[data-testid="move-error"]')?.textContent.startsWith('Проверять некому')`, 'ошибка «Проверять некому» в окне');
    await ui.click($.button('Отмена', dlg));
    await ui.waitFor(`${colOf('work')}.contains(${card('без руководителя')}) && ${step('без руководителя')}?.textContent === 'Завершить'`, 'осталась «В работе», кнопка «Завершить»');

    // «Завершить» требует комментария (признак «Выполнено») — открывается карточка.
    await ui.click(step('без руководителя'), '«Завершить»');
    await ui.waitFor(`!!${drawer}?.querySelector('.process')`, 'карточка с шагом процесса');
    await ui.click($.button('Завершить', drawer));
    await ui.type(`${drawer}.querySelector('textarea[aria-label="Комментарий к шагу"]')`, 'Сделано, проверять некому');
    m = ui.mark();
    await ui.click($.button('Завершить', drawer));
    const done = await ui.request(m, 'POST', `/api/v1/tasks/${t.id}/actions/complete`);
    assert.equal(done.status, 200, done.body);
    assert.equal(done.json.version, started.version);
    await ui.click($.button('Закрыть', drawer));
    await ui.waitFor(`!${drawer} && ${colOf('done')}.contains(${card('без руководителя')})`, 'задача в «Выполнено»');
  });

  it('«Заменить проверяющего» (свободная смена статуса): выбор сотрудника, «Проверяет:» меняется, в истории — «проверяющий заменён»', async () => {
    const t = await makeTask('замена проверяющего', { assigneeId: staff.id });
    const review = statuses.find((s) => s.systemKey === 'review');
    const moved = await api('PATCH', `/api/v1/tasks/${t.id}`, { version: t.version, statusId: review.id, comment: 'На проверку' });
    assert.equal(moved.reviewer.id, head.id);
    await openBoard();
    await ui.click(card('замена проверяющего'), 'карточка');
    await ui.waitFor(`!!${drawer}?.querySelector('[aria-label="Проверяющий"]')`, 'блок «Проверяющий»');
    await ui.click($.button('Заменить проверяющего', drawer));
    const dName = `Заместитель Задач ${RUN}`;
    await ui.select(`${drawer}.querySelector('select[aria-label="Новый проверяющий"]')`, deputy.id, 'новый проверяющий');
    await ui.type(`${drawer}.querySelector('textarea[aria-label="Комментарий к замене"]')`, 'Начальник в отпуске');
    const m = ui.mark();
    await ui.click($.button('Заменить', drawer));
    const req = await ui.request(m, 'POST', `/api/v1/tasks/${t.id}/reviewer`);
    assert.equal(req.status, 200, req.body);
    assert.deepEqual(req.json, { version: moved.version, reviewerId: deputy.id, comment: 'Начальник в отпуске' });
    await ui.waitFor(`${drawer}.querySelector('[data-testid="task-reviewer"]')?.textContent === ${JSON.stringify(dName)}`, '«Проверяет» — заместитель');
    await ui.waitFor(`[...${drawer}.querySelectorAll('.hist-item')].some((h) => h.textContent.includes(${JSON.stringify(`проверяющий заменён (Начальник Задач ${RUN} → ${dName})`)}))`, 'история: проверяющий заменён');
    // Прежний проверяющий больше не принимает: кнопок «Принять» нет, подсказка называет нового.
    await ui.waitFor(`${drawer}.querySelector('.process .hint')?.textContent === ${JSON.stringify(`Принять или вернуть может только проверяющий: ${dName}`)}`, 'подсказка — новый проверяющий');
    await ui.click($.button('Закрыть', drawer));
  });
});

describe('Отчёт по задачам', () => {
  it('«Отчёт» → страница выполненных задач: цифры, иллюстрации, список; щелчок по сотруднику — фильтр; Excel за период', async () => {
    const t = await makeTask('выполнена для отчёта', { dueDate: '2020-01-10' });
    let cur = await api('POST', `/api/v1/tasks/${t.id}/actions/start`, { version: t.version });
    cur = await api('POST', `/api/v1/tasks/${t.id}/actions/complete`, { version: cur.version, comment: 'сделано' }).catch(async () => {
      // У администратора прогона есть руководитель — через проверку не идём: свободная смена статуса.
      const done = statuses.find((s) => s.systemKey === 'done');
      return api('PATCH', `/api/v1/tasks/${t.id}`, { version: cur.version, statusId: done.id, comment: 'сделано' });
    });
    await openBoard();
    await ui.click(`[...document.querySelectorAll('a.btn')].find((a) => a.textContent === 'Отчёт')`, '«Отчёт»');
    await ui.waitFor(`location.pathname === '/tasks/report' && !!document.querySelector('[data-testid=stats-kpis]')`, 'страница отчёта с цифрами');
    const title = `${RUN} выполнена для отчёта`;
    const row = `[...document.querySelectorAll('[data-testid=stats-table] tbody tr')].find((tr) => tr.textContent.includes(${JSON.stringify(title)}))`;
    await ui.waitFor(`!!${row}`, 'задача в списке выполненных');
    assert.match(await ui.text(`${row}.querySelector('.chip')`), /^\+\d+ (день|дня|дней)$/, 'опоздание в днях');
    assert.equal(await ui.evaluate(`document.querySelectorAll('.st-svg rect.st-hit').length > 0`), true, 'столбцы по неделям');
    // Подсказка при наведении на неделю.
    await ui.evaluate(`document.querySelector('.st-svg g[tabindex]').dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))`);
    await ui.evaluate(`document.querySelector('.st-svg g[tabindex]').focus()`);
    await ui.waitFor(`document.querySelector('.st-tip')?.textContent.startsWith('Неделя с')`, 'подсказка недели');
    // Щелчок по сотруднику — отчёт по нему (фильтр в адресе).
    await ui.click(`[...document.querySelectorAll('button.st-row')].find((b) => !b.disabled)`, 'строка сотрудника');
    await ui.waitFor(`new URLSearchParams(location.search).has('assignee')`, 'фильтр по сотруднику');
    // Excel — выполненные за выбранный период.
    const m0 = ui.mark();
    await ui.click($.button('Выгрузить в Excel'));
    const x = await ui.request(m0, 'GET', '/api/v1/tasks/report');
    assert.equal(x.status, 200);
    assert.equal(new URL(x.url, BASE).searchParams.get('period'), 'completed');
    // Снимки для просмотра глазами (светлая и чёрная тема) — в каталог E2E_SHOTS, если задан.
    if (process.env.E2E_SHOTS) {
      const fs = await import('node:fs');
      await ui.goto('/tasks/report');
      await ui.waitFor(`!!document.querySelector('[data-testid=stats-table]')`, 'отчёт для снимка');
      await ui.evaluate(`document.documentElement.dataset.theme = 'light'`);
      fs.writeFileSync(`${process.env.E2E_SHOTS}/report-light.png`, await ui.screenshot());
      await ui.evaluate(`document.documentElement.dataset.theme = 'dark'`);
      fs.writeFileSync(`${process.env.E2E_SHOTS}/report-dark.png`, await ui.screenshot());
      await ui.evaluate(`delete document.documentElement.dataset.theme`);
    }
  });

  it('«Расширенная выгрузка» → окно фильтров → «Выгрузить в Excel»: запрос с фильтрами, файл', async () => {
    await makeTask('в отчёт', { dueDate: '2020-01-10' });
    await ui.goto('/tasks/report');
    await ui.waitFor(`!!${$.button('Расширенная выгрузка')}`, 'страница отчёта');
    await ui.click($.button('Расширенная выгрузка'));
    const dlg = `document.querySelector('form[aria-labelledby="tr-title"]')`;
    await ui.waitFor(`!!${dlg}`, 'окно «Отчёт по задачам»');
    await ui.select(label('Период', dlg), 'due');
    // Поле type=date заполняется значением целиком: посимвольный ввод даты зависит от локали браузера.
    for (const [name, v] of [['С', '2020-01-01'], ['По', '2020-01-31']]) {
      await ui.evaluate(`(() => { const el = ${label(name, dlg)};
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(v)});
        el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    }
    await ui.click(`[...${dlg}.querySelectorAll('label.chk')].find((l) => l.textContent.includes('только просроченные')).querySelector('input')`);
    const m = ui.mark();
    await ui.click($.button('Выгрузить в Excel', dlg));
    const res = await ui.request(m, 'GET', '/api/v1/tasks/report');
    const q = new URL(res.url, BASE).searchParams;
    assert.deepEqual([q.get('period'), q.get('from'), q.get('to'), q.get('overdue')], ['due', '2020-01-01', '2020-01-31', 'true']);
    await ui.waitFor(`!${dlg} && document.body.textContent.includes('Выгружено: Отчёт по задачам')`, 'отчёт выгружен');
  });
});

describe('Архив и удаление', () => {
  it('в архив и обратно; архив — отдельным фильтром; удаление с подтверждением', async () => {
    const t = await makeTask('архив');
    await openBoard(`&task=${t.id}`);
    await ui.waitFor(`!!${drawer}?.querySelector('form.task-form')`, 'карточка по ссылке');
    let m = ui.mark();
    await ui.click($.button('В архив', drawer));
    assert.equal((await ui.request(m, 'POST', `/api/v1/tasks/${t.id}/archive`)).status, 200);
    await ui.waitFor(`${drawer}?.textContent.includes('В архиве')`, 'отметка «В архиве»');
    await ui.click($.button('Закрыть', drawer));
    await ui.waitFor(`!${card('архив')}`, 'с доски ушла');

    await ui.click(`document.querySelector('.filters .arch-btn')`, '«Архив»');
    await ui.waitFor(`location.search.includes('archive=1') && !!${card('архив')}?.classList.contains('arch')`, 'задача в архиве');
    await ui.click(card('архив'));
    await ui.waitFor(`!!${drawer}?.querySelector('form.task-form')`, 'карточка архивной задачи');
    assert.equal(await ui.evaluate(`${label('Название', drawer)}.disabled`), true, 'архивная задача не правится');
    m = ui.mark();
    await ui.click($.button('Вернуть на доску', drawer));
    assert.equal((await ui.request(m, 'POST', `/api/v1/tasks/${t.id}/restore`)).status, 200);
    await ui.click($.button('Закрыть', drawer));
    await ui.click(`document.querySelector('.filters .arch-btn')`, 'выйти из архива');
    await ui.waitFor(`!location.search.includes('archive=1') && !!${card('архив')}`, 'задача снова на доске');

    const del = await makeTask('удалить');
    await openBoard(`&task=${del.id}`);
    await ui.waitFor(`!!${drawer}?.querySelector('form.task-form')`, 'карточка');
    await ui.click($.button('Удалить задачу', drawer));
    m = ui.mark();
    await ui.click($.button('Удалить', `${drawer}.querySelector('.danger-zone')`));
    assert.equal((await ui.request(m, 'POST', `/api/v1/tasks/${del.id}/delete`)).status, 204);
    await ui.waitFor(`!${drawer} && !${card('удалить')}`, 'задача удалена');
  });
});

describe('Задача из письма', () => {
  it('вставить письмо → разобрать → проверить черновик → создать; исходное письмо в карточке', async () => {
    await openBoard();
    await ui.click($.button('Задача из письма'));
    await ui.waitFor(`!!${mailDrawer}`, 'окно «Задача из письма»');
    const raw = `От: Отдел кадров <hr@example.tj>\nОтправлено: 23.10.2026 10:15\nТема: RE: ${RUN} блокировка учётной записи\n\nСрочно заблокируйте учётную запись и доступы уволенного сотрудника.`;
    await ui.type(`${mailDrawer}.querySelector('textarea[aria-label="Текст письма"]')`, raw);
    let m = ui.mark();
    await ui.click($.button('Разобрать письмо', mailDrawer));
    const parsed = await ui.request(m, 'POST', '/api/v1/tasks/mail-draft');
    assert.equal(parsed.status, 200, parsed.body);
    assert.deepEqual(ui.requestsSince(m).filter((r) => r.method !== 'GET' && !r.url.includes('mail-draft')), [], 'разбор ничего не сохраняет');
    const draft = `${mailDrawer}.querySelector('form[aria-label="Черновик задачи"]')`;
    await ui.waitFor(`!!${draft}`, 'черновик');
    assert.equal(await ui.evaluate(`${label('Название', draft)}.value`), `${RUN} блокировка учётной записи`, 'тема без RE:');
    assert.equal(await ui.evaluate(`${label('Отправитель', draft)}.value`), 'Отдел кадров <hr@example.tj>');
    assert.match(await ui.text(draft), /«срочно» — 1 рабочий день/);
    const pr = await ui.evaluate(`${label('Приоритет', draft)}.selectedOptions[0].textContent`);
    assert.equal(pr, 'Высокий', '«срочно» — высокий приоритет');

    m = ui.mark();
    await ui.click($.button('Создать задачу', draft));
    const created = await ui.request(m, 'POST', '/api/v1/tasks');
    assert.equal(created.status, 201, created.body);
    assert.equal(created.json.mail.raw, raw, 'письмо уходит целиком');
    await ui.waitFor(`!${mailDrawer} && ${drawer}?.querySelector('.mailbox')?.textContent.includes('Исходное письмо')`, 'карточка новой задачи с письмом');
    assert.match(await ui.text(`${drawer}.querySelector('.dp-eyebrow')`), /Почта, из письма/);
    assert.match(await ui.text(`${drawer}.querySelector('.mailbox')`), /hr@example\.tj/);
  });
});
