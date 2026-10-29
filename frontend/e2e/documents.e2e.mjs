// Сквозной тест раздела «Документы» тем же путём, что и браузер пользователя:
// Chrome → Vite (прокси /api) → backend → PostgreSQL, настоящие щелчки и ввод с клавиатуры.
//
//   npm run test:e2e   (логин и пароль администратора — из frontend/.env.e2e или E2E_LOGIN / E2E_PASSWORD)
//
// Маршрут проходят разные пользователи: тест заводит владельца документа, начальника ИБ, юриста и правление,
// каждый входит через форму входа (при первом входе — смена временного пароля). Документы готовятся через API.
// В конце документы и задачи прогона уходят в архив, тестовые пользователи отключаются.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { $, launchBrowser, portalToday } from './browser.mjs';
import { pickFiles, tempFile, tinyPdf, uploadViaApi } from './files.mjs';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const LOGIN = process.env.E2E_LOGIN;
const PASSWORD = process.env.E2E_PASSWORD;
const RUN = `E2E-${Date.now().toString(36)}`;
const URL1 = 'https://office.example.local/products/files/doceditor.aspx?fileid=';

let ui;
let docType;
let navSeq = 0;
/** Тестовые пользователи: { id, login, fullName, password, version }. */
const users = {};

const panel = `document.querySelector('.dash .panel.w4')`;
const row = (title) => `[...document.querySelectorAll('.docs-tbl tbody tr')].find((tr) => tr.querySelector('td .w500')?.textContent === ${JSON.stringify(title)})`;
const label = (text, within) => `[...(${within}).querySelectorAll('label')].find((l) => l.firstChild?.textContent?.trim() === ${JSON.stringify(text)})?.querySelector('input, select, textarea')`;
const stepState = (name) => `(() => { const s = [...${panel}.querySelectorAll('.vstep')].find((v) => v.querySelector('b')?.textContent === ${JSON.stringify(name)}); return s?.querySelector('.step')?.className; })()`;

async function api(method, path, body) {
  const res = await ui.evaluate(`fetch(${JSON.stringify(path)}, ${JSON.stringify(body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })})
    .then(async (r) => ({ status: r.status, text: await r.text() }))`);
  assert.ok(res.status >= 200 && res.status < 300, `${method} ${path} → ${res.status} ${res.text}`);
  return res.text ? JSON.parse(res.text) : null;
}

/** Собственный пароль тестового пользователя по парольной политике (без логина в нём). */
const newPassword = (u) => `Док-${RUN.slice(4)}-${u.key.length}-Zq9!`;

/** Выйти и войти через форму. При первом входе — смена временного пароля на странице смены пароля. */
async function loginAs(u) {
  await api('POST', '/api/v1/auth/logout').catch(() => undefined);
  await ui.goto(`/login?n=${++navSeq}`);
  await ui.type(`document.querySelector('input[name=username]')`, u.login);
  await ui.type(`document.querySelector('input[name=password]')`, u.password);
  await ui.click(`document.querySelector('form button[type=submit]')`);
  await ui.waitFor(`location.pathname !== '/login'`, `вход ${u.login}`);
  if (await ui.evaluate(`location.pathname === '/change-password'`)) {
    const next = newPassword(u);
    await ui.type(`document.querySelector('input[autocomplete=current-password]')`, u.password);
    await ui.type(`document.querySelectorAll('input[autocomplete=new-password]')[0]`, next);
    await ui.type(`document.querySelectorAll('input[autocomplete=new-password]')[1]`, next);
    await ui.click($.button('Сменить пароль'));
    await ui.waitFor(`location.pathname !== '/change-password'`, `смена пароля ${u.login}`);
    u.password = next;
  }
}

const admin = { key: 'admin', get login() { return LOGIN; }, get password() { return PASSWORD; }, set password(_) { /* у администратора e2e пароль не меняется */ } };

