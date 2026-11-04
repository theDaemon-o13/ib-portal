// Сквозной тест справочника «Ответственные лица» (релиз 1.6.7): завести человека в настройках → выбрать его в карточке
// документа → ФИО и должность в карточке; повтор того же человека не выбирается; «Ввести вручную»; пункта настроек
// нет у пользователя без settings.manage. Имена вымышленные, с меткой прогона.
//
//   npm run test:e2e
//
// В конце: документ прогона — в архив, запись справочника — отключить (удаления нет), пользователь — отключить.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { $, launchBrowser, portalToday } from './browser.mjs';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const LOGIN = process.env.E2E_LOGIN;
const PASSWORD = process.env.E2E_PASSWORD;
const RUN = `E2E-${Date.now().toString(36)}`;
const PERSON = { fullName: `Иванов И.И. ${RUN}`, position: 'Технический директор' };
const OTHER = { fullName: `Петров П.П. ${RUN}`, position: 'Главный бухгалтер' };

let ui;
let navSeq = 0;
let me;
let docId;
let staff;
const panel = `document.querySelector('.dash .panel.w4')`;
const dirPanel = `document.querySelector('section[aria-label="Ответственные лица"]')`;
const label = (text, within) => `[...(${within}).querySelectorAll('label')].find((l) => l.firstChild?.textContent?.trim() === ${JSON.stringify(text)})?.querySelector('input, select, textarea')`;
const regItem = (title) => `[...document.querySelectorAll('.reglist button')].find((b) => b.querySelector('b')?.textContent === ${JSON.stringify(title)})`;

async function api(method, path, body) {
  const res = await ui.evaluate(`fetch(${JSON.stringify(path)}, ${JSON.stringify(body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })})
    .then(async (r) => ({ status: r.status, text: await r.text() }))`);
  assert.ok(res.status >= 200 && res.status < 300, `${method} ${path} → ${res.status} ${res.text}`);
  return res.text ? JSON.parse(res.text) : null;
}

async function loginAs(login, password) {
  await api('POST', '/api/v1/auth/logout').catch(() => undefined);
  await ui.goto(`/login?n=${++navSeq}`);
  await ui.type(`document.querySelector('input[name=username]')`, login);
  await ui.type(`document.querySelector('input[name=password]')`, password);
  await ui.click(`document.querySelector('form button[type=submit]')`);
  await ui.waitFor(`location.pathname !== '/login'`, `вход ${login}`);
  if (await ui.evaluate(`location.pathname === '/change-password'`)) {
    const next = `Спр-${RUN.slice(4)}-Zq9!`;
    await ui.type(`document.querySelector('input[autocomplete=current-password]')`, password);
    await ui.type(`document.querySelectorAll('input[autocomplete=new-password]')[0]`, next);
    await ui.type(`document.querySelectorAll('input[autocomplete=new-password]')[1]`, next);
    await ui.click($.button('Сменить пароль'));
    await ui.waitFor(`location.pathname !== '/change-password'`, `смена пароля ${login}`);
    return next;
  }
  return password;
}

