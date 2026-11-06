// Сквозной тест раздела «Документы» тем же путём, что и браузер пользователя:
// Chrome → Vite (прокси /api) → backend → PostgreSQL, настоящие щелчки и ввод с клавиатуры.
//
//   npm run test:e2e   (логин и пароль администратора — из frontend/.env.e2e или E2E_LOGIN / E2E_PASSWORD)
//
// Маршрут 1.11.0 (ADR-0042): «Драфт» (и проверка начальника ИБ) → «Согласование» (и повторная проверка) → «Перевод» →
// «Утверждение» — единственный этап с файлами. Маршрут проходят разные пользователи: тест заводит владельца документа,
// его руководителя, сотрудника ИБ, начальника ИБ и читателя документов,
// каждый входит через форму входа (при первом входе — смена временного пароля). Документы готовятся через API.
// В конце документы и задачи прогона уходят в архив, тестовые пользователи отключаются.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { $, launchBrowser, portalToday } from './browser.mjs';
import { restoreIbHead, saveIbHead } from './ib-head.mjs';
import { pagesPdf, pickFiles, tempFile, tinyDocx, tinyPdf, uploadViaApi } from './files.mjs';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const LOGIN = process.env.E2E_LOGIN;
const PASSWORD = process.env.E2E_PASSWORD;
const RUN = `E2E-${Date.now().toString(36)}`;
const URL1 = 'https://office.example.local/products/files/doceditor.aspx?fileid=';

let ui;
let docType;
/** Держатель отметки «Начальник ИБ» до прогона — ему она возвращается в after. */
let savedHead;
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

/** Действие маршрута через API от имени пользователя; «Отправить на перевод» — с отметкой «не изменялся». */
async function routeStep(u, id, action, comment) {
  const d = await apiAs(u, 'GET', `/api/v1/documents/${id}`);
  return api('POST', `/api/v1/documents/${id}/actions/${action}`, {
    version: d.version, stage: d.working.stage, comment, ...(action === 'to_translation' ? { confirmUnchanged: true } : {}),
  });
}

/** Место маршрута рабочей версии: «21:draft», «21:head_review», «22:parties», «22:head_recheck», «23», «24». */
const placeOf = (d) => `${d.working.stage}${d.working.state ? `:${d.working.state}` : ''}`;
const PLACES = ['21:draft', '21:head_review', '22:parties', '23', '24'];

/** Провести документ через API до места маршрута (без повторной проверки). */
async function moveViaApi(id, target) {
  for (;;) {
    const d = await apiAs(admin, 'GET', `/api/v1/documents/${id}`);
    const p = placeOf(d);
    if (p === target) return;
    assert.ok(PLACES.indexOf(p) >= 0 && PLACES.indexOf(p) < PLACES.indexOf(target), `документ на ${p}, цель ${target}`);
    if (p === '21:draft') await routeStep(users.owner, id, 'submit_head');
    else if (p === '21:head_review') await routeStep(users.head, id, 'head_approve');
    else if (p === '22:parties') { await partyViaApi(id); await routeStep(users.owner, id, 'to_translation'); }
    else if (p === '23') await routeStep(users.owner, id, 'to_approval');
  }
}

/** Этап 22: ответственное лицо, его согласование отмечает автор (подготовка данных). */
async function partyViaApi(id) {
  let d = await apiAs(users.owner, 'GET', `/api/v1/documents/${id}`);
  if (!d.parties.length) {
    d = (await api('POST', `/api/v1/documents/${id}/parties`, { version: d.version, stage: d.working.stage, fullName: 'Сидоров С. С.', department: 'ДИКТ', dueDate: portalToday() })).document;
  }
  for (const p of d.parties.filter((x) => !x.approvedAt)) {
    d = (await api('POST', `/api/v1/documents/${id}/parties/${p.id}/approve`, { version: d.version, stage: d.working.stage })).document;
  }
}

/** Этап 24: файл утверждения через API (slot: pdf, docx, translation_docx, translation_pdf). */
async function approvalFileViaApi(id, slot, name, data, translationId) {
  const d = await apiAs(users.owner, 'GET', `/api/v1/documents/${id}`);
  const fileId = (await uploadViaApi(ui, name, data)).id;
  return (await api('POST', `/api/v1/documents/${id}/approval-files`, { version: d.version, stage: 24, slot, fileId, translationId })).document;
}

async function signAllViaApi(id) {
  await moveViaApi(id, '24');
  await approvalFileViaApi(id, 'pdf', `Подписан ${id.slice(0, 8)}.pdf`, tinyPdf());
  await approvalFileViaApi(id, 'docx', `Исходный ${id.slice(0, 8)}.docx`, tinyDocx());
  const d = await apiAs(users.owner, 'GET', `/api/v1/documents/${id}`);
  return api('POST', `/api/v1/documents/${id}/sign`, { version: d.version, stage: 24, signedOn: portalToday() });
}