/** Действие маршрута через API от имени пользователя (подготовка данных): вход по API, затем запрос. */
async function apiAs(u, method, path, body) {
  await api('POST', '/api/v1/auth/logout').catch(() => undefined);
  const me = await api('POST', '/api/v1/auth/login', { login: u.login, password: u.password });
  if (me.user.mustChangePassword) {
    const next = newPassword(u);
    await api('POST', '/api/v1/auth/change-password', { currentPassword: u.password, newPassword: next });
    u.password = next;
  }
  return api(method, path, body);
}

async function routeStep(u, id, action, comment) {
  const d = await apiAs(u, 'GET', `/api/v1/documents/${id}`);
  // Отправка на согласование — с итоговым PDF (этап 7), если его ещё нет: файл загружает отправитель.
  const pdfFileId = action === 'submit' && !d.working.pdf ? (await uploadViaApi(ui, `Итог ${id.slice(0, 8)}.pdf`, tinyPdf())).id : undefined;
  return apiAs(u, 'POST', `/api/v1/documents/${id}/${action}`, { version: d.version, stage: d.working.stage, comment, pdfFileId });
}

/** Приложить итоговый PDF в форме отправки на согласование (как пользователь: выбор файла). */
async function attachPdfInForm(name = 'Итоговый.pdf') {
  const input = `.dash .panel.w4 form[aria-label="Отправка на согласование"] input[type=file]`;
  await ui.waitFor(`!!document.querySelector(${JSON.stringify(input)})`, 'поле итогового PDF');
  const [up] = await pickFiles(ui, input, [tempFile(name, tinyPdf(name))]);
  assert.equal(up.status, 201, up.body);
}

/** Документ прогона через API от имени администратора (docs.manage). */
async function makeDoc(title, extra = {}) {
  const r = await apiAs(admin, 'POST', '/api/v1/documents', {
    title: `${RUN} ${title}`, typeId: docType.id, ownerId: users.owner.id, onlyofficeUrl: `${URL1}${navSeq}`, edition: '1.0', ...extra,
  });
  return r.document;
}

async function approveAllViaApi(id) {
  await routeStep(users.owner, id, 'submit');
  await routeStep(users.head, id, 'approve');
  await routeStep(users.legal, id, 'approve');
  await routeStep(users.board, id, 'approve');
}

async function openDocs(id) {
  await ui.goto(`/documents?n=${++navSeq}${id ? `&doc=${id}` : ''}`);
  await ui.waitFor(`!!document.querySelector('.docs-tbl')`, 'реестр документов');
}

/** Действие в карточке документа: щелчок по кнопке и ответ API. */
async function act(button, method, urlPart) {
  const m = ui.mark();
  await ui.click($.button(button, panel), `кнопка «${button}»`);
  const req = await ui.request(m, method, urlPart);
  assert.equal(req.status, method === 'POST' && urlPart === '/api/v1/documents' ? 201 : 200, req.body);
  return req;
}

// Дата утверждения — «сегодня» портала (часовой пояс банка), пересмотр — через 12 месяцев.
const plusYear = () => {
  const [y, m, d] = portalToday().split('-');
  return `${Number(y) + 1}-${m}-${d}`;
};
const ru = (iso) => iso.split('-').reverse().join('.');

before(async () => {
  assert.ok(LOGIN && PASSWORD, 'Задайте E2E_LOGIN и E2E_PASSWORD (пользователь с ролью «Супер-администратор»)');
  ui = await launchBrowser({ baseUrl: BASE });
  await loginAs(admin);
  assert.notEqual(await ui.evaluate('location.pathname'), '/change-password', 'у администратора e2e не должно быть обязательной смены пароля');
  const roles = (await api('GET', '/api/v1/roles')).items;
  const role = (code) => roles.find((r) => r.code === code).id;
  docType = (await api('GET', '/api/v1/catalogs/document_types/items')).items[0];
  assert.ok(docType, 'в справочнике «Типы документов» есть значение');
  for (const [key, fullName, codes] of [
    ['owner', 'Автор Документов', ['ib_staff']],
    ['head', 'Начальник Отдела ИБ', ['ib_staff', 'ib_head']],
    ['legal', 'Юрист Банка', ['legal']],
    ['board', 'Член Правления', ['board']],
  ]) {
    const r = await api('POST', '/api/v1/users', { login: `${RUN.toLowerCase()}.${key}`, fullName: `${fullName} ${RUN}`, roleIds: codes.map(role) });
    users[key] = { key, id: r.user.id, login: r.user.login, fullName: r.user.fullName, password: r.temporaryPassword, version: r.user.version };
  }
});