/** Срок ответа — поле даты: значение через нативный сеттер, как в documents.e2e.mjs. */
async function setDate(input, value) {
  await ui.evaluate(`(() => { const el = ${input};
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
}

before(async () => {
  assert.ok(LOGIN && PASSWORD, 'Задайте E2E_LOGIN и E2E_PASSWORD (пользователь с ролью «Супер-администратор»)');
  ui = await launchBrowser({ baseUrl: BASE });
  await loginAs(LOGIN, PASSWORD);
  me = (await api('GET', '/api/v1/auth/me')).user;
  const docType = (await api('GET', '/api/v1/catalogs/document_types/items')).items[0];
  assert.ok(docType, 'в справочнике «Типы документов» есть значение');
  docId = (await api('POST', '/api/v1/documents', {
    title: `${RUN} Положение о доступе`, typeId: docType.id, ownerId: me.id,
    onlyofficeUrl: 'https://office.example.local/products/files/doceditor.aspx?fileid=e2e-party', edition: '1.0',
  })).document.id;
  const roles = (await api('GET', '/api/v1/roles')).items;
  const r = await api('POST', '/api/v1/users', {
    login: `${RUN.toLowerCase()}.staff`, fullName: `Сотрудник Справочника ${RUN}`, roleIds: [roles.find((x) => x.code === 'ib_staff').id],
  });
  staff = { id: r.user.id, login: r.user.login, password: r.temporaryPassword };
});

after(async () => {
  if (!ui) return;
  try {
    await loginAs(LOGIN, PASSWORD).catch(() => undefined);
    const d = await api('GET', `/api/v1/documents/${docId}`).catch(() => null);
    if (d) await api('POST', `/api/v1/documents/${docId}/archive`, { version: d.version }).catch(() => undefined);
    const dir = await api('GET', '/api/v1/settings/party-directory').catch(() => ({ items: [] }));
    for (const p of dir.items.filter((x) => x.fullName.includes(RUN) && x.active)) {
      await api('PATCH', `/api/v1/settings/party-directory/${p.id}`, { version: p.version, active: false }).catch(() => undefined);
    }
    const u = (await api('GET', '/api/v1/users').catch(() => ({ items: [] }))).items.find((x) => x.id === staff?.id);
    if (u?.isActive) await api('POST', `/api/v1/users/${u.id}/disable`, { version: u.version }).catch(() => undefined);
    for (const t of (await api('GET', '/api/v1/tasks?archived=false').catch(() => ({ items: [] }))).items) {
      if (t.title.includes(RUN)) await api('POST', `/api/v1/tasks/${t.id}/archive`, { version: t.version }).catch(() => undefined);
    }
  } finally {
    ui.close();
  }
});

describe('Справочник «Ответственные лица» (1.6.7)', () => {
  it('завести в настройках → выбрать в документе → ФИО и должность в карточке; повтор не выбирается; «Ввести вручную»', async () => {
    // Настройки → Справочники → «Ответственные лица»: добавить.
    await ui.goto(`/settings/catalogs?n=${++navSeq}`);
    await ui.click(regItem('Ответственные лица'), 'пункт «Ответственные лица»');
    await ui.waitFor(`!!${dirPanel}`, 'раздел «Ответственные лица»');
    const addForm = `${dirPanel}.querySelector('form[aria-label="Добавить ответственное лицо в справочник"]')`;
    await ui.type(label('ФИО', addForm), PERSON.fullName);
    await ui.type(label('Подразделение или должность', addForm), PERSON.position);
    let m = ui.mark();
    await ui.click($.button('Добавить', addForm));
    const created = await ui.request(m, 'POST', '/api/v1/settings/party-directory');
    assert.equal(created.status, 200, created.body);
    await ui.waitFor(`!!${dirPanel}.querySelector(${JSON.stringify(`tr[data-person="${PERSON.fullName}"]`)})`, 'запись в таблице справочника');
    // Однофамилец — предупреждение, не запрет.
    await ui.type(label('ФИО', addForm), PERSON.fullName);
    await ui.waitFor(`!!${addForm}.querySelector('[data-testid=same-name]')`, 'предупреждение «Уже есть»');
    await ui.evaluate(`(() => { const el = ${label('ФИО', addForm)}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);

    // Карточка документа (этап «Драфт»): начать вводить ФИО → выбрать из списка.
    await ui.goto(`/documents?n=${++navSeq}&doc=${docId}`);
    await ui.click($.button('Добавить ответственное лицо', panel));
    const pf = `${panel}.querySelector('form[aria-label="Ответственное лицо"]')`;
    await ui.type(label('ФИО', pf), RUN);
    const option = (name) => `document.querySelector(${JSON.stringify(`[role=listbox] [role=option][data-person="${name}"]`)})`;
    await ui.waitFor(`!!${option(PERSON.fullName)}`, 'человек из справочника в списке');
    await ui.click(option(PERSON.fullName), 'выбор из списка');
    assert.equal(await ui.evaluate(`${label('ФИО', pf)}.value`), PERSON.fullName);
    assert.equal(await ui.evaluate(`${label('Подразделение или должность', pf)}.value`), PERSON.position, 'должность заполнилась из справочника');
    await setDate(label('Срок ответа', pf), portalToday(7));
    m = ui.mark();
    await ui.click($.button('Добавить', pf));
    const added = await ui.request(m, 'POST', `/api/v1/documents/${docId}/parties`);
    assert.equal(added.json.fullName, PERSON.fullName);
    assert.equal(added.json.department, PERSON.position);
    const party = `${panel}.querySelector(${JSON.stringify(`[data-party="${PERSON.fullName}"]`)})`;
    await ui.waitFor(`${party}?.textContent.includes(${JSON.stringify(PERSON.position)})`, 'ФИО и должность в карточке документа');

    // Тот же человек второй раз: в списке «уже добавлен(а)», не выбирается.
    await ui.click($.button('Добавить ответственное лицо', panel));
    await ui.type(label('ФИО', pf), RUN);
    await ui.waitFor(`${option(PERSON.fullName)}?.getAttribute('aria-disabled') === 'true'`, 'уже добавленный — недоступен для выбора');
    assert.match(await ui.text(option(PERSON.fullName)), /уже добавлен\(а\)/);

    // «Ввести вручную»: список закрывается, оба поля — как раньше.
    await ui.click(`[...document.querySelectorAll('[role=listbox] [role=option]')].find((o) => o.textContent === 'Ввести вручную')`, '«Ввести вручную»');
    await ui.waitFor(`!document.querySelector('[role=listbox]')`, 'список закрыт');
    await ui.evaluate(`(() => { const el = ${label('ФИО', pf)}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await ui.type(label('ФИО', pf), OTHER.fullName);
    assert.equal(await ui.evaluate(`!!document.querySelector('[role=listbox]')`), false, 'в ручном режиме список не открывается');
    await ui.type(label('Подразделение или должность', pf), OTHER.position);
    await setDate(label('Срок ответа', pf), portalToday(7));
    m = ui.mark();
    await ui.click($.button('Добавить', pf));
    const manual = await ui.request(m, 'POST', `/api/v1/documents/${docId}/parties`);
    assert.equal(manual.json.fullName, OTHER.fullName);
    await ui.waitFor(`!!${panel}.querySelector(${JSON.stringify(`[data-party="${OTHER.fullName}"]`)})`, 'вручную введённое лицо в карточке');
  });

  it('без settings.manage пункта «Ответственные лица» в настройках нет (и по прямой ссылке)', async () => {
    staff.password = await loginAs(staff.login, staff.password);
    await ui.goto(`/settings/catalogs?n=${++navSeq}`);
    await ui.waitFor(`document.querySelectorAll('.reglist button').length > 0`, 'список справочников');
    assert.equal(await ui.evaluate(`!!${regItem('Ответственные лица')}`), false, 'пункта нет');
    await ui.goto(`/settings/catalogs?c=document_parties&n=${++navSeq}`);
    await ui.waitFor(`document.querySelectorAll('.reglist button').length > 0`, 'список справочников');
    assert.equal(await ui.evaluate(`!!${dirPanel}`), false, 'раздел не открывается по ссылке');
    const res = await ui.evaluate(`fetch('/api/v1/settings/party-directory').then((r) => r.status)`);
    assert.equal(res, 403, 'API справочника без права — 403');
  });
});
