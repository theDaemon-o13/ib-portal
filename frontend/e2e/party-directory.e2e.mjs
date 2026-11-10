// Сквозной тест справочника «Ответственные лица» (релиз 1.6.7): завести человека в настройках → выбрать его в карточке
// документа (1.13.5 — список с отметками) → ФИО и должность в карточке; повтор того же человека не выбирается; ввод вручную; пункта настроек
// нет у пользователя без settings.manage. Имена вымышленные, с меткой прогона.
//
//   npm run test:e2e
//
// В конце: документ прогона — в архив, запись справочника — отключить (удаления нет), пользователь — отключить.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { $, launchBrowser } from './browser.mjs';

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
  it('завести в настройках → выбрать в документе → ФИО и должность в карточке; повтор не выбирается; ввод вручную (1.13.5)', async () => {
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

    // Карточка документа (этап «Драфт»), форма 1.13.5 «Добавить ответственных лиц»: поиск в списке → отметить.
    await ui.goto(`/documents?n=${++navSeq}&doc=${docId}`);
    await ui.click($.button('Добавить ответственных лиц', panel));
    const pf = `${panel}.querySelector('form[aria-label="Добавить ответственных лиц"]')`;
    const pick = `${pf}?.querySelector('[data-testid=party-pick]')`;
    const pop = `document.querySelector('[data-ms-pop]')`;
    const option = (name) => `(${pop} ? [...${pop}.querySelectorAll('[role=option]')].find((o) => o.querySelector('.sel-ol')?.textContent === ${JSON.stringify(name)}) : null)`;
    await ui.waitFor(`!!${pick}`, 'выбор из справочника');
    await ui.click(pick, '«Выбрать из справочника»');
    await ui.type(`${pop}.querySelector('input[type=search]')`, RUN);
    await ui.waitFor(`!!${option(PERSON.fullName)}`, 'человек из справочника в списке');
    assert.match(await ui.text(option(PERSON.fullName)), new RegExp(PERSON.position), 'должность — второй строкой');
    await ui.click(option(PERSON.fullName), 'отметить в списке');
    await ui.click(`${pop}.querySelector('.ms-foot button')`, '«Готово»');
    await ui.waitFor(`!${pop}`, 'список закрыт');
    assert.equal(await ui.evaluate(`${pf}.querySelector('.ms-chip')?.dataset.chip`), PERSON.fullName, 'чип выбранного');
    // В драфте (1.11.0) срок — днями от перехода на «Согласование», по умолчанию 7.
    assert.equal(await ui.evaluate(`${label('Срок ответа, дней', pf)}.value`), '7');
    m = ui.mark();
    await ui.click($.button('Добавить (1)', pf));
    const added = await ui.request(m, 'POST', `/api/v1/documents/${docId}/parties/batch`);
    assert.deepEqual([added.json.dueDays, added.json.people], [7, [{ fullName: PERSON.fullName, department: PERSON.position }]], 'ФИО и должность — текстом из справочника');
    const party = `${panel}.querySelector(${JSON.stringify(`[data-party="${PERSON.fullName}"]`)})`;
    await ui.waitFor(`${party}?.textContent.includes(${JSON.stringify(PERSON.position)})`, 'ФИО и должность в карточке документа');

    // Тот же человек второй раз: в списке «уже добавлен», не отмечается.
    await ui.click($.button('Добавить ответственных лиц', panel));
    await ui.click(pick, '«Выбрать из справочника»');
    await ui.type(`${pop}.querySelector('input[type=search]')`, RUN);
    await ui.waitFor(`${option(PERSON.fullName)}?.getAttribute('aria-disabled') === 'true'`, 'уже добавленный — недоступен для выбора');
    assert.match(await ui.text(option(PERSON.fullName)), /уже добавлен/);
    await ui.press('Escape');
    await ui.waitFor(`!${pop}`, 'Esc — список закрыт');

    // Вручную: строка ФИО + должность; тот же человек вручную — ошибка строки, кнопка неактивна.
    await ui.click($.button('+ Добавить вручную', pf), '«+ Добавить вручную»');
    const lastRow = `[...${pf}.querySelectorAll('.party-row')].at(-1)`;
    await ui.type(label('ФИО', lastRow), PERSON.fullName);
    await ui.type(label('Подразделение или должность', lastRow), PERSON.position);
    await ui.waitFor(`${lastRow}?.querySelector('[role=alert]')?.textContent === 'Уже добавлен(а) в документ'`, 'повтор вручную подсвечен');
    assert.equal(await ui.evaluate(`[...${pf}.querySelectorAll('button[type=submit]')].some((b) => !b.disabled)`), false, 'с ошибкой строки кнопка неактивна');
    await ui.click(`${lastRow}.querySelector('button[aria-label^="Удалить строку"]')`, 'удалить строку');
    await ui.click($.button('+ Добавить вручную', pf), '«+ Добавить вручную»');
    await ui.type(label('ФИО', lastRow), OTHER.fullName);
    await ui.type(label('Подразделение или должность', lastRow), OTHER.position);
    m = ui.mark();
    await ui.click($.button('Добавить (1)', pf));
    const manual = await ui.request(m, 'POST', `/api/v1/documents/${docId}/parties/batch`);
    assert.deepEqual(manual.json.people, [{ fullName: OTHER.fullName, department: OTHER.position }]);
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

describe('Почта ответственных лиц и копирование полей (1.13.6)', () => {
  it('лицо с почтой в справочнике → в документ → скопировать ФИО, почту и должность по отдельности → «Копировать все ФИО» для трёх', async () => {
    await loginAs(LOGIN, PASSWORD);
    await ui.allowClipboard();
    const MAILED = { fullName: `Сидорова С.С. ${RUN}`, position: 'Начальник службы поддержки', email: `sidorova.${RUN.toLowerCase()}@example.com` };

    // Справочник: почта — необязательное поле; вводится с заглавными и пробелами — сохраняется в нижнем регистре.
    await ui.goto(`/settings/catalogs?n=${++navSeq}`);
    await ui.click(regItem('Ответственные лица'), 'пункт «Ответственные лица»');
    await ui.waitFor(`!!${dirPanel}`, 'раздел «Ответственные лица»');
    assert.deepEqual(await ui.evaluate(`[...${dirPanel}.querySelectorAll('thead th')].map((t) => t.textContent)`), ['ФИО', 'Подразделение или должность', 'Почта', 'Активно', '']);
    const addForm = `${dirPanel}.querySelector('form[aria-label="Добавить ответственное лицо в справочник"]')`;
    await ui.type(label('ФИО', addForm), MAILED.fullName);
    await ui.type(label('Подразделение или должность', addForm), MAILED.position);
    await ui.type(label('Почта', addForm), 'не почта');
    await ui.waitFor(`${addForm}.querySelector('[role=alert]')?.textContent.includes('ivanov@example.com')`, 'неверная почта подсвечена');
    assert.equal(await ui.evaluate(`!!${$.button('Добавить', addForm)}`), false, 'с неверной почтой кнопка неактивна');
    await ui.evaluate(`(() => { const el = ${label('Почта', addForm)}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await ui.type(label('Почта', addForm), ` ${MAILED.email.toUpperCase()} `);
    let m = ui.mark();
    await ui.click($.button('Добавить', addForm));
    const created = await ui.request(m, 'POST', '/api/v1/settings/party-directory');
    assert.equal((await ui.response(created)).item.email, MAILED.email, 'почта — в нижнем регистре, без пробелов');
    const row = `${dirPanel}.querySelector(${JSON.stringify(`tr[data-person="${MAILED.fullName}"]`)})`;
    await ui.waitFor(`${row}?.textContent.includes(${JSON.stringify(MAILED.email)})`, 'почта в таблице');
    // Поиск — и по почте.
    await ui.type(`${dirPanel}.querySelector('input[type=search]')`, `sidorova.${RUN.toLowerCase()}`);
    await ui.waitFor(`${dirPanel}.querySelectorAll('tbody tr[data-person]').length === 1 && !!${row}`, 'найдено по почте');
    // Копирование в таблице справочника.
    await ui.clearClipboard();
    await ui.click(`${row}.querySelector(${JSON.stringify(`button[aria-label="Копировать почту ${MAILED.email}"]`)})`, 'копировать почту в справочнике');
    await ui.waitFor(`document.querySelector('.toast.on')?.textContent === 'Скопировано'`, '«Скопировано»');
    assert.equal(await ui.clipboard(), MAILED.email);

    // Документ: выбрать из справочника (почта видна под ФИО) + двое вручную, у одного почта.
    const docType = (await api('GET', '/api/v1/catalogs/document_types/items')).items[0];
    const doc = (await api('POST', '/api/v1/documents', {
      title: `${RUN} Политика тестовая (почта)`, typeId: docType.id, ownerId: (await api('GET', '/api/v1/auth/me')).user.id,
      onlyofficeUrl: 'https://office.example.local/products/files/doceditor.aspx?fileid=e2e-mail', edition: '1.0',
    })).document;
    try {
      await ui.goto(`/documents?n=${++navSeq}&doc=${doc.id}`);
      await ui.click($.button('Добавить ответственных лиц', panel));
      const pf = `${panel}.querySelector('form[aria-label="Добавить ответственных лиц"]')`;
      await ui.waitFor(`!!${pf}?.querySelector('[data-testid=party-pick]')`, 'выбор из справочника');
      await ui.click(`${pf}.querySelector('[data-testid=party-pick]')`, '«Выбрать из справочника»');
      const pop = `document.querySelector('[data-ms-pop]')`;
      await ui.type(`${pop}.querySelector('input[type=search]')`, `sidorova.${RUN.toLowerCase()}@`);
      const opt = `(${pop} ? [...${pop}.querySelectorAll('[role=option]')].find((o) => o.querySelector('.sel-ol')?.textContent === ${JSON.stringify(MAILED.fullName)}) : null)`;
      await ui.waitFor(`${opt}?.textContent.includes(${JSON.stringify(MAILED.email)})`, 'найден по почте, почта — под ФИО');
      await ui.click(opt, 'отметить');
      await ui.press('Enter');
      const manual = [
        { fullName: `Иванов И.И. ${RUN}`, department: 'Технический директор', email: `ivanov.${RUN.toLowerCase()}@example.com` },
        { fullName: `Петров П.П. ${RUN}`, department: 'Главный бухгалтер', email: '' },
      ];
      for (const p of manual) {
        await ui.click($.button('+ Добавить вручную', pf), '«+ Добавить вручную»');
        const r = `[...${pf}.querySelectorAll('.party-row')].at(-1)`;
        await ui.type(label('ФИО', r), p.fullName);
        await ui.type(label('Подразделение или должность', r), p.department);
        if (p.email) await ui.type(label('Почта', r), p.email);
      }
      m = ui.mark();
      await ui.click($.button('Добавить (3)', pf));
      const added = await ui.request(m, 'POST', `/api/v1/documents/${doc.id}/parties/batch`);
      assert.deepEqual(added.json.people, [{ fullName: MAILED.fullName, department: MAILED.position, email: MAILED.email }, manual[0], { fullName: manual[1].fullName, department: manual[1].department }]);

      // Карточка: у каждого поля — своя кнопка; копируется ровно значение.
      const party = `${panel}.querySelector(${JSON.stringify(`[data-party="${MAILED.fullName}"]`)})`;
      await ui.waitFor(`!!${party}?.querySelector('[data-field=email]')`, 'почта лица в карточке');
      for (const [what, value] of [['ФИО', MAILED.fullName], ['почту', MAILED.email], ['должность', MAILED.position]]) {
        await ui.clearClipboard();
        await ui.click(`${party}.querySelector(${JSON.stringify(`button[aria-label="Копировать ${what} ${value}"]`)})`, `копировать ${what}`);
        await ui.waitFor(`${party}.querySelector(${JSON.stringify(`button[data-copy="${what}"]`)})?.classList.contains('done')`, `«Скопировано» у ${what}`);
        assert.equal(await ui.clipboard(), value, `в буфере — ${what}`);
      }
      // С клавиатуры: Tab до кнопки и Enter.
      await ui.clearClipboard();
      await ui.evaluate(`${party}.querySelector('button[data-copy="ФИО"]').focus()`);
      await ui.press('Enter');
      await ui.waitFor(`navigator.clipboard.readText().then((t) => t === ${JSON.stringify(MAILED.fullName)})`, 'Enter на кнопке копирует');

      // «Копировать все ФИО» — по строке на значение, в порядке списка; «Копировать все почты» — без пустых.
      await ui.clearClipboard();
      await ui.click($.button('Копировать все ФИО', panel));
      await ui.waitFor(`document.querySelector('.toast.on')?.textContent === 'Скопировано: 3'`, '«Скопировано: 3»');
      assert.equal(await ui.clipboard(), [MAILED.fullName, manual[0].fullName, manual[1].fullName].join('\n'));
      await ui.click($.button('Копировать все почты', panel));
      await ui.waitFor(`document.querySelector('.toast.on')?.textContent === 'Скопировано: 2'`, '«Скопировано: 2» — пустая почта пропущена');
      assert.equal(await ui.clipboard(), [MAILED.email, manual[0].email].join('\n'));

      // Автор дописывает почту лицу без почты — сохраняется и копируется.
      const petrov = `${panel}.querySelector(${JSON.stringify(`[data-party="${manual[1].fullName}"]`)})`;
      await ui.click($.button('Почта', petrov));
      const ef = `${panel}.querySelector('form[aria-label="Почта лица"]')`;
      await ui.type(label('Почта', ef), `petrov.${RUN.toLowerCase()}@example.com`);
      m = ui.mark();
      await ui.click($.button('Сохранить', ef));
      const patched = await ui.request(m, 'PATCH', `/api/v1/documents/${doc.id}/parties/`);
      assert.equal(patched.status, 200, patched.body);
      await ui.waitFor(`${petrov}?.querySelector('[data-field=email]')?.textContent === ${JSON.stringify(`petrov.${RUN.toLowerCase()}@example.com`)}`, 'почта дописана');
    } finally {
      const d = await api('GET', `/api/v1/documents/${doc.id}`).catch(() => null);
      if (d) await api('POST', `/api/v1/documents/${doc.id}/archive`, { version: d.version }).catch(() => undefined);
    }
  });
});
