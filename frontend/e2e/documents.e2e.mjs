// Сквозной тест раздела «Документы» тем же путём, что и браузер пользователя:
// Chrome → Vite (прокси /api) → backend → PostgreSQL, настоящие щелчки и ввод с клавиатуры.
//
//   npm run test:e2e   (логин и пароль администратора — из frontend/.env.e2e или E2E_LOGIN / E2E_PASSWORD)
//
// Маршрут 1.2.0 (ADR-0024): драфт → проверка сотрудниками → начальник ИБ → ответственные лица → перевод → подписание.
// Маршрут проходят разные пользователи: тест заводит владельца документа, его руководителя, сотрудника ИБ, начальника ИБ и читателя документов,
// каждый входит через форму входа (при первом входе — смена временного пароля). Документы готовятся через API.
// В конце документы и задачи прогона уходят в архив, тестовые пользователи отключаются.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { $, launchBrowser, portalToday } from './browser.mjs';
import { pagesPdf, pickFiles, tempFile, tinyDocx, tinyPdf, tinyPng, uploadViaApi } from './files.mjs';

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

/**
 * Действие маршрута через API. 12 → 13 — с файлом автора (1.4.0): нет — автор прикладывает. 13 → 14 — без загрузки
 * (согласуется последний файл автора); 14 → 15 — финальную версию загружает тот, кто действует.
 */
async function routeStep(u, id, action, comment) {
  let d = await apiAs(u, 'GET', `/api/v1/documents/${id}`);
  if (action === 'to_head' && !d.files.some((f) => f.marks.includes('Файл драфта'))) {
    const up = await uploadViaApi(ui, `Документ ${id.slice(0, 8)}.pdf`, tinyPdf());
    d = (await api('POST', `/api/v1/documents/${id}/files`, { version: d.version, stage: d.working.stage, fileIds: [up.id] })).document;
  }
  const fileId = action === 'ack_final' ? (await uploadViaApi(ui, `Версия ${id.slice(0, 8)}.pdf`, tinyPdf())).id : undefined;
  return api('POST', `/api/v1/documents/${id}/actions/${action}`, { version: d.version, stage: d.working.stage, comment, fileId });
}

async function signViaApi(u, id) {
  const d = await apiAs(u, 'GET', `/api/v1/documents/${id}`);
  const fileId = (await uploadViaApi(ui, `Подписан ${id.slice(0, 8)}.pdf`, tinyPdf())).id;
  return api('POST', `/api/v1/documents/${id}/sign`, { version: d.version, stage: 16, fileId, signedOn: portalToday() });
}

/** Выбрать файл в форме карточки (как пользователь: выбор файла). */
async function pickInForm(form, name) {
  const input = `.dash .panel.w4 form[aria-label="${form}"] input[type=file]`;
  await ui.waitFor(`!!document.querySelector(${JSON.stringify(input)})`, `поле файла в форме «${form}»`);
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

const STEPS = [['owner', 'to_review'], ['owner', 'to_head'], ['head', 'approve'], ['head', 'ack_final'], ['head', 'to_signing']];
const STAGE_OF = { to_review: 11, to_head: 12, approve: 13, ack_final: 14, to_signing: 15 };

/** Провести документ через API до этапа stage (11…16). */
async function moveViaApi(id, stage) {
  for (const [who, action] of STEPS) {
    if (STAGE_OF[action] >= stage) continue;
    if (action === 'ack_final') await partyViaApi(id);
    await routeStep(users[who], id, action);
  }
}

/** Этап 14: ответственное лицо, его согласование отмечает начальник ИБ (подготовка данных). */
async function partyViaApi(id) {
  let d = await apiAs(users.head, 'GET', `/api/v1/documents/${id}`);
  d = (await api('POST', `/api/v1/documents/${id}/parties`, { version: d.version, stage: d.working.stage, fullName: 'Сидоров С. С.', department: 'ДИКТ', dueDate: portalToday() })).document;
  const p = d.parties.find((x) => !x.approvedAt);
  await api('POST', `/api/v1/documents/${id}/parties/${p.id}/approve`, { version: d.version, stage: d.working.stage });
}

async function signAllViaApi(id) {
  await moveViaApi(id, 16);
  await signViaApi(users.owner, id);
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
    ['chief', 'Руководитель Автора', ['ib_staff']],
    ['owner', 'Автор Документов', ['ib_staff']],
    ['staff', 'Сотрудник Отдела', ['ib_staff']],
    ['head', 'Начальник Отдела ИБ', ['ib_staff', 'ib_head']],
    ['legal', 'Читатель Документов', ['doc_reader']],
  ]) {
    const r = await api('POST', '/api/v1/users', {
      login: `${RUN.toLowerCase()}.${key}`, fullName: `${fullName} ${RUN}`, roleIds: codes.map(role),
      ...(key === 'owner' ? { managerId: users.chief.id } : {}),
    });
    users[key] = { key, id: r.user.id, login: r.user.login, fullName: r.user.fullName, password: r.temporaryPassword, version: r.user.version };
  }
  // Этап «Начальник ИБ» — по отметке (1.4.0): передать её начальнику прогона; отключение в after снимет её.
  const marked = await api('PUT', `/api/v1/users/${users.head.id}/ib-head`, { version: users.head.version, value: true, transfer: true });
  assert.equal(marked.isIbHead, true);
  users.head.version = marked.version;
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