/** Поле даты — через нативный сеттер (как пользователь выбирает дату в календаре). */
async function setValue(input, value) {
  await ui.evaluate(`(() => { const el = ${input};
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
}

/** В карточке нет ни одного поля загрузки файла (этапы 21–23). */
const noFileInputs = () => ui.evaluate(`!${panel}.querySelector('input[type=file]')`);

/** Файл в ячейку этапа 24 (как пользователь: выбор файла); ячейка сразу привязывает его к версии. */
async function pickInSlot(slot, name, data) {
  const input = `.dash .panel.w4 [data-slot="${slot}"] input[type=file]`;
  await ui.waitFor(`!!document.querySelector(${JSON.stringify(input)})`, `поле файла «${slot}»`);
  const m = ui.mark();
  const [up] = await pickFiles(ui, input, [tempFile(name, data)]);
  assert.equal(up.status, 201, up.body);
  const req = await ui.request(m, 'POST', '/approval-files');
  assert.equal(req.status, 200, req.body);
  await ui.waitFor(`!!document.querySelector(${JSON.stringify(`.dash .panel.w4 [data-slot="${slot}"] [data-view-file="${name}"]`)})`, `файл «${name}» в ячейке «${slot}»`);
}

/** Документ прогона через API от имени администратора (docs.manage). */
async function makeDoc(title, extra = {}) {
  const r = await apiAs(admin, 'POST', '/api/v1/documents', {
    title: `${RUN} ${title}`, typeId: docType.id, ownerId: users.owner.id, onlyofficeUrl: `${URL1}${navSeq}`, edition: '1.0', ...extra,
  });
  return r.document;
}

/** Все неархивные задачи, постранично (на доске — не больше 500). */
async function allTasks(as = null) {
  const out = [];
  for (let cursor = ''; ;) {
    const page = await (as ? apiAs(as, 'GET', `/api/v1/tasks?archived=false${cursor}`) : api('GET', `/api/v1/tasks?archived=false${cursor}`)).catch(() => ({ items: [], nextCursor: null }));
    out.push(...page.items);
    if (!page.nextCursor) return out;
    cursor = `&cursor=${encodeURIComponent(page.nextCursor)}`;
  }
}

/** Карточка задачи по ссылке: в dev-базе задач больше, чем помещается на доску. */
async function openTask(title, as) {
  const t = (await allTasks(as)).find((x) => x.title === title && !x.completedAt);
  assert.ok(t, `задача «${title}»`);
  await ui.goto(`/tasks?task=${t.id}&n=${++navSeq}`);
  const drawer = `document.querySelector('aside.drawer[aria-label="Задача"]')`;
  await ui.waitFor(`${drawer}?.textContent.includes(${JSON.stringify(title)})`, `карточка задачи «${title}»`);
  return drawer;
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
  // Этап «Начальник ИБ» — по отметке (1.4.0): запомнить прежнего держателя и передать отметку начальнику прогона;
  // в after она возвращается прежнему держателю.
  savedHead = await saveIbHead(ui);
  const marked = await api('PUT', `/api/v1/users/${users.head.id}/ib-head`, { version: users.head.version, value: true, transfer: true });
  assert.equal(marked.isIbHead, true);
  users.head.version = marked.version;
});

after(async () => {
  // Уборка, даже если тест упал на середине: документы и задачи прогона — в архив, пользователи — отключить;
  // отметка «Начальник ИБ» — прежнему держателю (в finally).
  if (!ui) return;
  try {
    await cleanup();
  } finally {
    await loginAs(admin).catch(() => undefined);
    await restoreIbHead(ui, savedHead);
    ui.close();
  }
});

async function cleanup() {
  {
    await loginAs(admin).catch(() => undefined);
    const docs = await api('GET', '/api/v1/documents?archived=false&limit=500').catch(() => ({ items: [] }));
    for (const d of docs.items.filter((x) => x.title.startsWith(RUN))) {
      await api('POST', `/api/v1/documents/${d.id}/archive`, { version: d.version }).catch(() => undefined);
    }
    // Задачи этапов (1.6.3) получают все сотрудники ИБ dev-базы — их может быть больше страницы списка.
    for (const t of await allTasks()) {
      if (t.title.includes(RUN)) await api('POST', `/api/v1/tasks/${t.id}/archive`, { version: t.version }).catch(() => undefined);
    }
    for (const u of Object.values(users)) {
      const cur = (await api('GET', '/api/v1/users').catch(() => ({ items: [] }))).items.find((x) => x.id === u.id);
      if (cur?.isActive) await api('POST', `/api/v1/users/${u.id}/disable`, { version: cur.version }).catch(() => undefined);
    }
    assert.deepEqual(ui.consoleErrors, [], 'ошибки JavaScript в странице');
  }
}

describe('Документы: маршрут 1.11.0', () => {
  it('драфт → проверка начальника ИБ → согласование (повторная проверка и возврат) → перевод ссылкой → утверждение с файлами и приказом', async () => {
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
    await ui.waitFor(`${panel}?.querySelector('.dr-title')?.textContent === ${JSON.stringify(title)}`, 'карточка нового документа');
    assert.equal(await ui.text(`${panel}.querySelector('.panel-h .chip')`), 'Черновик');
    assert.equal(await ui.evaluate(`${stepState('Драфт')}`), 'step cur');
    assert.deepEqual(await ui.evaluate(`[...${panel}.querySelectorAll('.vstep')].map((v) => v.querySelector('b').textContent)`), ['Драфт', 'Согласование', 'Перевод', 'Утверждение']);

    // Автор: «ждёт вас»; ответственное лицо уже в драфте — срок днями; файлов на этапе нет; на проверку начальнику ИБ.
    await loginAs(users.owner);
    await openDocs();
    await ui.click(`[...document.querySelectorAll('.filters button')].find((b) => b.textContent.startsWith('Ждут вас'))`);
    await ui.waitFor(`!!${row(title)}`, 'документ в «Ждут вас» у автора');
    await ui.click(row(title));
    await ui.waitFor(`!!${$.button('Отправить на проверку начальнику ИБ', panel)}`, 'шаг автора в драфте');
    assert.equal(await noFileInputs(), true, 'в драфте полей загрузки нет');
    await ui.click($.button('Добавить ответственное лицо', panel));
    const pf = `${panel}.querySelector('form[aria-label="Ответственное лицо"]')`;
    await ui.type(label('ФИО', pf), 'Петров Пётр Петрович');
    await ui.type(label('Подразделение или должность', pf), 'Юридическое управление');
    assert.deepEqual(await ui.evaluate(`[...${pf}.querySelectorAll('label')].map((l) => l.firstChild?.textContent?.trim())`), ['ФИО', 'Подразделение или должность', 'Срок ответа, дней']);
    await setValue(label('Срок ответа, дней', pf), '10');
    let req = await act('Добавить', 'POST', `/api/v1/documents/${id}/parties`);
    assert.equal(req.json.dueDays, 10);
    const party = `${panel}.querySelector('[data-party="Петров Пётр Петрович"]')`;
    await ui.waitFor(`${party}?.textContent.includes('срок 10 дн. от перехода на «Согласование»')`, 'срок днями в карточке');
    assert.equal(await ui.evaluate(`!!${$.button('Отметить согласование', party)}`), false, 'в драфте согласование не отмечается');
    await ui.click($.button('Отправить на проверку начальнику ИБ', panel));
    req = await act('Отправить на проверку начальнику ИБ', 'POST', `/api/v1/documents/${id}/actions/submit_head`);
    assert.equal(req.json.stage, 21);
    await ui.waitFor(`${panel}.querySelector('.vstep[data-stage="21"] [data-testid=stage-place]')?.textContent === 'На проверке у начальника ИБ'`, '«На проверке у начальника ИБ»');

    // Сотрудник ИБ комментирует на любом этапе; действий у него нет.
    await loginAs(users.staff);
    await openDocs(id);
    await ui.waitFor(`!!${panel}?.querySelector('textarea[aria-label="Комментарий"]')`, 'поле комментария');
    assert.equal(await ui.evaluate(`!!${$.button('Одобрить', panel)}`), false, 'сотрудник не одобряет');
    await ui.type(`${panel}.querySelector('textarea[aria-label="Комментарий"]')`, 'В п. 4 нет срока');
    await act('Добавить комментарий', 'POST', `/api/v1/documents/${id}/comments`);
    await ui.waitFor(`${panel}.textContent.includes('В п. 4 нет срока')`, 'комментарий в карточке');

    // Начальник ИБ: счётчик, «Сейчас у», «Одобрить» без файла.
    await loginAs(users.head);
    await openDocs(id);
    await ui.waitFor(`Number(document.querySelector('[data-testid=nav-docs-n]')?.textContent) >= 1`, 'счётчик «ждёт вас» у «Документы»');
    const nowAt = `Сейчас у: ${users.head.fullName}`;
    await ui.waitFor(`document.querySelector('tr[data-doc="${id}"] [data-testid=doc-holders]')?.textContent === ${JSON.stringify(nowAt)}`, '«Сейчас у» в реестре');
    await ui.waitFor(`${panel}.querySelector('[data-testid=doc-now-at]')?.textContent === ${JSON.stringify(nowAt)}`, '«Сейчас у» в карточке');
    assert.equal(await noFileInputs(), true, 'на проверке полей загрузки нет');
    await ui.click($.button('Одобрить', panel));
    const form = `${panel}.querySelector('form[aria-label="Одобрить"]')`;
    await ui.waitFor(`${form}?.textContent.includes('Содержимое по ссылке не фиксируется')`, 'одобрение — по ссылке OnlyOffice');
    await act('Одобрить', 'POST', `/api/v1/documents/${id}/actions/head_approve`);
    await ui.waitFor(`${stepState('Согласование')}?.includes('cur')`, 'этап — «Согласование»');

    // Автор: срок лица стал датой; отметка — с датой согласования, без файла; повторная проверка.
    await loginAs(users.owner);
    await openDocs(id);
    await ui.waitFor(`${party}?.textContent.includes('срок ') && !${party}.textContent.includes('дн. от перехода')`, 'срок лица — дата');
    assert.equal(await noFileInputs(), true, 'на «Согласовании» полей загрузки нет');
    await ui.click($.button('Отметить согласование', party));
    const af = `${panel}.querySelector('form[aria-label="Согласование лица"]')`;
    await ui.waitFor(`${label('Дата согласования', af)}?.value === ${JSON.stringify(portalToday())}`, 'дата согласования — сегодня');
    assert.equal(await ui.evaluate(`!!${af}.querySelector('input[type=file]')`), false, 'ответ файлом не прикладывается');
    await ui.type(label('Комментарий (необязательно)', af), 'Согласовано письмом');
    await act('Согласовал(а)', 'POST', '/approve');
    await ui.waitFor(`${party}?.textContent.includes('согласовал(а)')`, 'отметка согласования');
    await ui.click($.button('Повторная проверка', panel));
    await act('Повторная проверка', 'POST', `/api/v1/documents/${id}/actions/request_recheck`);
    await ui.waitFor(`${panel}.querySelector('.vstep[data-stage="22"] [data-testid=stage-place]')?.textContent === 'На повторной проверке у начальника ИБ'`, '«На повторной проверке»');

    // Начальник ИБ возвращает с повторной проверки: документ остаётся на «Согласовании», отметка — «до доработки».
    await loginAs(users.head);
    await ui.goto(`/tasks?n=${++navSeq}`);
    await ui.click(`document.querySelector('button.bell')`, 'значок уведомлений');
    const note = `[...document.querySelectorAll('.notif-pop .notif')].find((n) => n.textContent.includes(${JSON.stringify(`«${title}» доработан и ждёт повторной проверки`)}))`;
    await ui.waitFor(`!!${note}`, 'уведомление о повторной проверке');
    await ui.click(note);
    await ui.waitFor(`location.pathname === '/documents' && ${panel}?.querySelector('.dr-title')?.textContent === ${JSON.stringify(title)}`, 'переход к документу из уведомления');
    await ui.click($.button('Вернуть на доработку', panel));
    assert.equal(await ui.evaluate(`!!${$.button('Вернуть автору', panel)}`), false, 'без комментария кнопка неактивна');
    await ui.type(`${panel}.querySelector('form[aria-label="Вернуть на доработку"] textarea')`, 'Уточните раздел 3');
    await act('Вернуть автору', 'POST', `/api/v1/documents/${id}/actions/recheck_return`);
    await ui.waitFor(`${stepState('Согласование')}?.includes('cur') && !!${panel}.querySelector('[data-testid=doc-returned]')`, 'остался на «Согласовании», замечание в карточке');
    await ui.waitFor(`!!${party}?.querySelector('[data-testid=reworked]')`, 'отметка «до доработки»');

    // Автор: документ не менялся — «Отправить на перевод» с галочкой, без повторной проверки.
    await loginAs(users.owner);
    await openDocs(id);
    await ui.click($.button('Отправить на перевод', panel));
    const tr = `${panel}.querySelector('form[aria-label="Отправить на перевод"]')`;
    await ui.waitFor(`!!${tr}`, 'форма «на перевод»');
    assert.equal(await ui.evaluate(`${$.button('Отправить на перевод', tr)}`), undefined, 'без галочки кнопка неактивна');
    await ui.click(`${tr}.querySelector('input[type=checkbox]')`, 'галочка «не изменялся»');
    req = await act('Отправить на перевод', 'POST', `/api/v1/documents/${id}/actions/to_translation`);
    assert.equal(req.json.confirmUnchanged, true);
    await ui.waitFor(`${stepState('Перевод')}?.includes('cur')`, 'этап — «Перевод»');

    // «Перевод»: язык со ссылкой OnlyOffice; без ссылки дальше нельзя; файлов на этапе нет.
    assert.equal(await noFileInputs(), true, 'на «Переводе» полей загрузки нет');
    await ui.click($.button('Добавить язык', panel));
    const lf = `${panel}.querySelector('form[aria-label="Язык перевода"]')`;
    await ui.type(label('Язык', lf), 'Таджикский');
    await ui.type(label('Переводчик (необязательно)', lf), 'Калинова Д. (бюро переводов)');
    await setValue(label('Срок перевода', lf), portalToday());
    await act('Добавить', 'POST', `/api/v1/documents/${id}/translations`);
    const trRow = `${panel}.querySelector('[data-translation="Таджикский"]')`;
    await ui.waitFor(`${trRow}?.textContent.includes('нет ссылки на перевод')`, 'язык без ссылки');
    assert.equal(await ui.evaluate(`!!${$.button('На утверждение', panel)}`), false, 'без ссылки шага нет');
    assert.match(await ui.text(`${panel}.querySelector('.note.ro')`), /Не у всех языков есть ссылка на перевод: Таджикский/);
    await ui.click($.button('Добавить ссылку', trRow));
    const linkForm = `${panel}.querySelector('form[aria-label="Ссылка на перевод"]')`;
    await ui.type(`${linkForm}.querySelector('input[type=url]')`, `${URL1}tj`);
    await act('Сохранить ссылку', 'PATCH', '/translations/');
    await ui.waitFor(`!!${trRow}?.querySelector('a[href="${URL1}tj"]')`, 'ссылка на перевод');
    await ui.click($.button('На утверждение', panel));
    await act('На утверждение', 'POST', `/api/v1/documents/${id}/actions/to_approval`);
    await ui.waitFor(`${stepState('Утверждение')}?.includes('cur')`, 'этап — «Утверждение»');

    // «Утверждение»: PDF и Word основного языка, Word перевода; «Утвердить» с датой и приказом.
    await ui.waitFor(`!!${panel}.querySelector('[aria-label="Файлы утверждения"]')`, 'блок файлов утверждения');
    assert.equal(await ui.evaluate(`${$.button('Утвердить', panel)}`), undefined, 'без файлов «Утвердить» неактивна');
    await pickInSlot('Подписанный PDF', 'Подписан.pdf', tinyPdf('Signed'));
    await pickInSlot('Исходный документ Word', 'Политика.docx', tinyDocx());
    assert.match(await ui.text(`${panel}.querySelector('.note.ro')`), /Загрузите: Word перевода \(Таджикский\)/);
    await pickInSlot('Перевод (Таджикский): Word', 'Таджикский.docx', tinyDocx());
    await ui.click($.button('Утвердить', panel));
    const sf = `${panel}.querySelector('form[aria-label="Утверждение"]')`;
    await ui.waitFor(`!!${sf}`, 'форма утверждения');
    await ui.type(label('Номер приказа (необязательно)', sf), '15-ИБ');
    req = await act('Утвердить', 'POST', `/api/v1/documents/${id}/sign`);
    assert.equal(req.json.signedOn, portalToday());
    assert.equal(req.json.orderNo, '15-ИБ');
    await ui.waitFor(`${panel}.querySelector('.panel-h .chip')?.textContent === 'Утверждён'`, 'документ утверждён');
    assert.equal(await ui.evaluate(`[...${panel}.querySelectorAll('.vstep .step')].every((s) => s.classList.contains('done'))`), true, 'все этапы пройдены');
    assert.match(await ui.text(`${panel}.querySelector('.row.gap-lg')`), new RegExp(ru(plusYear()).replace(/\./g, '\\.')), 'пересмотр через 12 месяцев от утверждения');
    const versions = await ui.evaluate(`[...${panel}.querySelectorAll('.hist-item')].map((h) => h.textContent).find((t) => t.startsWith('Версия 1'))`);
    assert.match(versions, /утверждена .*Подписанный PDF.*Исходный Word.*приказ № 15-ИБ/);
    assert.ok(!(await ui.text(panel)).includes('История согласования'), 'без права подробной истории нет');

    await loginAs(admin);
    await openDocs(id);
    await ui.waitFor(`${panel}?.textContent.includes('История согласования')`, 'подробная история у администратора');
    const hist = await ui.evaluate(`[...${panel}.querySelectorAll('.hist-item')].map((h) => h.textContent)`);
    for (const part of ['утвердил(а) версию 1', 'отправил(а) версию 1 на перевод', 'Автор подтвердил: документ не изменялся', 'одобрил(а) версию 1', 'отправил(а) версию 1 на повторную проверку начальнику ИБ']) {
      assert.ok(hist.some((h) => h.includes(part)), `в истории: ${part}\n${hist.join('\n')}`);
    }
  });

  it('без ib.work видны только утверждённые документы', async () => {
    const signed = await makeDoc('Утверждённый');
    await signAllViaApi(signed.id);
    const draft = await makeDoc('Черновик');
    const atHead = await makeDoc('У начальника');
    await moveViaApi(atHead.id, '21:head_review');
    await loginAs(users.legal);
    assert.deepEqual(await ui.evaluate(`[...document.querySelectorAll('nav.nav a span:not(.nav-n)')].map((s) => s.textContent)`), ['Документы']);
    await openDocs();
    await ui.waitFor(`!!${row(`${RUN} Утверждённый`)}`, 'утверждённый документ виден читателю');
    assert.equal(await ui.evaluate(`!!${row(`${RUN} Черновик`)}`), false, 'черновик читателю не виден');
    assert.equal(await ui.evaluate(`!!${row(`${RUN} У начальника`)}`), false, 'документ на маршруте читателю не виден');
    assert.equal(await ui.evaluate(`[...document.querySelectorAll('.filters button')].some((b) => b.textContent.startsWith('Архив'))`), false, 'архива у читателя нет');
    // Подписанный PDF и исходный Word утверждённой версии читатель открывает в карточке.
    await ui.click(row(`${RUN} Утверждённый`));
    let m = ui.mark();
    await ui.click($.button('Подписанный PDF', panel));
    assert.equal((await ui.request(m, 'GET', '/content')).status, 200, 'подписанный PDF читателю выдаётся');
    await ui.press('Escape');
    m = ui.mark();
    await ui.click($.button('Исходный Word', panel));
    await ui.waitFor(`!!document.querySelector('[data-testid=viewer-docx]')`, 'Word — сообщение и «Скачать»');
    await ui.press('Escape');
    await ui.goto(`/documents?doc=${draft.id}`);
    await ui.waitFor(`${panel}?.textContent.includes('Документ не найден или вам не виден')`, 'черновик по ссылке не открывается');
    assert.ok(m >= 0);
  });
});

describe('Документы: блокеры', () => {
  it('открытый блокер останавливает шаг вперёд; снять — с комментарием', async () => {
    const doc = await makeDoc('Положение о доступе');
    await loginAs(users.owner);
    await openDocs(doc.id);
    const step = 'Отправить на проверку начальнику ИБ';
    await ui.waitFor(`!!${$.button(step, panel)}`, 'шаг вперёд доступен');
    await ui.click($.button('Добавить блокер', panel));
    await ui.type(`${panel}.querySelector('form[aria-label="Блокер"] textarea')`, 'Ждём заключение ДИКТ');
    await act('Открыть блокер', 'POST', `/api/v1/documents/${doc.id}/blockers`);
    await ui.waitFor(`!!${panel}.querySelector('[data-blocker=open]')`, 'открытый блокер в карточке');
    assert.equal(await ui.evaluate(`!!${$.button(step, panel)}`), false, 'с блокером шага нет');
    assert.match(await ui.text(`${panel}.querySelector('.note.ro')`), /Открытых блокеров: 1/);
    await ui.waitFor(`${row(`${RUN} Положение о доступе`)}?.textContent.includes('блокер')`, 'отметка блокера в реестре');
    await ui.click($.button('Снять блокер', panel));
    await ui.waitFor(`!!${panel}.querySelector('form[aria-label="Снятие блокера"]')`, 'форма снятия блокера');
    assert.equal(await ui.evaluate(`!!${$.button('Снять блокер', `${panel}.querySelector('form[aria-label="Снятие блокера"]')`)}`), false, 'без комментария кнопка неактивна');
    await ui.type(`${panel}.querySelector('form[aria-label="Снятие блокера"] textarea')`, 'Заключение получено');
    await act('Снять блокер', 'POST', '/resolve');
    await ui.waitFor(`!!${panel}.querySelector('[data-blocker=resolved]') && !!${$.button(step, panel)}`, 'блокер снят, шаг вперёд доступен');
  });
});

describe('Документы: возврат на доработку', () => {
  it('с проверки начальника ИБ — только с комментарием; новый круг; автору — задача на доске со ссылкой на документ', async () => {
    const doc = await makeDoc('Регламент доступа');
    await moveViaApi(doc.id, '21:head_review');
    await loginAs(users.head);
    await openDocs(doc.id);
    await ui.click($.button('Вернуть на доработку', panel));
    await ui.waitFor(`!!${panel}.querySelector('form[aria-label="Вернуть на доработку"] textarea')`, 'поле замечаний');
    assert.equal(await ui.evaluate(`!!${$.button('Вернуть автору', panel)}`), false, 'без комментария кнопка неактивна');
    assert.equal(await ui.evaluate(`!!${panel}.querySelector('form input[type=file]')`), false, 'записки файлом больше нет');
    const comment = 'Добавьте раздел о пересмотре прав раз в полгода';
    await ui.type(`${panel}.querySelector('form[aria-label="Вернуть на доработку"] textarea')`, comment);
    const req = await act('Вернуть автору', 'POST', `/api/v1/documents/${doc.id}/actions/head_return`);
    assert.equal(req.json.comment, comment);
    await ui.waitFor(`${panel}.querySelector('.panel-h .chip')?.textContent === 'Черновик' && !${panel}.querySelector('[data-testid=stage-place]')`, 'документ снова в драфте у автора');
    assert.ok((await ui.text(panel)).includes('круг 2'), 'маршрут начат заново: круг 2');

    // Автор: задача на доске, карточка ведёт на документ.
    await loginAs(users.owner);
    const taskTitle = `Доработать документ «${RUN} Регламент доступа»`;
    const drawer = await openTask(taskTitle, users.owner);
    await ui.waitFor(`${drawer}?.textContent.includes(${JSON.stringify(comment)})`, 'замечание в описании задачи');
    await ui.click(`[...${drawer}.querySelectorAll('a')].find((a) => a.textContent.startsWith('Документ #'))`);
    await ui.waitFor(`location.pathname === '/documents' && ${panel}?.querySelector('.dr-title')?.textContent === ${JSON.stringify(`${RUN} Регламент доступа`)}`, 'переход к документу из задачи');
    assert.match(await ui.text(`${panel}.querySelector('[data-testid=doc-returned]')`), new RegExp(`с этапа «Драфт».*${comment}`));

    // Автор правит драфт и отправляет снова — задача доработки закрывается сама.
    await ui.click($.button('Изменить драфт', panel));
    await ui.type(label('Что изменено', panel), 'Добавлен раздел 6');
    await act('Сохранить', 'PATCH', `/api/v1/documents/${doc.id}`);
    await ui.click($.button('Отправить на проверку начальнику ИБ', panel));
    await act('Отправить на проверку начальнику ИБ', 'POST', `/api/v1/documents/${doc.id}/actions/submit_head`);
    const tasks = (await allTasks()).filter((t) => t.title === taskTitle);
    assert.equal(tasks.length, 1);
    assert.notEqual(tasks[0].completedAt, null, 'задача доработки закрыта после отправки');
  });
});

describe('Документы: новая версия, отмена пересмотра, удаление', () => {
  it('утверждённый документ → новая версия; «Отменить пересмотр» — действует утверждённая', async () => {
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
    await ui.waitFor(`${stepState('Драфт')}?.includes('cur')`, 'новая версия — в драфте');

    // Пока версия 2 в работе, читатель видит действующую версию 1.
    await loginAs(users.legal);
    await openDocs(doc.id);
    await ui.waitFor(`${panel}?.querySelector('.panel-h .chip')?.textContent === 'Утверждён'`, 'читатель видит утверждённую версию');
    assert.match(await ui.text(`${panel}.querySelector('.row.gap-lg .mono')`), /^1 · ред\. 1\.0$/);

    await loginAs(users.owner);
    await openDocs(doc.id);
    await ui.click($.button('Отменить пересмотр', panel));
    const cf = `${panel}.querySelector('form[aria-label="Отмена пересмотра"]')`;
    assert.equal(await ui.evaluate(`!!${$.button('Отменить пересмотр', cf)}`), false, 'без комментария кнопка неактивна');
    await ui.type(`${cf}.querySelector('textarea')`, 'Изменения не понадобились');
    await act('Отменить пересмотр', 'POST', `/api/v1/documents/${doc.id}/cancel-revision`);
    await ui.waitFor(`${panel}.querySelector('.panel-h .chip')?.textContent === 'Утверждён'`, 'снова действует утверждённая');
    const items = await ui.evaluate(`[...${panel}.querySelectorAll('.hist-item')].map((h) => h.textContent)`);
    assert.ok(items.some((t) => t.startsWith('Версия 2 · ред. 2.0 · пересмотр отменён')), items.join('\n'));
    assert.ok(items.some((t) => t.startsWith('Версия 1 · ред. 1.0 · утверждена')), items.join('\n'));
  });

  it('неутверждённый документ удаляет пользователь с docs.delete; он пропадает из реестра', async () => {
    const doc = await makeDoc('Лишний драфт');
    await loginAs(users.owner);
    await openDocs(doc.id);
    await ui.waitFor(`!!${panel}?.querySelector('.dr-title')`, 'карточка');
    assert.equal(await ui.evaluate(`!!${$.button('Удалить', panel)}`), false, 'без docs.delete кнопки нет');
    await loginAs(users.head);
    await openDocs(doc.id);
    await ui.click($.button('Удалить', panel));
    await ui.type(`${panel}.querySelector('form[aria-label="Удаление"] textarea')`, 'Дубль');
    await act('Удалить документ', 'POST', `/api/v1/documents/${doc.id}/delete`);
    await ui.waitFor(`!${row(`${RUN} Лишний драфт`)}`, 'документ пропал из реестра');
    const r = await ui.evaluate(`fetch('/api/v1/documents/${doc.id}').then((x) => x.status)`);
    assert.equal(r, 404);
  });
});

describe('Документы: просмотр файлов на весь экран (1.4.0, шаг 8; файлы утверждения — 1.11.0)', () => {
  const viewer = `document.querySelector('[data-testid=file-viewer]')`;
  const viewBtn = (name) => `${panel}.querySelector('[data-view-file=${JSON.stringify(name)}]')`;
  const page = () => ui.evaluate(`${viewer}?.querySelector('[data-testid=viewer-page]')?.textContent ?? ''`);
  const canvasCss = () => ui.evaluate(`Math.round(${viewer}.querySelector('canvas').getBoundingClientRect().width)`);

  it('PDF на весь экран: ← → по страницам, «+» увеличивает, Esc закрывает только просмотрщик и возвращает фокус; .docx — сообщение и кнопки', async () => {
    const doc = await makeDoc('Просмотр файлов');
    await moveViaApi(doc.id, '24');
    const pdfName = `${RUN} Три страницы.pdf`;
    const docxName = `${RUN} Политика.docx`;
    await approvalFileViaApi(doc.id, 'pdf', pdfName, pagesPdf(['Page one', 'Page two', 'Page three']));
    const d = await approvalFileViaApi(doc.id, 'docx', docxName, tinyDocx());
    await loginAs(admin);
    await openDocs(doc.id);
    await ui.waitFor(`!!${viewBtn(pdfName)}`, 'файл утверждения в карточке');

    await ui.evaluate(`window.__escBelow = 0; document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.__escBelow++; })`);
    await ui.click(viewBtn(pdfName), 'файл PDF');
    await ui.waitFor(`!!${viewer}`, 'просмотрщик открыт');
    assert.deepEqual(await ui.evaluate(`(() => { const r = ${viewer}.getBoundingClientRect(); return [r.left, r.top, r.width === innerWidth, r.height === innerHeight]; })()`), [0, 0, true, true], 'на весь экран');
    await ui.waitFor(`${viewer}.querySelector('canvas')?.width > 0 && !${viewer}.querySelector('canvas.is-rendering')`, 'страница нарисована');
    assert.equal(await page(), '1 / 3');
    assert.ok(await ui.evaluate(`(() => { const c = ${viewer}.querySelector('canvas'); return Math.abs(c.width - c.getBoundingClientRect().width * devicePixelRatio) <= 2; })()`), 'canvas в разрешении экрана');
    await ui.press('ArrowRight');
    await ui.waitFor(`${viewer}.querySelector('[data-testid=viewer-page]')?.textContent === '2 / 3'`, 'страница 2');
    await ui.press('ArrowRight');
    await ui.press('ArrowRight');
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

    await ui.click(viewBtn(docxName), 'файл .docx');
    await ui.waitFor(`!!${viewer}?.querySelector('[data-testid=viewer-docx]')`, 'сообщение для .docx');
    assert.match(await ui.text(`${viewer}.querySelector('[data-testid=viewer-docx]')`), /Для просмотра в портале приложите PDF; \.docx открывается в OnlyOffice/);
    assert.deepEqual(await ui.evaluate(`[...${viewer}.querySelectorAll('[data-testid=viewer-docx] .btn')].map((b) => b.textContent)`), ['Скачать', 'Открыть в OnlyOffice']);
    assert.equal(await ui.evaluate(`${viewer}.querySelector('[data-testid=viewer-docx] a').getAttribute('href')`), d.current.onlyofficeUrl);
    await ui.click($.button('Закрыть', viewer));
    await ui.waitFor(`!${viewer}`, 'закрыт кнопкой');
  });

  it('Word перевода — только «Скачать»; снятый файл — «Файл недоступен», окна нет; читателю файлы рабочей версии не выдаются', async () => {
    const doc = await makeDoc('Просмотр перевода');
    await moveViaApi(doc.id, '23');
    let d = await apiAs(users.owner, 'GET', `/api/v1/documents/${doc.id}`);
    d = (await api('POST', `/api/v1/documents/${doc.id}/translations`, { version: d.version, stage: 23, language: 'Таджикский', dueDate: portalToday(), onlyofficeUrl: `${URL1}tj` })).document;
    await moveViaApi(doc.id, '24');
    const trName = `${RUN} Перевод.docx`;
    await approvalFileViaApi(doc.id, 'translation_docx', trName, tinyDocx(), d.translations[0].id);
    const tmpName = `${RUN} Временный.pdf`;
    d = await approvalFileViaApi(doc.id, 'pdf', tmpName, tinyPdf('Temp'));
    const tmpId = d.versions[0].pdf.id;

    await loginAs(admin);
    await openDocs(doc.id);
    await ui.click(viewBtn(trName), 'перевод .docx');
    await ui.waitFor(`!!${viewer}?.querySelector('[data-testid=viewer-docx]')`, 'сообщение для .docx перевода');
    assert.deepEqual(await ui.evaluate(`[...${viewer}.querySelectorAll('[data-testid=viewer-docx] .btn')].map((b) => b.textContent)`), ['Скачать'], 'у перевода нет ссылки OnlyOffice');
    await ui.press('Escape');
    await ui.waitFor(`!${viewer}`, 'закрыт');

    // Файл сняли, пока карточка открыта (без ссылок он удаляется) — 404, окна нет, сообщение.
    await ui.waitFor(`!!${viewBtn(tmpName)}`, 'файл в карточке');
    const fresh = await api('GET', `/api/v1/documents/${doc.id}`);
    await api('POST', `/api/v1/documents/${doc.id}/approval-files`, { version: fresh.version, stage: 24, slot: 'pdf', fileId: null });
    const m = ui.mark();
    await ui.click(viewBtn(tmpName), 'снятый файл');
    const req = await ui.request(m, 'GET', `/api/v1/files/${tmpId}/content`);
    assert.ok([403, 404].includes(req.status), `ответ ${req.status}`);
    await ui.waitFor(`document.querySelector('.toast.on')?.textContent === 'Файл недоступен'`, 'сообщение «Файл недоступен»');
    assert.equal(await ui.evaluate(`!!${viewer} || !!document.querySelector('[data-testid=viewer-loading]')`), false, 'окна нет');
    // Читатель документов к файлам рабочей версии доступа не имеет.
    const trFile = (await api('GET', `/api/v1/documents/${doc.id}`)).translations[0].docx.id;
    await apiAs(users.legal, 'GET', '/api/v1/auth/me');
    const denied = await ui.evaluate(`fetch('/api/v1/files/${trFile}/content').then((r) => r.status)`);
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

    await ui.waitFor(`!!document.querySelector('[data-testid=doc-type-group][data-type-id="${docType.id}"]')`, 'ветка типа документов прогона');
    const types = await ui.evaluate(`[...document.querySelectorAll('[data-testid=doc-type-group]')].map((tr) => tr.dataset.type)`);
    const policy = types.findIndex((t) => t.trim().toLowerCase() === 'политика');
    assert.ok(policy <= 0, `«Политика» — первая ветка: ${types.join(', ')}`);
    await shows([`${RUN} Анапа фильтр`, `${RUN} Ялта фильтр`], 'внутри ветки — по алфавиту');

    const caret = `document.querySelector('[data-testid=doc-type-group][data-type-id="${docType.id}"] button')`;
    await ui.click(caret, 'свернуть ветку');
    await shows([], 'ветка свёрнута');
    await ui.click(caret, 'развернуть ветку');
    await shows([`${RUN} Анапа фильтр`, `${RUN} Ялта фильтр`], 'ветка развёрнута');

    await ui.select(select('Автор'), users.staff.id);
    await shows([`${RUN} Анапа фильтр`], 'только документы автора');
    await ui.select(select('Тип документа'), docType.id);
    await shows([`${RUN} Анапа фильтр`], 'автор и тип');
    await ui.click($.button('Сбросить'), 'сбросить фильтры');
    await shows([`${RUN} Анапа фильтр`, `${RUN} Ялта фильтр`], 'фильтры сброшены');

    await ui.select(select('Срок пересмотра'), 'd365');
    await shows([], 'черновики без срока пересмотра');
    await ui.select(select('Срок пересмотра'), 'to');
    await ui.waitFor(`!!document.querySelector('[data-testid=docs-filters] input[type=date]')`, 'поле «До даты»');
    await ui.click($.button('Сбросить'), 'сбросить фильтры');

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

describe('Документы: задачи этапов маршрута (ADR-0034, маршрут 1.11.0)', () => {
  it('на проверке — задача начальнику ИБ на доске: документ, тип, место маршрута, что требуется, ссылка; одобрение закрывает её', async () => {
    const doc = await makeDoc('Положение о задачах этапов');
    await moveViaApi(doc.id, '21:head_review');
    await loginAs(users.head);
    const taskTitle = `Проверить: документ #${doc.number} «${RUN} Положение о задачах этапов»`;
    const drawer = await openTask(taskTitle, users.head);
    await ui.waitFor(`${drawer}?.textContent.includes('этап маршрута')`, 'причина «этап маршрута»');
    const text = await ui.text(drawer);
    for (const part of [`Тип: ${docType.value}`, 'Этап: Драфт — На проверке у начальника ИБ (1 из 4), версия 1', 'Что требуется: проверить версию 1 по ссылке OnlyOffice']) {
      assert.ok(text.includes(part), `в задаче: ${part}`);
    }
    await ui.click(`[...${drawer}.querySelectorAll('a')].find((a) => a.textContent.startsWith('Документ #'))`);
    await ui.waitFor(`location.pathname === '/documents' && ${panel}?.querySelector('.dr-title')?.textContent === ${JSON.stringify(`${RUN} Положение о задачах этапов`)}`, 'переход к документу из задачи');

    // Одобрение: задача начальника ИБ закрыта, дальше — у автора «Согласовать с ответственными лицами».
    await routeStep(users.head, doc.id, 'head_approve');
    const mine = (await allTasks(users.head)).filter((t) => t.title.includes(`#${doc.number} «${RUN}`));
    assert.ok(mine.some((t) => t.title === taskTitle && t.completedAt), 'задача проверки закрыта');
    assert.deepEqual(mine.filter((t) => !t.completedAt && t.assignee?.id === users.head.id).map((t) => t.title), [], 'у начальника ИБ открытых задач по документу нет');
    const owners = (await allTasks(users.owner)).filter((t) => t.title.includes(`#${doc.number} «${RUN}`) && !t.completedAt).map((t) => t.title);
    assert.deepEqual(owners, [`Согласовать с ответственными лицами: документ #${doc.number} «${RUN} Положение о задачах этапов»`]);
  });
});