after(async () => {
  // Уборка, даже если тест упал на середине: документы и задачи прогона — в архив, пользователи — отключить.
  if (ui) {
    await loginAs(admin).catch(() => undefined);
    const docs = await api('GET', '/api/v1/documents?archived=false&limit=500').catch(() => ({ items: [] }));
    for (const d of docs.items.filter((x) => x.title.startsWith(RUN))) {
      await api('POST', `/api/v1/documents/${d.id}/archive`, { version: d.version }).catch(() => undefined);
    }
    const tasks = await api('GET', '/api/v1/tasks?archived=false').catch(() => ({ items: [] }));
    for (const t of tasks.items.filter((x) => x.title.includes(RUN))) {
      await api('POST', `/api/v1/tasks/${t.id}/archive`, { version: t.version }).catch(() => undefined);
    }
    for (const u of Object.values(users)) {
      const cur = (await api('GET', '/api/v1/users').catch(() => ({ items: [] }))).items.find((x) => x.id === u.id);
      if (cur?.isActive) await api('POST', `/api/v1/users/${u.id}/disable`, { version: cur.version }).catch(() => undefined);
    }
    assert.deepEqual(ui.consoleErrors, [], 'ошибки JavaScript в странице');
    ui.close();
  }
});

describe('Документы: маршрут согласования', () => {
  it('новый документ → автор → начальник ИБ → юрист → правление; каждый согласует только свой этап', async () => {
    const title = `${RUN} Политика ИБ`;
    // Администратор создаёт документ формой «Новый документ».
    await loginAs(admin);
    await openDocs();
    await ui.click($.button('Новый документ'));
    const drawer = `document.querySelector('aside.drawer[aria-label="Новый документ"]')`;
    await ui.waitFor(`!!${drawer}`, 'форма нового документа');
    await ui.type(label('Название', drawer), title);
    await ui.select(label('Тип документа', drawer), docType.id);
    await ui.select(label('Владелец', drawer), users.owner.id);
    await ui.type(label('Редакция', drawer), '1.0');
    await ui.type(label('Ссылка на файл в OnlyOffice', drawer), `${URL1}1`);
    const m = ui.mark();
    await ui.click($.button('Создать черновик', drawer));
    const created = await ui.request(m, 'POST', '/api/v1/documents');
    assert.equal(created.status, 201, created.body);
    assert.deepEqual(created.json, { title, typeId: docType.id, ownerId: users.owner.id, onlyofficeUrl: `${URL1}1`, edition: '1.0', reviewMonths: 12 });
    const id = (await ui.response(created)).document.id;
    await ui.waitFor(`${panel}?.querySelector('.panel-h h3')?.textContent === ${JSON.stringify(title)}`, 'карточка нового документа');
    assert.equal(await ui.text(`${panel}.querySelector('.panel-h .chip')`), 'Черновик');
    assert.equal(await ui.evaluate(`${panel}.querySelector('a.btn')?.getAttribute('href')`), `${URL1}1`, 'кнопка «Открыть в OnlyOffice» ведёт на файл');

    // Автор: документ «ждёт вас», отправляет на согласование.
    await loginAs(users.owner);
    await openDocs();
    await ui.click(`[...document.querySelectorAll('.filters button')].find((b) => b.textContent.startsWith('Ждут вас'))`);
    await ui.waitFor(`!!${row(title)}`, 'документ в «Ждут вас» у автора');
    await ui.click(row(title));
    // Без итогового PDF отправить нельзя: кнопка неактивна, пока файл не приложен.
    assert.equal(await ui.evaluate(`!!${$.button('Отправить на согласование', panel)}`), false, 'без PDF кнопка неактивна');
    await attachPdfInForm();
    let req = await act('Отправить на согласование', 'POST', `/api/v1/documents/${id}/submit`);
    assert.equal(req.json.stage, 0);
    assert.ok(req.json.pdfFileId, 'отправка несёт итоговый PDF');
    await ui.waitFor(`${stepState('Начальник ИБ')}?.includes('cur')`, 'текущий этап — начальник ИБ');
    // Автор за следующий этап не согласует: кнопки нет, есть пояснение.
    assert.equal(await ui.evaluate(`!!${$.button('Согласовать этап', panel)}`), false);
    assert.match(await ui.text(`${panel}.querySelector('.note.ro')`), /Этап «Начальник ИБ» согласует пользователь с правом/);

    // Начальник ИБ: счётчик «ждёт вас» в меню, согласует этап.
    await loginAs(users.head);
    await openDocs(id);
    await ui.waitFor(`Number(document.querySelector('nav .nav-n.acc')?.textContent) >= 1`, 'счётчик «ждёт вас» у «Документы»');
    await ui.waitFor(`${row(title)}?.textContent.includes('ждёт вас')`, 'в строке — «ждёт вас»');
    req = await act('Согласовать этап', 'POST', `/api/v1/documents/${id}/approve`);
    assert.deepEqual(Object.keys(req.json).sort(), ['stage', 'version']);
    assert.equal(req.json.stage, 1);
    await ui.waitFor(`${stepState('Юридический отдел')}?.includes('cur')`, 'текущий этап — юридический отдел');

    // Юрист: без ib.work в меню только «Документы»; согласует свой этап.
    await loginAs(users.legal);
    assert.deepEqual(await ui.evaluate(`[...document.querySelectorAll('nav.nav a span:not(.nav-n)')].map((s) => s.textContent)`), ['Документы']);
    assert.equal(await ui.evaluate('location.pathname'), '/documents');
    await openDocs(id);
    await ui.waitFor(`Number(document.querySelector('nav .nav-n.acc')?.textContent) >= 1`, 'у юриста — счётчик «ждёт вас»');
    await act('Согласовать этап', 'POST', `/api/v1/documents/${id}/approve`);
    await ui.waitFor(`${stepState('Утверждение правлением')}?.includes('cur')`, 'текущий этап — правление');

    // Правление утверждает.
    await loginAs(users.board);
    await openDocs(id);
    await act('Утвердить', 'POST', `/api/v1/documents/${id}/approve`);
    await ui.waitFor(`${panel}.querySelector('.panel-h .chip')?.textContent === 'Утверждён'`, 'документ утверждён');
    assert.equal(await ui.evaluate(`[...${panel}.querySelectorAll('.vstep .step')].every((s) => s.classList.contains('done'))`), true, 'все этапы пройдены');
    assert.match(await ui.text(`${panel}.querySelector('.row.gap-lg')`), new RegExp(ru(plusYear()).replace(/\./g, '\\.')), 'пересмотр через 12 месяцев');
    // Кто согласовал этапы — видят все, кто видит документ; подробная история — только с правом «История в карточках» (ADR-0021).
    const steps = await ui.text(`${panel}`);
    assert.ok(steps.includes(users.board.fullName) && steps.includes(users.owner.fullName), 'в маршруте — кто согласовал этапы');
    assert.ok(!steps.includes('История согласования'), 'без права подробной истории нет');
    await loginAs(admin);
    await openDocs(id);
    await ui.waitFor(`${panel}?.textContent.includes('История согласования')`, 'подробная история у администратора');
    const hist = await ui.evaluate(`[...${panel}.querySelectorAll('.hist-item')].map((h) => h.textContent)`);
    assert.ok(hist.some((h) => h.includes(users.board.fullName) && h.includes('утвердил(а) версию 1')), hist.join('\n'));
    assert.ok(hist.some((h) => h.includes(users.owner.fullName) && h.includes('отправил(а) версию 1')), hist.join('\n'));
  });

  it('юрист видит утверждённые и «ждёт вас», а черновики и документы на чужом этапе — нет', async () => {
    const approved = await makeDoc('Утверждённый');
    await approveAllViaApi(approved.id);
    const draft = await makeDoc('Черновик');
    const atHead = await makeDoc('У начальника');
    await routeStep(users.owner, atHead.id, 'submit');
    await loginAs(users.legal);
    await openDocs();
    await ui.waitFor(`!!${row(`${RUN} Утверждённый`)}`, 'утверждённый документ виден юристу');
    assert.equal(await ui.evaluate(`!!${row(`${RUN} Черновик`)}`), false, 'черновик юристу не виден');
    assert.equal(await ui.evaluate(`!!${row(`${RUN} У начальника`)}`), false, 'документ на этапе начальника ИБ юристу не виден');
    assert.equal(await ui.evaluate(`[...document.querySelectorAll('.filters button')].some((b) => b.textContent.startsWith('Архив'))`), false, 'архива у юриста нет');
    await ui.goto(`/documents?doc=${draft.id}`);
    await ui.waitFor(`${panel}?.textContent.includes('Документ не найден или вам не виден')`, 'черновик по ссылке не открывается');
  });
});