describe('Документы: маршрут 1.2.0', () => {
  it('драфт → проверка сотрудниками → начальник ИБ → ответственные лица → перевод → подписание', async () => {
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
    const id = (await ui.response(created)).document.id;
    await ui.waitFor(`${panel}?.querySelector('.panel-h h3')?.textContent === ${JSON.stringify(title)}`, 'карточка нового документа');
    assert.equal(await ui.text(`${panel}.querySelector('.panel-h .chip')`), 'Черновик');
    assert.equal(await ui.evaluate(`${stepState('Драфт')}`), 'step cur');

    // Автор: «ждёт вас»; прикладывает файл драфта и отправляет на проверку сотрудникам.
    await loginAs(users.owner);
    await openDocs();
    await ui.click(`[...document.querySelectorAll('.filters button')].find((b) => b.textContent.startsWith('Ждут вас'))`);
    await ui.waitFor(`!!${row(title)}`, 'документ в «Ждут вас» у автора');
    await ui.click(row(title));
    await ui.click($.button('Приложить файл документа', panel));
    await pickInForm('Файлы драфта', 'Драфт.pdf');
    await act('Приложить', 'POST', `/api/v1/documents/${id}/files`);
    await ui.waitFor(`!!${panel}.querySelector('[data-file-kind=draft]')`, 'файл драфта в карточке');
    await ui.click($.button('Отправить на проверку сотрудникам', panel));
    let req = await act('Отправить на проверку сотрудникам', 'POST', `/api/v1/documents/${id}/actions/to_review`);
    assert.equal(req.json.stage, 11);
    await ui.waitFor(`${stepState('Проверка сотрудниками')}?.includes('cur')`, 'этап — проверка сотрудниками');

    // Сотрудник ИБ оставляет комментарий; перевести дальше не может.
    await loginAs(users.staff);
    await openDocs(id);
    await ui.waitFor(`!!${panel}?.querySelector('textarea[aria-label="Комментарий"]')`, 'поле комментария');
    assert.equal(await ui.evaluate(`!!${$.button('На согласование начальнику ИБ', panel)}`), false, 'сотрудник не переводит дальше');
    await ui.type(`${panel}.querySelector('textarea[aria-label="Комментарий"]')`, 'В п. 4 нет срока');
    await act('Добавить комментарий', 'POST', `/api/v1/documents/${id}/comments`);
    await ui.waitFor(`${panel}.textContent.includes('В п. 4 нет срока')`, 'комментарий в карточке');

    // Руководитель автора переводит к начальнику ИБ.
    await loginAs(users.chief);
    await openDocs(id);
    await ui.click($.button('На согласование начальнику ИБ', panel));
    await act('На согласование начальнику ИБ', 'POST', `/api/v1/documents/${id}/actions/to_head`);
    await ui.waitFor(`${stepState('Согласование начальника ИБ')}?.includes('cur')`, 'этап — начальник ИБ');

    // Начальник ИБ: счётчик «ждёт вас»; «Согласовать» — только с файлом версии.
    await loginAs(users.head);
    await openDocs(id);
    await ui.waitFor(`Number(document.querySelector('[data-testid=nav-docs-n]')?.textContent) >= 1`, 'счётчик «ждёт вас» у «Документы»');
    // «Сейчас у» (1.4.0): в реестре и в карточке — начальник ИБ; под этапом — кто действует, у пройденных — кто и когда.
    const nowAt = `Сейчас у: ${users.head.fullName}`;
    await ui.waitFor(`document.querySelector('tr[data-doc="${id}"] [data-testid=doc-holders]')?.textContent === ${JSON.stringify(nowAt)}`, '«Сейчас у» в реестре');
    await ui.waitFor(`${panel}.querySelector('[data-testid=doc-now-at]')?.textContent === ${JSON.stringify(nowAt)}`, '«Сейчас у» в карточке');
    const stageWho = (stage) => ui.evaluate(`${panel}.querySelector('.vstep[data-stage="${stage}"] [data-testid=stage-who]')?.textContent ?? ''`);
    assert.match(await stageWho(13), new RegExp(`: ${users.head.fullName}$`));
    assert.match(await stageWho(16), new RegExp(`: ${users.owner.fullName}$`));
    assert.match(await ui.text(`${panel}.querySelector('.vstep[data-stage="12"] .vr')`), new RegExp(users.chief.fullName), 'пройденный этап — кто и когда');
    // 13 → 14 (1.4.0): начальник ИБ ничего не загружает — выбран последний файл автора, он подтверждает.
    await ui.click($.button('Согласовать', panel));
    const form = `${panel}.querySelector('form[aria-label="Согласовать"]')`;
    await ui.waitFor(`!!${form}?.querySelector('input[name=approve-file]:checked')`, 'файл автора выбран по умолчанию');
    assert.equal(await ui.evaluate(`!!${form}.querySelector('input[type=file]')`), false, 'загрузки нет');
    const chosen = await ui.evaluate(`${form}.querySelector('input[name=approve-file]:checked').value`);
    req = await act('Согласовать', 'POST', `/api/v1/documents/${id}/actions/approve`);
    assert.equal(req.json.fileId, chosen, 'согласован выбранный файл автора');
    await ui.waitFor(`${stepState('Согласование с ответственными лицами')}?.includes('cur')`, 'этап — ответственные лица');
    // Один файл — одна строка с обеими отметками.
    await ui.waitFor(`[...${panel}.querySelectorAll('[data-testid=file-marks]')].some((m) => m.textContent.startsWith('Файл драфта · Версия при согласовании начальником ИБ'))`, 'файл автора с отметкой согласования');

    // Этап 14: «Ознакомлен» появится, когда ответственные лица согласуют.
    assert.equal(await ui.evaluate(`!!${$.button('Ознакомлен с финальной версией', panel)}`), false, 'без лиц шага нет');
    assert.match(await ui.text(`${panel}.querySelector('.note.ro')`), /Добавьте ответственных лиц/);
    await ui.click($.button('Добавить ответственное лицо', panel));
    const pf = `${panel}.querySelector('form[aria-label="Ответственное лицо"]')`;
    await ui.type(label('ФИО', pf), 'Петров Пётр Петрович');
    await ui.type(label('Подразделение или должность', pf), 'Юридическое управление');
    // Лицо — внешний человек (1.4.0): ни e-mail, ни «Пользователь портала» в форме нет.
    assert.deepEqual(await ui.evaluate(`[...${pf}.querySelectorAll('label')].map((l) => l.firstChild?.textContent?.trim())`),
      ['ФИО', 'Подразделение или должность', 'Срок ответа']);
    await ui.evaluate(`(() => { const el = ${label('Срок ответа', pf)};
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(portalToday())});
      el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    req = await act('Добавить', 'POST', `/api/v1/documents/${id}/parties`);
    assert.equal(req.json.fullName, 'Петров Пётр Петрович');
    const party = `${panel}.querySelector('[data-party="Петров Пётр Петрович"]')`;
    await ui.waitFor(`!!${party}`, 'лицо в карточке');
    await ui.click($.button('Отметить согласование', party));
    await pickInForm('Согласование лица', 'Ответ Петрова.pdf');
    await act('Согласовал(а)', 'POST', '/approve');
    await ui.waitFor(`${party}?.textContent.includes('согласовал(а)') && ${party}.textContent.includes('Ответ Петрова.pdf')`, 'согласование и ответ лица');
    await ui.click($.button('Ознакомлен с финальной версией', panel));
    await pickInForm('Ознакомлен с финальной версией', 'Финальная.pdf');
    await act('Ознакомлен с финальной версией', 'POST', `/api/v1/documents/${id}/actions/ack_final`);
    await ui.waitFor(`${stepState('Перевод')}?.includes('cur')`, 'этап — перевод');

    // Этап 15: строка перевода — язык, переводчик текстом (не пользователь портала, 1.4.0), срок.
    await ui.click($.button('Добавить язык', panel));
    const tf = `${panel}.querySelector('form[aria-label="Язык перевода"]')`;
    await ui.type(label('Язык', tf), 'Таджикский');
    await ui.type(label('Переводчик (необязательно)', tf), 'Калинова Д. (бюро переводов)');
    await ui.evaluate(`(() => { const el = ${label('Срок перевода', tf)};
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(portalToday())});
      el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    req = await act('Добавить', 'POST', `/api/v1/documents/${id}/translations`);
    assert.equal(req.json.translatorName, 'Калинова Д. (бюро переводов)');
    const trRow = `${panel}.querySelector('[data-translation="Таджикский"]')`;
    await ui.waitFor(`${trRow}?.textContent.includes('переводчик Калинова Д. (бюро переводов)')`, 'язык и переводчик в карточке');
    assert.equal(await ui.evaluate(`!!${$.button('На подписание', panel)}`), false, 'без перевода шага нет');
    assert.equal(await ui.evaluate(`!!${$.button('Приложить перевод', trRow)}`), false, 'начальник ИБ файл перевода не прикладывает');
    assert.match(await ui.text(`${panel}.querySelector('.note.ro')`), /файл перевода: осталось 1/);
    await ui.waitFor(`${panel}.querySelector('[data-testid=doc-now-at]')?.textContent === ${JSON.stringify(`Сейчас у: ${users.owner.fullName}`)}`, '«Сейчас у» — автор');

    // Автор: документ «ждёт вас», прикладывает файл перевода.
    await loginAs(users.owner);
    await openDocs(id);
    await ui.waitFor(`${row(title)}?.textContent.includes('ждёт вас')`, 'у автора — «ждёт вас»');
    await ui.click($.button('Приложить перевод', trRow));
    await pickInForm('Файл перевода', 'Таджикский.pdf');
    await act('Приложить', 'POST', '/files');
    await ui.waitFor(`${trRow}?.textContent.includes('перевод приложен')`, 'перевод приложен');

    // Руководитель автора переводит на подписание.
    await loginAs(users.chief);
    await openDocs(id);
    await ui.click($.button('На подписание', panel));
    await act('На подписание', 'POST', `/api/v1/documents/${id}/actions/to_signing`);

    // Автор: уведомление «ждёт подписанного PDF» ведёт на документ (Г5).
    await loginAs(users.owner);
    await ui.goto(`/tasks?n=${++navSeq}`);
    await ui.click(`document.querySelector('button.bell')`, 'значок уведомлений');
    const note = `[...document.querySelectorAll('.notif-pop .notif')].find((n) => n.textContent.includes(${JSON.stringify(`«${title}» ждёт подписанного PDF`)}))`;
    await ui.waitFor(`!!${note}`, 'уведомление о подписании');
    await ui.click(note);
    await ui.waitFor(`location.pathname === '/documents' && ${panel}?.querySelector('.panel-h h3')?.textContent === ${JSON.stringify(title)}`, 'переход к документу из уведомления');
    await ui.click($.button('Загрузить подписанный PDF', panel));
    await pickInForm('Подписание', 'Подписан.pdf');
    req = await act('Подписан', 'POST', `/api/v1/documents/${id}/sign`);
    assert.equal(req.json.signedOn, portalToday());
    await ui.waitFor(`${panel}.querySelector('.panel-h .chip')?.textContent === 'Утверждён'`, 'документ подписан');
    assert.equal(await ui.evaluate(`[...${panel}.querySelectorAll('.vstep .step')].every((s) => s.classList.contains('done'))`), true, 'все этапы пройдены');
    assert.match(await ui.text(`${panel}.querySelector('.row.gap-lg')`), new RegExp(ru(plusYear()).replace(/\./g, '\\.')), 'пересмотр через 12 месяцев от подписания');
    assert.deepEqual(await ui.evaluate(`[...${panel}.querySelectorAll('[data-file-kind]')].map((f) => f.dataset.fileKind)`), ['draft', 'final']);
    const steps = await ui.text(panel);
    assert.ok(steps.includes(users.chief.fullName) && steps.includes(users.head.fullName), 'в маршруте — кто прошёл этапы');
    assert.ok(!steps.includes('История согласования'), 'без права подробной истории нет');

    await loginAs(admin);
    await openDocs(id);
    await ui.waitFor(`${panel}?.textContent.includes('История согласования')`, 'подробная история у администратора');
    const hist = await ui.evaluate(`[...${panel}.querySelectorAll('.hist-item')].map((h) => h.textContent)`);
    assert.ok(hist.some((h) => h.includes(users.owner.fullName) && h.includes('загрузил(а) подписанную версию 1')), hist.join('\n'));
    assert.ok(hist.some((h) => h.includes(users.chief.fullName) && h.includes('«Проверка сотрудниками» → «Согласование начальника ИБ»')), hist.join('\n'));
  });

  it('без ib.work видны только подписанные документы', async () => {
    const signed = await makeDoc('Подписанный');
    await signAllViaApi(signed.id);
    const draft = await makeDoc('Черновик');
    const atHead = await makeDoc('У начальника');
    await moveViaApi(atHead.id, 13);
    await loginAs(users.legal);
    assert.deepEqual(await ui.evaluate(`[...document.querySelectorAll('nav.nav a span:not(.nav-n)')].map((s) => s.textContent)`), ['Документы']);
    await openDocs();
    await ui.waitFor(`!!${row(`${RUN} Подписанный`)}`, 'подписанный документ виден юристу');
    assert.equal(await ui.evaluate(`!!${row(`${RUN} Черновик`)}`), false, 'черновик юристу не виден');
    assert.equal(await ui.evaluate(`!!${row(`${RUN} У начальника`)}`), false, 'документ на маршруте юристу не виден');
    assert.equal(await ui.evaluate(`[...document.querySelectorAll('.filters button')].some((b) => b.textContent.startsWith('Архив'))`), false, 'архива у юриста нет');
    // Подписанный PDF читатель открывает прямо в карточке (без прав, ADR-0024).
    await ui.click(row(`${RUN} Подписанный`));
    const m = ui.mark();
    await ui.click($.button('Подписанный PDF', panel));
    const pdf = await ui.request(m, 'GET', '/content');
    assert.equal(pdf.status, 200, 'подписанный PDF читателю выдаётся');
    await ui.goto(`/documents?doc=${draft.id}`);
    await ui.waitFor(`${panel}?.textContent.includes('Документ не найден или вам не виден')`, 'черновик по ссылке не открывается');

    // «Юрист» и «Правление» выведены из обращения: в ролях их нет, есть «Читатель документов».
    await loginAs(admin);
    const roles = (await api('GET', '/api/v1/roles')).items.map((r) => r.code);
    assert.ok(roles.includes('doc_reader') && !roles.includes('legal') && !roles.includes('board'), roles.join(', '));
  });
});

describe('Документы: блокеры', () => {
  it('открытый блокер останавливает шаг вперёд; снять — с комментарием', async () => {
    const doc = await makeDoc('Положение о доступе');
    await loginAs(users.owner);
    await openDocs(doc.id);
    await ui.waitFor(`!!${$.button('Отправить на проверку сотрудникам', panel)}`, 'шаг вперёд доступен');
    await ui.click($.button('Добавить блокер', panel));
    await ui.type(`${panel}.querySelector('form[aria-label="Блокер"] textarea')`, 'Ждём заключение ДИКТ');
    await act('Открыть блокер', 'POST', `/api/v1/documents/${doc.id}/blockers`);
    await ui.waitFor(`!!${panel}.querySelector('[data-blocker=open]')`, 'открытый блокер в карточке');
    assert.equal(await ui.evaluate(`!!${$.button('Отправить на проверку сотрудникам', panel)}`), false, 'с блокером шага нет');
    assert.match(await ui.text(`${panel}.querySelector('.note.ro')`), /Открытых блокеров: 1/);
    await ui.waitFor(`${row(`${RUN} Положение о доступе`)}?.textContent.includes('блокер')`, 'отметка блокера в реестре');
    await ui.click($.button('Снять блокер', panel));
    assert.equal(await ui.evaluate(`!!${$.button('Снять блокер', `${panel}.querySelector('form')`)}`), false, 'без комментария кнопка неактивна');
    await ui.type(`${panel}.querySelector('form[aria-label="Снятие блокера"] textarea')`, 'Заключение получено');
    await act('Снять блокер', 'POST', '/resolve');
    await ui.waitFor(`!!${panel}.querySelector('[data-blocker=resolved]') && !!${$.button('Отправить на проверку сотрудникам', panel)}`, 'блокер снят, шаг вперёд доступен');
  });
});

describe('Документы: возврат на доработку', () => {
  it('возврат только с комментарием; новый круг; автору — задача на доске со ссылкой на документ', async () => {
    const doc = await makeDoc('Регламент доступа');
    await moveViaApi(doc.id, 13);
    await loginAs(users.head);
    await openDocs(doc.id);
    await ui.click($.button('Вернуть на доработку', panel));
    await ui.waitFor(`!!${panel}.querySelector('form textarea')`, 'поле замечаний');
    assert.equal(await ui.evaluate(`!!${$.button('Вернуть автору', panel)}`), false, 'без комментария кнопка неактивна');
    const comment = 'Добавьте раздел о пересмотре прав раз в полгода';
    await ui.type(`${panel}.querySelector('form textarea')`, comment);
    // Записка к возврату — по желанию (1.4.0).
    await pickInForm('Вернуть на доработку', 'Замечания.pdf');
    const req = await act('Вернуть автору', 'POST', `/api/v1/documents/${doc.id}/actions/return`);
    assert.equal(req.json.comment, comment);
    assert.ok(req.json.fileId, 'возврат несёт записку');
    await ui.waitFor(`${panel}.querySelector('[data-testid=return-note]')?.textContent === 'Замечания.pdf'`, 'записка в блоке возврата');
    await ui.waitFor(`${panel}.querySelector('.panel-h .chip')?.textContent === 'Черновик'`, 'документ снова на «Драфт»');
    assert.ok((await ui.text(panel)).includes('круг 2'), 'маршрут начат заново: круг 2');

    // Автор: задача на доске, карточка ведёт на документ.
    await loginAs(users.owner);
    await ui.goto(`/tasks?n=${++navSeq}`);
    const taskTitle = `Доработать документ «${RUN} Регламент доступа»`;
    const card = `[...document.querySelectorAll('article.card')].find((c) => c.querySelector('.card-t')?.textContent === ${JSON.stringify(taskTitle)})`;
    await ui.waitFor(`!!${card}`, 'задача автору на доске');
    await ui.click(card);
    const drawer = `document.querySelector('aside.drawer[aria-label="Задача"]')`;
    await ui.waitFor(`${drawer}?.textContent.includes(${JSON.stringify(comment)})`, 'замечание в описании задачи');
    await ui.click(`[...${drawer}.querySelectorAll('a')].find((a) => a.textContent.startsWith('Документ #'))`);
    await ui.waitFor(`location.pathname === '/documents' && ${panel}?.querySelector('.panel-h h3')?.textContent === ${JSON.stringify(`${RUN} Регламент доступа`)}`, 'переход к документу из задачи');
    assert.match(await ui.text(`${panel}.querySelector('[data-testid=doc-returned]')`), new RegExp(`с этапа «Согласование начальника ИБ».*${comment}`));

    // Автор правит драфт и отправляет снова — задача доработки закрывается сама.
    await ui.click($.button('Изменить драфт', panel));
    await ui.type(label('Что изменено', panel), 'Добавлен раздел 6');
    await act('Сохранить', 'PATCH', `/api/v1/documents/${doc.id}`);
    await ui.click($.button('Отправить на проверку сотрудникам', panel));
    await act('Отправить на проверку сотрудникам', 'POST', `/api/v1/documents/${doc.id}/actions/to_review`);
    const tasks = (await api('GET', '/api/v1/tasks?archived=false')).items.filter((t) => t.title === taskTitle);
    assert.equal(tasks.length, 1);
    assert.notEqual(tasks[0].completedAt, null, 'задача доработки закрыта после отправки');
  });
});

describe('Документы: новая версия, отмена пересмотра, удаление', () => {
  it('подписанный документ → новая версия; «Отменить пересмотр» — действует подписанная', async () => {
    const doc = await makeDoc('Инструкция по паролям');
    await signAllViaApi(doc.id);
    await loginAs(users.owner);
    await openDocs(doc.id);
    await ui.click($.button('Новая версия', panel));
    const form = `${panel}.querySelector('form[aria-label="Новая версия"]')`;
    await ui.waitFor(`!!${form}`, 'форма новой версии');
    await ui.type(label('Редакция', form), '2.0');
    const req = await act('Создать версию 2', 'POST', `/api/v1/documents/${doc.id}/revise`);
    assert.equal(req.json.edition, '2.0');
    await ui.waitFor(`${panel}.querySelector('.panel-h .chip')?.textContent === 'На пересмотре'`, 'статус «На пересмотре»');
    await ui.waitFor(`${stepState('Драфт')}?.includes('cur')`, 'новая версия — на «Драфт»');

    // Пока версия 2 в работе, юрист видит действующую версию 1.
    await loginAs(users.legal);
    await openDocs(doc.id);
    await ui.waitFor(`${panel}?.querySelector('.panel-h .chip')?.textContent === 'Утверждён'`, 'юрист видит подписанную версию');
    assert.match(await ui.text(`${panel}.querySelector('.row.gap-lg .mono')`), /^1 · ред\. 1\.0$/);

    await loginAs(users.owner);
    await openDocs(doc.id);
    await ui.click($.button('Отменить пересмотр', panel));
    assert.equal(await ui.evaluate(`!!${$.button('Отменить пересмотр', `${panel}.querySelector('form')`)}`), false, 'без комментария кнопка неактивна');
    await ui.type(`${panel}.querySelector('form textarea')`, 'Изменения не понадобились');
    await act('Отменить пересмотр', 'POST', `/api/v1/documents/${doc.id}/cancel-revision`);
    await ui.waitFor(`${panel}.querySelector('.panel-h .chip')?.textContent === 'Утверждён'`, 'снова действует подписанная');
    const items = await ui.evaluate(`[...${panel}.querySelectorAll('.hist-item')].map((h) => h.textContent)`);
    assert.ok(items.some((t) => t.startsWith('Версия 2 · ред. 2.0 · пересмотр отменён')), items.join('\n'));
    assert.ok(items.some((t) => t.startsWith('Версия 1 · ред. 1.0 · подписана')), items.join('\n'));
  });

  it('неподписанный документ удаляет пользователь с docs.delete; он пропадает из реестра', async () => {
    const doc = await makeDoc('Лишний драфт');
    await loginAs(users.owner);
    await openDocs(doc.id);
    await ui.waitFor(`!!${panel}?.querySelector('.panel-h h3')`, 'карточка');
    assert.equal(await ui.evaluate(`!!${$.button('Удалить', panel)}`), false, 'без docs.delete кнопки нет');
    await loginAs(users.head);
    await openDocs(doc.id);
    await ui.click($.button('Удалить', panel));
    await ui.type(`${panel}.querySelector('form textarea')`, 'Дубль');
    await act('Удалить документ', 'POST', `/api/v1/documents/${doc.id}/delete`);
    await ui.waitFor(`!${row(`${RUN} Лишний драфт`)}`, 'документ пропал из реестра');
    const r = await ui.evaluate(`fetch('/api/v1/documents/${doc.id}').then((x) => x.status)`);
    assert.equal(r, 404);
  });
});

describe('Документы: просмотр файлов на весь экран (1.4.0, шаг 8)', () => {
  const viewer = `document.querySelector('[data-testid=file-viewer]')`;
  const viewBtn = (name) => `${panel}.querySelector('[data-view-file=${JSON.stringify(name)}]')`;
  const page = () => ui.evaluate(`${viewer}?.querySelector('[data-testid=viewer-page]')?.textContent ?? ''`);
  const canvasCss = () => ui.evaluate(`Math.round(${viewer}.querySelector('canvas').getBoundingClientRect().width)`);
  const upload = async (name, data) => (await uploadViaApi(ui, name, data)).id;

  it('PDF на весь экран: ← → по страницам, «+» увеличивает, Esc закрывает только просмотрщик и возвращает фокус; .docx — сообщение и кнопки', async () => {
    const doc = await makeDoc('Просмотр файлов');
    let d = await apiAs(admin, 'GET', `/api/v1/documents/${doc.id}`);
    const pdfName = `${RUN} Три страницы.pdf`;
    const docxName = `${RUN} Политика.docx`;
    const ids = [await upload(pdfName, pagesPdf(['Page one', 'Page two', 'Page three'])), await upload(docxName, tinyDocx())];
    d = (await api('POST', `/api/v1/documents/${doc.id}/files`, { version: d.version, stage: d.working.stage, fileIds: ids })).document;
    await loginAs(admin);
    await openDocs(doc.id);
    await ui.waitFor(`!!${viewBtn(pdfName)}`, 'файл автора в карточке');

    // Обработчик Esc «окна под просмотрщиком»: до него нажатие доходить не должно.
    await ui.evaluate(`window.__escBelow = 0; document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.__escBelow++; })`);
    await ui.click(viewBtn(pdfName), 'файл PDF');
    await ui.waitFor(`!!${viewer}`, 'просмотрщик открыт');
    assert.deepEqual(await ui.evaluate(`(() => { const r = ${viewer}.getBoundingClientRect(); return [r.left, r.top, r.width === innerWidth, r.height === innerHeight]; })()`), [0, 0, true, true], 'на весь экран');
    await ui.waitFor(`${viewer}.querySelector('canvas')?.width > 0 && !${viewer}.querySelector('canvas.is-rendering')`, 'страница нарисована');
    assert.equal(await page(), '1 / 3');
    // Рендер в пикселях устройства: ширина canvas = CSS-ширина × devicePixelRatio.
    assert.ok(await ui.evaluate(`(() => { const c = ${viewer}.querySelector('canvas'); return Math.abs(c.width - c.getBoundingClientRect().width * devicePixelRatio) <= 2; })()`), 'canvas в разрешении экрана');
    await ui.press('ArrowRight');
    await ui.waitFor(`${viewer}.querySelector('[data-testid=viewer-page]')?.textContent === '2 / 3'`, 'страница 2');
    await ui.press('ArrowRight');
    await ui.press('ArrowRight'); // дальше последней — нет
    await ui.waitFor(`${viewer}.querySelector('[data-testid=viewer-page]')?.textContent === '3 / 3'`, 'страница 3');
    await ui.press('ArrowLeft');
    await ui.waitFor(`${viewer}.querySelector('[data-testid=viewer-page]')?.textContent === '2 / 3'`, 'снова страница 2');
    await ui.waitFor(`!${viewer}.querySelector('canvas.is-rendering')`, 'страница 2 нарисована');
    const before = await canvasCss();
    await ui.press('Plus');
    await ui.waitFor(`${viewer}.querySelector('[data-testid=viewer-zoom]')?.textContent === '125 %' && !${viewer}.querySelector('canvas.is-rendering')`, 'увеличение 125 %');
    assert.ok((await canvasCss()) > before, 'страница стала шире');

    await ui.press('Escape');
    await ui.waitFor(`!${viewer}`, 'просмотрщик закрыт');
    assert.equal(await ui.evaluate(`window.__escBelow`), 0, 'Esc не дошёл до окон под просмотрщиком');
    assert.equal(await ui.evaluate(`document.querySelectorAll('canvas').length`), 0, 'canvas освобождён');
    assert.equal(await ui.evaluate(`!!${panel}.querySelector('.vsteps')`), true, 'карточка документа на месте');
    await ui.waitFor(`document.activeElement === ${viewBtn(pdfName)}`, 'фокус вернулся на кнопку файла');

    // .docx файла версии: сообщение и обе кнопки.
    await ui.click(viewBtn(docxName), 'файл .docx');
    await ui.waitFor(`!!${viewer}?.querySelector('[data-testid=viewer-docx]')`, 'сообщение для .docx');
    assert.match(await ui.text(`${viewer}.querySelector('[data-testid=viewer-docx]')`), /Для просмотра в портале приложите PDF; \.docx открывается в OnlyOffice/);
    assert.deepEqual(await ui.evaluate(`[...${viewer}.querySelectorAll('[data-testid=viewer-docx] .btn')].map((b) => b.textContent)`), ['Скачать', 'Открыть в OnlyOffice']);
    assert.equal(await ui.evaluate(`${viewer}.querySelector('[data-testid=viewer-docx] a').getAttribute('href')`), d.current.onlyofficeUrl);
    await ui.click($.button('Закрыть', viewer));
    await ui.waitFor(`!${viewer}`, 'закрыт кнопкой');
  });

  it('ответ лица (PNG) — тем же окном; перевод .docx — только «Скачать»; записка к возврату; без доступа — окна нет', async () => {
    const doc = await makeDoc('Просмотр ответов');
    // Язык перевода заранее, документ — до этапа 14.
    let d = await apiAs(admin, 'GET', `/api/v1/documents/${doc.id}`);
    await api('POST', `/api/v1/documents/${doc.id}/translations`, { version: d.version, stage: d.working.stage, language: 'Таджикский', dueDate: portalToday() });
    await moveViaApi(doc.id, 14);
    d = await apiAs(users.head, 'GET', `/api/v1/documents/${doc.id}`);
    const pngName = `${RUN} Ответ.png`;
    d = (await api('POST', `/api/v1/documents/${doc.id}/parties`, { version: d.version, stage: d.working.stage, fullName: 'Иванова И. И.', department: 'Юристы', dueDate: portalToday() })).document;
    const party = d.parties.find((p) => !p.approvedAt);
    d = (await api('POST', `/api/v1/documents/${doc.id}/parties/${party.id}/approve`, { version: d.version, stage: d.working.stage, fileIds: [await upload(pngName, tinyPng())] })).document;
    await routeStep(users.head, doc.id, 'ack_final');
    // Этап 15: файл перевода (.docx) прикладывает автор.
    d = await apiAs(users.owner, 'GET', `/api/v1/documents/${doc.id}`);
    const trName = `${RUN} Перевод.docx`;
    const tr = d.translations[0];
    await api('POST', `/api/v1/documents/${doc.id}/translations/${tr.id}/files`, { version: d.version, stage: d.working.stage, fileIds: [await upload(trName, tinyDocx())] });

    await loginAs(admin);
    await openDocs(doc.id);
    const fileBtn = (name) => `[...${panel}.querySelectorAll('button')].find((b) => b.textContent === ${JSON.stringify(name)})`;
    await ui.click(fileBtn(pngName), 'ответ лица');
    await ui.waitFor(`${viewer}?.querySelector('img')?.naturalWidth > 0`, 'изображение в просмотрщике');
    await ui.press('Escape');
    await ui.waitFor(`!${viewer}`, 'закрыт');
    await ui.click(fileBtn(trName), 'перевод .docx');
    await ui.waitFor(`!!${viewer}?.querySelector('[data-testid=viewer-docx]')`, 'сообщение для .docx перевода');
    assert.deepEqual(await ui.evaluate(`[...${viewer}.querySelectorAll('[data-testid=viewer-docx] .btn')].map((b) => b.textContent)`), ['Скачать'], 'у перевода нет ссылки OnlyOffice');
    await ui.press('Escape');
    await ui.waitFor(`!${viewer}`, 'закрыт');

    // Записка к возврату (PDF): возврат с этапа 15 с файлом.
    d = await apiAs(users.head, 'GET', `/api/v1/documents/${doc.id}`);
    const noteName = `${RUN} Замечания.pdf`;
    await api('POST', `/api/v1/documents/${doc.id}/actions/return`, { version: d.version, stage: d.working.stage, comment: 'Уточнить перевод', fileId: await upload(noteName, tinyPdf('Return note')) });
    await loginAs(admin);
    await openDocs(doc.id);
    await ui.click(`${panel}.querySelector('[data-testid=return-note]')`, 'записка к возврату');
    await ui.waitFor(`${viewer}?.querySelector('canvas')?.width > 0`, 'записка в просмотрщике');
    await ui.press('Escape');
    await ui.waitFor(`!${viewer}`, 'закрыт');

    // Без доступа: файл сняли, пока карточка открыта (файл без ссылок удаляется) — 404, окна нет, сообщение.
    d = await apiAs(admin, 'GET', `/api/v1/documents/${doc.id}`);
    const tmpName = `${RUN} Временный.pdf`;
    d = (await api('POST', `/api/v1/documents/${doc.id}/files`, { version: d.version, stage: d.working.stage, fileIds: [await upload(tmpName, tinyPdf('Temp'))] })).document;
    const tmp = d.files.find((f) => f.file.name === tmpName);
    await loginAs(admin);
    await openDocs(doc.id);
    await ui.waitFor(`!!${viewBtn(tmpName)}`, 'файл в карточке');
    const fresh = await api('GET', `/api/v1/documents/${doc.id}`);
    await api('POST', `/api/v1/documents/${doc.id}/files/${tmp.id}/remove`, { version: fresh.version, stage: fresh.working.stage });
    const m = ui.mark();
    await ui.click(viewBtn(tmpName), 'снятый файл');
    const req = await ui.request(m, 'GET', `/api/v1/files/${tmp.file.id}/content`);
    assert.ok([403, 404].includes(req.status), `ответ ${req.status}`);
    await ui.waitFor(`document.querySelector('.toast.on')?.textContent === 'Файл недоступен'`, 'сообщение «Файл недоступен»');
    assert.equal(await ui.evaluate(`!!${viewer} || !!document.querySelector('[data-testid=viewer-loading]')`), false, 'окна нет');
    // Читатель документов к файлам версии на маршруте доступа не имеет.
    await apiAs(users.legal, 'GET', '/api/v1/auth/me');
    const denied = await ui.evaluate(`fetch('/api/v1/files/${d.files[0].file.id}/content').then((r) => r.status)`);
    assert.ok([403, 404].includes(denied), `читатель: ${denied}`);
  });
});

describe('Документы: фильтры и порядок', () => {
  it('автор, тип и срок пересмотра; по типам — ветки, сначала «Политика»; по алфавиту — без веток', async () => {
    const late = await makeDoc('Ялта фильтр');
    const early = await makeDoc('Анапа фильтр', { ownerId: users.staff.id });
    await loginAs(admin);
    await openDocs();
    const titles = `[...document.querySelectorAll('.docs-tbl tbody tr[data-doc]')].map((tr) => tr.querySelector('td .w500')?.textContent ?? '').filter((t) => t.startsWith(${JSON.stringify(RUN)}) && t.endsWith('фильтр'))`;
    const shows = (list, what) => ui.waitFor(`JSON.stringify(${titles}) === ${JSON.stringify(JSON.stringify(list))}`, what);
    const select = (name) => `document.querySelector('[data-testid=docs-filters] select[aria-label="${name}"]')`;

    // По умолчанию — по типам: документы прогона в ветке своего типа; «Политика», если есть, — первая ветка.
    await ui.waitFor(`!!document.querySelector('[data-testid=doc-type-group][data-type-id="${docType.id}"]')`, 'ветка типа документов прогона');
    const types = await ui.evaluate(`[...document.querySelectorAll('[data-testid=doc-type-group]')].map((tr) => tr.dataset.type)`);
    const policy = types.findIndex((t) => t.trim().toLowerCase() === 'политика');
    assert.ok(policy <= 0, `«Политика» — первая ветка: ${types.join(', ')}`);
    await shows([`${RUN} Анапа фильтр`, `${RUN} Ялта фильтр`], 'внутри ветки — по алфавиту');

    // Ветка сворачивается и разворачивается.
    const caret = `document.querySelector('[data-testid=doc-type-group][data-type-id="${docType.id}"] button')`;
    await ui.click(caret, 'свернуть ветку');
    await shows([], 'ветка свёрнута');
    await ui.click(caret, 'развернуть ветку');
    await shows([`${RUN} Анапа фильтр`, `${RUN} Ялта фильтр`], 'ветка развёрнута');

    // Автор и тип.
    await ui.select(select('Автор'), users.staff.id);
    await shows([`${RUN} Анапа фильтр`], 'только документы автора');
    await ui.select(select('Тип документа'), docType.id);
    await shows([`${RUN} Анапа фильтр`], 'автор и тип');
    await ui.click($.button('Сбросить'), 'сбросить фильтры');
    await shows([`${RUN} Анапа фильтр`, `${RUN} Ялта фильтр`], 'фильтры сброшены');

    // Срок пересмотра: у черновиков его нет — в фильтр по сроку не попадают.
    await ui.select(select('Срок пересмотра'), 'd365');
    await shows([], 'черновики без срока пересмотра');
    await ui.select(select('Срок пересмотра'), 'to');
    await ui.waitFor(`!!document.querySelector('[data-testid=docs-filters] input[type=date]')`, 'поле «До даты»');
    await ui.click($.button('Сбросить'), 'сбросить фильтры');

    // По алфавиту — без веток; выбор запоминается.
    await ui.click($.button('По алфавиту'), 'по алфавиту');
    await ui.waitFor(`!document.querySelector('[data-testid=doc-type-group]')`, 'без веток');
    await shows([`${RUN} Анапа фильтр`, `${RUN} Ялта фильтр`], 'по алфавиту');
    await openDocs();
    await ui.waitFor(`document.querySelector('[data-testid=docs-filters] button[aria-pressed=true]')?.textContent === 'По алфавиту'`, 'порядок запомнился');
    await ui.click($.button('По типам'), 'по типам');
    await ui.waitFor(`!!document.querySelector('[data-testid=doc-type-group]')`, 'снова ветки');
    assert.ok(late.id && early.id);
  });
});