describe('Документы: «В работе» и «Утверждённые» (1.11.0)', () => {
  it('подменю: утверждённые — реестр с пересмотром и «на пересмотре», выгрузка в Excel; в работе — по этапам', async () => {
    const signed = await makeDoc('Реестр утверждённый');
    await signAllViaApi(signed.id);
    const revised = await makeDoc('Реестр на пересмотре');
    await signAllViaApi(revised.id);
    let d = await apiAs(users.owner, 'GET', `/api/v1/documents/${revised.id}`);
    await api('POST', `/api/v1/documents/${revised.id}/revise`, { version: d.version, edition: '2.0' });
    const draft = await makeDoc('Реестр черновик');
    await moveViaApi(draft.id, '21:head_review');

    await loginAs(admin);
    await ui.goto(`/documents/approved?n=${++navSeq}`);
    await ui.waitFor(`!!document.querySelector('.docs-tbl')`, 'реестр утверждённых');
    await ui.waitFor(`document.querySelector('[role=tablist][aria-label="Подменю документов"] [aria-selected=true]')?.textContent === 'Утверждённые'`, 'вкладка «Утверждённые»');
    await ui.waitFor(`!!${row(`${RUN} Реестр утверждённый`)} && !!${row(`${RUN} Реестр на пересмотре`)}`, 'утверждённые в реестре');
    assert.equal(await ui.evaluate(`!!${row(`${RUN} Реестр черновик`)}`), false, 'черновика среди утверждённых нет');
    assert.deepEqual(await ui.evaluate(`[...document.querySelectorAll('.docs-tbl thead th')].map((t) => t.textContent)`), ['№', 'Документ', 'Владелец', 'Действующая версия', 'Утверждён', 'Пересмотр до', 'Механизмов контроля', '']);
    assert.match(await ui.text(`${row(`${RUN} Реестр утверждённый`)}.querySelector('[data-testid=review-due]')`), new RegExp(`${ru(plusYear()).replace(/\./g, '\\.')}через \\d+ дн\\.`));
    assert.equal(await ui.evaluate(`!!${row(`${RUN} Реестр на пересмотре`)}.querySelector('[data-testid=on-review]')`), true, 'отметка «на пересмотре»');
    await ui.click(`[...document.querySelectorAll('.filters button')].find((b) => b.textContent === 'На пересмотре')`, 'фильтр «На пересмотре»');
    await ui.waitFor(`!${row(`${RUN} Реестр утверждённый`)} && !!${row(`${RUN} Реестр на пересмотре`)}`, 'только на пересмотре');
    const m = ui.mark();
    await ui.click($.button('Выгрузить в Excel'), '«Выгрузить в Excel»');
    const x = await ui.request(m, 'GET', '/api/v1/documents/approved.xlsx');
    assert.equal(x.status, 200);
    assert.ok(x.url.includes('onReview=true'), x.url);
    await ui.waitFor(`document.querySelector('.toast.on')?.textContent.startsWith('Выгружено: Утверждённые документы')`, 'уведомление о выгрузке');

    // «В работе»: чипы этапов; документ на проверке — в «Драфт».
    await ui.click(`document.querySelector('[role=tablist][aria-label="Подменю документов"] a[href="/documents/work"]')`, 'вкладка «В работе»');
    await ui.waitFor(`location.pathname === '/documents/work' && !!${row(`${RUN} Реестр черновик`)}`, 'черновик в работе');
    await ui.waitFor(`!!${row(`${RUN} Реестр на пересмотре`)}`, 'пересмотр — тоже в работе');
    assert.equal(await ui.evaluate(`!!${row(`${RUN} Реестр утверждённый`)}`), false, 'утверждённый без рабочей версии — не в работе');
    await ui.click(`[...document.querySelectorAll('.filters button')].find((b) => b.textContent === 'Согласование')`, 'этап «Согласование»');
    await ui.waitFor(`!${row(`${RUN} Реестр черновик`)}`, 'фильтр этапа');
    d = await api('GET', `/api/v1/documents/${draft.id}`);
    assert.equal(d.working.stage, 21);
  });
});

