// Сквозной тест раздела «Задачи» тем же путём, что и браузер пользователя:
// Chrome → Vite (прокси /api) → backend → PostgreSQL, настоящие щелчки, перетаскивание мышью и ввод с клавиатуры.
//
//   npm run test:e2e   (логин и пароль — из frontend/.env.e2e или E2E_LOGIN / E2E_PASSWORD)
//
// Каждый тест готовит свои задачи через API и начинает с полной загрузки страницы.
// В конце все задачи прогона уходят в архив (одна — удаляется в тесте удаления, мягко).
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
  await ui.waitFor(`document.querySelectorAll('.board .col').length === 4`, 'доска из четырёх колонок');
}

before(async () => {
  assert.ok(LOGIN && PASSWORD, 'Задайте E2E_LOGIN и E2E_PASSWORD (пользователь с ролью «Супер-администратор»)');
  ui = await launchBrowser({ baseUrl: BASE });
  await ui.goto('/login');
  await ui.type(`document.querySelector('input[name=username]')`, LOGIN);
  await ui.type(`document.querySelector('input[name=password]')`, PASSWORD);
  await ui.click(`document.querySelector('form button[type=submit]')`);
  await ui.waitFor(`location.pathname !== '/login'`, 'вход');
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
    await ui.waitFor(`!!${card(title)} && ${col(statuses[0].value)}.contains(${card(title)})`, 'задача в колонке «Новые»');
    assert.match(await ui.text(card(title)), new RegExp(me.fullName));

    await ui.waitFor(`${card('просроченная')}?.classList.contains('late')`, 'просроченная выделена');
    assert.match(await ui.text(card('просроченная')), /просрочено · 10\.01\.2020/);
    assert.equal(await ui.evaluate(`!!${card('срочная')}.querySelector('.chip.crit')`), true, 'срочная — с меткой «срочно»');
    await ui.waitFor(`Number(document.querySelector('nav .nav-n')?.textContent) >= 1`, 'счётчик просроченных у «Задачи»');
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
    await ui.waitFor(`document.querySelectorAll('article.card').length > 0 && [...document.querySelectorAll('article.card > .meta:nth-child(2) > span:first-child')].every((s) => s.textContent === ${JSON.stringify(`● ${category.value}`)})`, 'только выбранная категория');
  });
});

describe('Карточка задачи', () => {
  it('правка только изменённого, комментарий, история, «Отметить выполненной»', async () => {
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

    m = ui.mark();
    await ui.click($.button('Отметить выполненной', drawer));
    const done = await ui.request(m, 'PATCH', '/api/v1/tasks/');
    assert.equal(done.json.statusId, statuses.find((s) => s.systemKey === 'done').id);
    await ui.click($.button('Закрыть', drawer));
    await ui.waitFor(`!${drawer} && !!${card('карточка изменена')} && ${col(statuses.find((s) => s.systemKey === 'done').value)}.contains(${card('карточка изменена')})`, 'задача в «Готово»');
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
    assert.match(await ui.text(`${drawer}.querySelector('.eyebrow')`), /Почта, из письма/);
    assert.match(await ui.text(`${drawer}.querySelector('.mailbox')`), /hr@example\.tj/);
  });
});