describe('Документы: возврат на доработку', () => {
  it('возврат только с комментарием; маршрут заново; автору — задача на доске со ссылкой на документ', async () => {
    const doc = await makeDoc('Регламент доступа');
    await routeStep(users.owner, doc.id, 'submit');
    await loginAs(users.head);
    await openDocs(doc.id);
    await ui.click($.button('Вернуть на доработку', panel));
    await ui.waitFor(`!!${panel}.querySelector('textarea')`, 'поле замечаний');
    assert.equal(await ui.evaluate(`!!${$.button('Вернуть автору', panel)}`), false, 'без комментария кнопка неактивна');
    const comment = 'Добавьте раздел о пересмотре прав раз в полгода';
    await ui.type(`${panel}.querySelector('textarea')`, comment);
    const req = await act('Вернуть автору', 'POST', `/api/v1/documents/${doc.id}/return`);
    assert.equal(req.json.comment, comment);
    await ui.waitFor(`${panel}.querySelector('.panel-h .chip')?.textContent === 'Черновик'`, 'документ снова черновик');
    assert.ok((await ui.text(panel)).includes('круг 2'), 'маршрут начат заново: круг 2');

    // Автор: задача на доске, карточка ведёт на документ.
    await loginAs(users.owner);
    await ui.goto(`/tasks?n=${++navSeq}`);
    const taskTitle = `Доработать документ «${RUN} Регламент доступа»`;
    const card = `[...document.querySelectorAll('article.card')].find((c) => c.querySelector('.card-t')?.textContent === ${JSON.stringify(taskTitle)})`;
    await ui.waitFor(`!!${card}`, 'задача автору на доске');
    assert.match(await ui.text(card), /документ/);
    await ui.click(card);
    const drawer = `document.querySelector('aside.drawer[aria-label="Задача"]')`;
    await ui.waitFor(`${drawer}?.textContent.includes(${JSON.stringify(comment)})`, 'замечание в описании задачи');
    await ui.click(`[...${drawer}.querySelectorAll('a')].find((a) => a.textContent.startsWith('Документ #'))`);
    await ui.waitFor(`location.pathname === '/documents' && ${panel}?.querySelector('.panel-h h3')?.textContent === ${JSON.stringify(`${RUN} Регламент доступа`)}`, 'переход к документу из задачи');
    // Замечание возврата — в карточке документа и без права на историю.
    assert.match(await ui.text(`${panel}.querySelector('[data-testid=doc-returned]')`), new RegExp(`с этапа «Начальник ИБ».*${comment}`));

    // Автор правит черновик и отправляет снова — задача доработки закрывается сама.
    await ui.click($.button('Изменить черновик', panel));
    await ui.type(label('Что изменено', panel), 'Добавлен раздел 6');
    await act('Сохранить', 'PATCH', `/api/v1/documents/${doc.id}`);
    await act('Отправить на согласование', 'POST', `/api/v1/documents/${doc.id}/submit`);
    const tasks = (await api('GET', '/api/v1/tasks?archived=false')).items.filter((t) => t.title === taskTitle);
    assert.equal(tasks.length, 1);
    assert.notEqual(tasks[0].completedAt, null, 'задача доработки закрыта после отправки');
  });
});