describe('Документы: механизмы контроля (1.11.0)', () => {
  it('у утверждённого: владелец добавляет, правит и отключает; сотрудник ИБ только читает; в реестре — число активных', async () => {
    const doc = await makeDoc('Контроль паролей');
    await signAllViaApi(doc.id);
    await loginAs(users.owner);
    await openDocs(doc.id);
    await ui.click(`[...${panel}.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Механизмы контроля')`, 'вкладка «Механизмы контроля»');
    const box = `${panel}.querySelector('[data-testid=doc-controls]')`;
    await ui.waitFor(`${box}?.textContent.includes('Механизмов контроля пока нет')`, 'пустой список');
    await ui.click($.button('Добавить механизм контроля', panel));
    const form = `${panel}.querySelector('form[aria-label="Новый механизм контроля"]')`;
    await ui.type(label('Пункт или раздел документа', form), 'п. 4.2');
    await ui.type(`${form}.querySelector('input[aria-label="Новый механизм: требование"]')`, 'Пароли — не короче 12 символов');
    await ui.type(label('Механизм контроля со стороны ИБ', form), 'Проверка групповой политики AD раз в квартал');
    await ui.type(label('Ожидаемое доказательство', form), 'Скриншот GPO');
    let req = await act('Добавить', 'POST', `/api/v1/documents/${doc.id}/controls`);
    assert.equal(req.json.requirement, 'Пароли — не короче 12 символов');
    const item = `${box}.querySelector('[data-control="1"]')`;
    await ui.waitFor(`${item}?.textContent.includes('1. Пароли — не короче 12 символов') && ${item}.textContent.includes('Доказательство: Скриншот GPO')`, 'механизм в списке');
    await ui.click($.button('Изменить', item));
    const ef = `${panel}.querySelector('form[aria-label="Механизм контроля"]')`;
    await ui.type(label('Способ проверки', ef), 'Отчёт RSoP');
    req = await act('Сохранить', 'PATCH', '/controls/');
    assert.equal(req.json.version, 1);
    await ui.waitFor(`${item}?.textContent.includes('Способ проверки: Отчёт RSoP')`, 'изменение в списке');

    // В реестре утверждённых — 1 активный механизм.
    await ui.goto(`/documents/approved?n=${++navSeq}`);
    await ui.waitFor(`${row(`${RUN} Контроль паролей`)}?.querySelector('[data-testid=controls-count]')?.textContent === '1'`, 'число механизмов в реестре');

    // Сотрудник ИБ видит, но не меняет.
    await loginAs(users.staff);
    await openDocs(doc.id);
    await ui.click(`[...${panel}.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Механизмы контроля')`, 'вкладка у сотрудника');
    await ui.waitFor(`${box}?.textContent.includes('Пароли — не короче 12 символов')`, 'сотрудник видит механизм');
    assert.equal(await ui.evaluate(`!!${$.button('Добавить механизм контроля', panel)} || !!${$.button('Изменить', box)}`), false, 'у сотрудника кнопок нет');

    // Владелец отключает механизм.
    await loginAs(users.owner);
    await openDocs(doc.id);
    await ui.click(`[...${panel}.querySelectorAll('[role=tab]')].find((t) => t.textContent === 'Механизмы контроля')`, 'вкладка');
    await ui.waitFor(`!!${$.button('Отключить', `${box}.querySelector('[data-control="1"]')`)}`, 'кнопка «Отключить»');
    await act('Отключить', 'PATCH', '/controls/');
    await ui.waitFor(`${box}.querySelector('[data-control="1"]')?.textContent.includes('отключён')`, 'механизм отключён');
    // Читатель вкладки не видит.
    await loginAs(users.legal);
    await openDocs(doc.id);
    await ui.waitFor(`!!${panel}?.querySelector('.dr-title')`, 'карточка у читателя');
    assert.equal(await ui.evaluate(`!!${panel}.querySelector('[role=tablist][aria-label="Разделы документа"]')`), false, 'у читателя вкладок нет');
  });
});