describe('Документы: новая версия', () => {
  it('утверждённый документ → новая версия через полный маршрут; утверждённая версия остаётся в истории', async () => {
    const doc = await makeDoc('Инструкция по паролям');
    await approveAllViaApi(doc.id);
    await loginAs(users.owner);
    await openDocs(doc.id);
    await ui.click($.button('Новая версия', panel));
    const form = `${panel}.querySelector('form[aria-label="Новая версия"]')`;
    await ui.waitFor(`!!${form}`, 'форма новой версии');
    await ui.type(label('Редакция', form), '2.0');
    await ui.type(label('Что изменено (необязательно)', form), 'Длина пароля 14 символов');
    const req = await act('Создать версию 2', 'POST', `/api/v1/documents/${doc.id}/revise`);
    assert.equal(req.json.edition, '2.0');
    await ui.waitFor(`${panel}.querySelector('.panel-h .chip')?.textContent === 'На пересмотре'`, 'статус «На пересмотре»');
    const versions = () => ui.evaluate(`[...${panel}.querySelectorAll('.hist-item a')].map((a) => a.textContent)`);
    assert.deepEqual(await versions(), ['Версия 2 · ред. 2.0', 'Версия 1 · ред. 1.0']);
    await attachPdfInForm('Инструкция v2.pdf');
    await act('Отправить на согласование', 'POST', `/api/v1/documents/${doc.id}/submit`);

    // Пока версия 2 у начальника ИБ, юрист видит действующую версию 1.
    await loginAs(users.legal);
    await openDocs(doc.id);
    await ui.waitFor(`${panel}?.querySelector('.panel-h .chip')?.textContent === 'Утверждён'`, 'юрист видит утверждённую версию');
    assert.match(await ui.text(`${panel}.querySelector('.row.gap-lg .mono')`), /^1 · ред\. 1\.0$/);

    await routeStep(users.head, doc.id, 'approve');
    await loginAs(users.legal);
    await openDocs(doc.id);
    await act('Согласовать этап', 'POST', `/api/v1/documents/${doc.id}/approve`);
    await routeStep(users.board, doc.id, 'approve');

    await loginAs(users.owner);
    await openDocs(doc.id);
    await ui.waitFor(`${panel}?.querySelector('.panel-h .chip')?.textContent === 'Утверждён'`, 'версия 2 утверждена');
    assert.match(await ui.text(`${panel}.querySelector('.row.gap-lg .mono')`), /^2 · ред\. 2\.0$/);
    const items = await ui.evaluate(`[...${panel}.querySelectorAll('.hist-item')].map((h) => h.textContent)`);
    assert.ok(items.some((t) => t.startsWith('Версия 1 · ред. 1.0 · утверждена')), items.join('\n'));
    assert.ok(items.some((t) => t.startsWith('Версия 2 · ред. 2.0 · утверждена')), items.join('\n'));
  });
});
