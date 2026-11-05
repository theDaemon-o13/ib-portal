// Сквозной тест раздела «Настройки» тем же путём, что и браузер пользователя:
// Chrome → Vite (прокси /api) → backend → PostgreSQL, с cookie сессии и заголовком Origin,
// настоящими щелчками мыши и вводом с клавиатуры.
//
//   npm run test:e2e   (логин и пароль — из frontend/.env.e2e или E2E_LOGIN / E2E_PASSWORD)
//
// Нужно запущенное dev-окружение (deploy/docker-compose.dev.yml) и пользователь с ролью
// «Супер-администратор». Тест создаёт свои значения с пометкой «E2E» и удаляет их; созданный им
// пользователь e2e.* остаётся отключённым (пользователи не удаляются), записи журнала аудита — тоже.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { $, launchBrowser, sleep } from './browser.mjs';
import { restoreIbHead, saveIbHead } from './ib-head.mjs';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const LOGIN = process.env.E2E_LOGIN;
const PASSWORD = process.env.E2E_PASSWORD;
const RUN = Date.now().toString(36);
const tag = (s) => `${s} E2E-${RUN}`;

let ui;

/**
 * Правка в строке таблицы: щелчок «Изменить» не должен ничего отправлять (регрессия: React
 * переиспользовал нажатую кнопку как «Сохранить» и форма уходила сразу), затем правка и «Сохранить».
 */
async function editRow(rowText, fill, method, urlPart) {
  const m0 = ui.mark();
  await ui.click($.button('Изменить', $.row(rowText)), `«Изменить» в строке «${rowText}»`);
  await ui.waitFor(`!!${$.editing}`, 'строка правки');
  await sleep(400);
  assert.deepEqual(ui.requestsSince(m0).filter((r) => r.method !== 'GET'), [], 'щелчок «Изменить» не должен отправлять запросы');
  assert.ok(await ui.evaluate(`!!${$.editing}`), 'строка правки должна остаться открытой');
  await fill();
  const m1 = ui.mark();
  await ui.click($.button('Сохранить', $.editing), '«Сохранить»');
  const req = await ui.request(m1, method, urlPart);
  assert.equal(req.status, 200, `${method} ${urlPart}: ${req.status}`);
  await ui.waitFor(`!${$.editing}`, 'строка правки закрылась');
  return req;
}

/** Список пользователей — страницами по 50 (по логину): листаем «Показать ещё», пока не появится строка. */
async function revealRow(text) {
  for (let i = 0; i < 40; i++) {
    if (await ui.evaluate(`!!${$.row(text)}`)) return;
    const more = $.button('Показать ещё');
    await ui.waitFor(`!!${$.row(text)} || (${more} && !${more}.disabled)`, `строка «${text}» или «Показать ещё»`);
    if (await ui.evaluate(`!!${$.row(text)}`)) return;
    await ui.click(more, '«Показать ещё»');
  }
  throw new Error(`строки «${text}» нет и после 40 страниц`);
}

async function action(label, within, method, urlPart, expectStatus = 200) {
  const m = ui.mark();
  await ui.click($.button(label, within), `«${label}»`);
  const req = await ui.request(m, method, urlPart);
  assert.equal(req.status, expectStatus, `${label}: ${method} ${urlPart} → ${req.status}`);
  return req;
}

const setNative = (expr, value) =>
  ui.evaluate(`(() => { const el = ${expr};
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true })); })()`);

before(async () => {
  assert.ok(LOGIN && PASSWORD, 'Задайте E2E_LOGIN и E2E_PASSWORD (пользователь с ролью «Супер-администратор»)');
  ui = await launchBrowser({ baseUrl: BASE });
  await ui.goto('/login');
  await ui.type(`document.querySelector('input[name=username]')`, LOGIN);
  await ui.type(`document.querySelector('input[name=password]')`, PASSWORD);
  await ui.click(`document.querySelector('form button[type=submit]')`);
  await ui.waitFor(`location.pathname !== '/login'`, 'вход');
  assert.notEqual(await ui.evaluate('location.pathname'), '/change-password', 'у пользователя e2e не должно быть обязательной смены пароля');
});

/**
 * Уборка после прогона: всё, что создано с пометкой этого прогона, архивируется (или отключается),
 * даже если тест упал на середине. Удаление — только там, где архива нет (запись календаря, пустая роль).
 */
async function cleanup() {
  const mark = `E2E-${RUN}`;
  await ui.evaluate(`(async () => {
    const mark = ${JSON.stringify(mark)};
    const j = (r) => r.json();
    const post = (url, body, method = 'POST') => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const cats = (await j(await fetch('/api/v1/catalogs'))).items;
    for (const c of cats) {
      for (const i of (await j(await fetch('/api/v1/catalogs/' + c.code + '/items?includeArchived=true'))).items) {
        if (!i.value.includes(mark)) continue;
        if (c.kind === 'statuses') await post('/api/v1/catalog-items/' + i.id, { version: i.version, value: i.value.replace(' ' + mark, '') }, 'PATCH');
        else if (!i.archived && !i.isSystem) await post('/api/v1/catalog-items/' + i.id + '/archive', { version: i.version });
      }
    }
    for (const t of (await j(await fetch('/api/v1/form-templates?includeArchived=true'))).items) {
      if (t.name.includes(mark) && !t.archived) await post('/api/v1/form-templates/' + t.id + '/archive', { version: t.version });
    }
    for (const y of [new Date().getFullYear(), new Date().getFullYear() + 1]) {
      for (const d of (await j(await fetch('/api/v1/calendar/days?year=' + y))).items) {
        if (d.title.includes(mark)) await post('/api/v1/calendar/days/' + d.id + '/delete', { version: d.version });
      }
    }
    for (const r of (await j(await fetch('/api/v1/roles'))).items) {
      if (r.name.includes(mark) && r.userCount === 0) await post('/api/v1/roles/' + r.id + '/delete', { version: r.version });
    }
    for (const u of (await j(await fetch('/api/v1/users?limit=200'))).items) {
      if (u.login.includes(${JSON.stringify(RUN)}) && u.isActive) await post('/api/v1/users/' + u.id + '/disable', { version: u.version });
    }
  })()`).catch(() => undefined);
}

after(async () => {
  if (ui) await cleanup();
  if (ui) {
    assert.deepEqual(ui.consoleErrors, [], 'ошибки JavaScript в странице');
    ui.close();
  }
});

describe('Справочники', () => {
  it('значение: добавить, переименовать, в архив, вернуть, удалить', async () => {
    await ui.goto('/settings/catalogs?c=systems');
    const name = tag('Система');
    const m = ui.mark();
    await ui.type($.field('Новое значение'), name);
    await ui.click($.button('Добавить'));
    assert.equal((await ui.request(m, 'POST', '/catalogs/systems/items')).status, 201);
    await ui.waitFor(`!!${$.row(name)}`, 'новое значение в таблице');

    const renamed = `${name} (изм.)`;
    const req = await editRow(name, () => ui.type($.input('Значение'), renamed), 'PATCH', '/catalog-items/');
    assert.equal(req.json.value, renamed);
    await ui.waitFor(`!!${$.row(renamed)}`, 'переименованное значение');

    await action('В архив', $.row(renamed), 'POST', '/archive');
    await ui.waitFor(`${$.row(renamed)}?.textContent.includes('В архиве')`, 'отметка «В архиве»');
    await action('Вернуть', $.row(renamed), 'POST', '/restore');
    await ui.waitFor(`${$.row(renamed)}?.textContent.includes('Активно')`, 'снова активно');

    await ui.click($.button('Удалить', $.row(renamed)));
    await action('Удалить', $.row(renamed), 'POST', '/delete', 204);
    await ui.waitFor(`!${$.row(renamed)}`, 'значение удалено');
  });

  it('системное значение: цвет меняется, имя — нет', async () => {
    await ui.goto('/settings/catalogs?c=task_categories');
    const req = await editRow('Почта', async () => {
      assert.ok(await ui.evaluate(`${$.input('Значение')}.readOnly`), 'имя системного значения только для чтения');
      await ui.select($.input('Цвет'), 'high');
    }, 'PATCH', '/catalog-items/');
    assert.equal(req.json.color, 'high');
    const back = await editRow('Почта', () => ui.select($.input('Цвет'), 'info'), 'PATCH', '/catalog-items/');
    assert.equal(back.json.color, 'info');
  });

  it('колонки задач: переименовать и признак комментария; своя колонка — на место, в архив, удалить (релиз 1.2.0)', async () => {
    await ui.goto('/settings/catalogs?c=task_statuses');
    const req = await editRow('Выполнено', () => ui.type($.input('Значение'), tag('Выполнено')), 'PATCH', '/catalog-items/');
    assert.equal(req.json.value, tag('Выполнено'));
    // Признак «при переходе вперёд» у «Выполнено» включён по умолчанию: снять и вернуть.
    const checkbox = (label) => `[...document.querySelectorAll('tr.editing label.chk')].find((l) => l.textContent.includes(${JSON.stringify(label)}))?.querySelector('input')`;
    const off = await editRow(tag('Выполнено'), async () => {
      await ui.type($.input('Значение'), 'Выполнено');
      await ui.click(checkbox('при переходе вперёд'), '«при переходе вперёд»');
    }, 'PATCH', '/catalog-items/');
    assert.equal(off.json.commentForward, false);
    const on = await editRow('Выполнено', () => ui.click(checkbox('при переходе вперёд'), '«при переходе вперёд»'), 'PATCH', '/catalog-items/');
    assert.equal(on.json.commentForward, true);

    // Своя колонка после «В работе», с комментарием при переходе вперёд.
    const form = `document.querySelector('form[aria-label="Новая колонка"]')`;
    const name = tag('Ждём ответа');
    await ui.type($.field('Новая колонка', form), name);
    const work = await ui.evaluate(`fetch('/api/v1/catalogs/task_statuses/items').then((r) => r.json()).then((j) => j.items.find((i) => i.systemKey === 'work').id)`);
    await ui.select(`${form}.querySelector('select[aria-label="Место колонки"]')`, work);
    await ui.click(`[...${form}.querySelectorAll('label.chk')].find((l) => l.textContent.includes('при переходе вперёд'))?.querySelector('input')`);
    let m = ui.mark();
    await ui.click($.button('Добавить', form));
    const created = await ui.request(m, 'POST', '/catalogs/task_statuses/items');
    assert.equal(created.status, 201);
    assert.equal(created.json.commentForward, true);
    await ui.waitFor(`!!${$.row(name)}`, 'новая колонка в списке');
    const order = await ui.evaluate(`[...document.querySelectorAll('.cat-tbl tbody tr b')].map((b) => b.textContent)`);
    assert.equal(order.indexOf(name), order.indexOf('В работе') + 1, 'колонка встала после «В работе»');

    m = ui.mark();
    await ui.click($.button('В архив', $.row(name)));
    assert.equal((await ui.request(m, 'POST', '/archive')).status, 200);
    await ui.waitFor(`${$.row(name)}?.textContent.includes('В архиве')`, 'колонка в архиве');
    await ui.click($.button('Удалить', $.row(name)));
    m = ui.mark();
    await ui.click($.button('Удалить', $.row(name)));
    assert.equal((await ui.request(m, 'POST', '/delete')).status, 204);
    await ui.waitFor(`!${$.row(name)}`, 'колонка удалена');
  });

  it('правило почты: ключевые слова и ответственный', async () => {
    await ui.goto('/settings/catalogs?c=mail_rules');
    const before = await ui.text(`${$.row('DLP')}?.children[1]`);
    const req = await editRow('DLP', async () => {
      await ui.type($.input('Ключевые слова'), 'dlp, флешка, e2e');
      const owner = await ui.evaluate(`[...document.querySelector('tr.editing select').options].find((o) => o.value)?.value`);
      assert.ok(owner, 'в списке ответственных есть сотрудники ИБ');
      await ui.select(`document.querySelector('tr.editing select')`, owner);
    }, 'PATCH', '/catalog-items/');
    assert.deepEqual(req.json.keywords, ['dlp', 'флешка', 'e2e']);
    assert.ok(req.json.ownerUserId);
    await editRow('DLP', async () => {
      await ui.type($.input('Ключевые слова'), before);
      await ui.select(`document.querySelector('tr.editing select')`, '');
    }, 'PATCH', '/catalog-items/');
  });
});

describe('Производственный календарь', () => {
  it('выходные дни недели', async () => {
    await ui.goto('/settings/catalogs?c=work_calendar');
    const sat = `[...document.querySelectorAll('[aria-label="Выходные дни недели"] button')].find((b) => b.textContent === 'Сб')`;
    await ui.waitFor(`${sat}?.getAttribute('aria-pressed') === 'true'`, 'суббота — выходной');
    let m = ui.mark();
    await ui.click(sat);
    assert.deepEqual((await ui.request(m, 'PUT', '/calendar/week')).json.weekendDays, [7]);
    await ui.waitFor(`${sat}?.getAttribute('aria-pressed') === 'false'`, 'суббота — рабочая');
    m = ui.mark();
    await ui.click(sat);
    assert.deepEqual((await ui.request(m, 'PUT', '/calendar/week')).json.weekendDays, [6, 7]);
  });

  it('праздник: добавить, изменить, удалить', async () => {
    await ui.goto('/settings/catalogs?c=work_calendar');
    await ui.click(`[...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Следующий год')`);
    const title = tag('Праздник');
    const year = new Date().getFullYear() + 1;
    // Поле type=date заполняется значением целиком: посимвольный ввод даты зависит от локали браузера.
    await setNative($.field('Дата'), `${year}-12-30`);
    await ui.select($.field('Вид'), 'holiday');
    await ui.type($.field('Название'), title);
    const m = ui.mark();
    await ui.click($.button('Добавить'));
    assert.equal((await ui.request(m, 'POST', '/calendar/days')).status, 201);
    await ui.waitFor(`!!${$.row(title)}`, 'праздник в таблице');

    const req = await editRow(title, () => ui.type($.input('Название'), `${title} (изм.)`), 'PATCH', '/calendar/days/');
    assert.equal(req.json.title, `${title} (изм.)`);
    await ui.click($.button('Удалить', $.row(`${title} (изм.)`)));
    await action('Удалить', $.row(`${title} (изм.)`), 'POST', '/delete', 204);
    await ui.waitFor(`!${$.row(title)}`, 'праздник удалён');
  });
});

describe('Шаблоны форм', () => {
  it('шаблон и поля: создать, изменить, порядок, удалить; архив', async () => {
    await ui.goto('/settings/catalogs?c=form_templates');
    const name = tag('Шаблон');
    await ui.click($.button('+ Новый шаблон'));
    const newForm = `[...document.querySelectorAll('form.tpl-form')].find((f) => f.textContent.includes('Создать'))`;
    await ui.type($.field('Название шаблона', newForm), name);
    let m = ui.mark();
    await ui.click($.button('Создать', newForm));
    assert.equal((await ui.request(m, 'POST', '/form-templates')).status, 201);
    await ui.waitFor(`[...document.querySelectorAll('.filters button')].some((b) => b.textContent === ${JSON.stringify(name)} && b.getAttribute('aria-pressed') === 'true')`, 'новый шаблон выбран');

    const propsForm = `[...document.querySelectorAll('form.tpl-form')].find((f) => f.textContent.includes('Сохранить шаблон'))`;
    await ui.type($.field('Действует, мес.', propsForm), '6');
    m = ui.mark();
    await ui.click($.button('Сохранить шаблон'));
    const props = await ui.request(m, 'PATCH', '/form-templates/');
    assert.equal(props.status, 200);
    assert.equal(props.json.validMonths, 6);

    const addForm = `document.querySelector('form.with-field')`;
    for (const [label, kind, threshold] of [['Копий в неделю', 'min', '3'], ['Ответственный за копии', 'text', null]]) {
      await ui.type($.field('Новое поле', addForm), label);
      await ui.select($.field('Тип проверки', addForm), kind);
      if (threshold) await ui.type($.field('Значение', addForm), threshold);
      m = ui.mark();
      await ui.click($.button('Добавить поле'));
      assert.equal((await ui.request(m, 'POST', '/fields')).status, 200);
      await ui.waitFor(`!!${$.row(label)}`, `поле «${label}»`);
    }

    const req = await editRow('Копий в неделю', async () => {
      await ui.type($.input('Поле формы'), 'Копий в неделю, не менее');
      await ui.type($.input('Значение'), '5');
    }, 'PATCH', '/form-template-fields/');
    assert.deepEqual([req.json.label, req.json.threshold], ['Копий в неделю, не менее', 5]);

    await action('↑', $.row('Ответственный за копии'), 'POST', '/move');
    await ui.waitFor(`document.querySelector('tbody tr')?.textContent.includes('Ответственный за копии')`, 'поле поднялось');
    await action('Удалить', $.row('Ответственный за копии'), 'POST', '/form-template-fields/');
    await ui.waitFor(`!${$.row('Ответственный за копии')}`, 'поле удалено');

    await action('В архив', 'document', 'POST', '/archive');
    await action('Вернуть из архива', 'document', 'POST', '/restore');
    await ui.click($.button('Удалить шаблон'));
    await action('Удалить', 'document', 'POST', '/delete', 204);
    await ui.waitFor(`![...document.querySelectorAll('.filters button')].some((b) => b.textContent.includes(${JSON.stringify(name)}))`, 'шаблон удалён');
  });
});

describe('Роли и права', () => {
  it('роль: создать, переименовать, выдать и снять право, удалить', async () => {
    await ui.goto('/settings/users');
    const role = tag('Аудитор');
    const roleForm = `document.querySelector('form.with-desc')`;
    await ui.type($.field('Новая роль', roleForm), role);
    let m = ui.mark();
    await ui.click($.button('Добавить роль'));
    assert.equal((await ui.request(m, 'POST', '/roles')).status, 201);

    const th = (name) => `[...document.querySelectorAll('thead th')].find((th) => th.textContent.includes(${JSON.stringify(name)}))`;
    await ui.click($.button('Изм.', th(role)));
    await sleep(300);
    const renamed = `${role} (изм.)`;
    const editingTh = `document.querySelector('thead th form')`;
    await ui.type(`${editingTh}?.querySelector('input')`, renamed);
    m = ui.mark();
    await ui.click($.button('OK', editingTh));
    const rn = await ui.request(m, 'PATCH', '/roles/');
    assert.equal(rn.status, 200);
    assert.equal(rn.json.name, renamed);

    const box = `document.querySelector('input.perm[aria-label=${JSON.stringify(`${renamed}: Записи реестров: добавление и правка`)}]')`;
    for (const granted of [true, false]) {
      await ui.waitFor(`${box} && !${box}.disabled`, 'флажок права доступен');
      m = ui.mark();
      await ui.click(box);
      const req = await ui.request(m, 'PUT', '/permissions/records.edit');
      assert.equal(req.status, 200);
      assert.equal(req.json.granted, granted);
      await ui.waitFor(`${box}?.checked === ${granted}`, 'флажок обновился');
    }

    await action('Удал.', th(renamed), 'POST', '/delete', 204);
    await ui.waitFor(`!${th(renamed)}`, 'роль удалена');
  });

  it('права супер-администратора на настройки и пользователей не снимаются', async () => {
    const locked = await ui.evaluate(`document.querySelector('input.perm[aria-label="Супер-администратор: Настройки: пользователи, роли и права"]').disabled`);
    assert.equal(locked, true);
  });

  it('системные роли «Начальник ИБ» и «SOC» в матрице; у «SOC» — права «Сотрудника ИБ»', async () => {
    const heads = await ui.evaluate(`[...document.querySelectorAll('thead th .rn')].map((n) => n.textContent.trim())`);
    assert.ok(heads.includes('Начальник ИБ'), `столбцы: ${heads.join(', ')}`);
    assert.ok(heads.includes('SOC'), `столбцы: ${heads.join(', ')}`);
    const on = (role) => `[...document.querySelectorAll('input.perm')].filter((i) => i.getAttribute('aria-label').startsWith(${JSON.stringify(`${role}: `)}) && i.checked).map((i) => i.getAttribute('aria-label').slice(${role.length + 2})).sort()`;
    assert.deepEqual(await ui.evaluate(on('SOC')), await ui.evaluate(on('Сотрудник ИБ')));
  });
});

describe('Пользователи', () => {
  it('создать, изменить, разблокировать, сбросить пароль, отключить и включить', async () => {
    await ui.goto('/settings/users');
    const login = `e2e.${RUN}`;
    const form = `document.querySelector('form.user-add')`;
    await ui.type($.field('ФИО', form), tag('Пользователь'));
    await ui.type($.field('Логин', form), login);
    let m = ui.mark();
    await ui.click($.button('Добавить', form));
    const created = await ui.request(m, 'POST', '/api/v1/users');
    assert.equal(created.status, 201);
    // Пароль скрыт по умолчанию; «Показать» открывает его.
    await ui.waitFor(`!!document.querySelector('[role=dialog] .temp-pass code.masked')`, 'окно со скрытым временным паролем');
    await ui.click($.button('Показать', `document.querySelector('[role=dialog]')`), '«Показать»');
    await ui.waitFor(`document.querySelector('[role=dialog] .temp-pass code:not(.masked)')?.textContent.length === 16`, 'временный пароль виден');
    await ui.click($.button('Готово'));
    await ui.waitFor(`!document.querySelector('[role=dialog]')`, 'окно закрыто');
    await revealRow(login);

    // Руководитель (релиз 1.2.0) — тот, кто запускает тест: сотрудник ИБ.
    const meId = await ui.evaluate(`fetch('/api/v1/auth/me').then((r) => r.json()).then((j) => j.user.id)`);
    const req = await editRow(login, async () => {
      await ui.type($.input('Должность'), 'Аудитор (e2e)');
      await ui.click(`[...document.querySelectorAll('tr.editing .role-checks label')].find((l) => l.textContent.includes('Сотрудник ИБ'))?.querySelector('input')`);
      await ui.select(`document.querySelector('tr.editing select[aria-label="Руководитель"]')`, meId, '«Руководитель»');
    }, 'PATCH', '/users/');
    assert.equal(req.json.position, 'Аудитор (e2e)');
    assert.equal(req.json.roleIds.length, 1);
    assert.equal(req.json.managerId, meId);
    await ui.waitFor(`!!${$.row(login)}?.querySelector('[data-manager="${meId}"]')`, 'руководитель в строке пользователя');

    // Блокировка входа: 5 неверных паролей по API (тем же путём через прокси).
    for (let i = 0; i < 5; i++) {
      await fetch(`${BASE}/api/v1/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE },
        body: JSON.stringify({ login, password: 'Wrong-Password-1' }),
      });
    }
    await ui.goto('/settings/users');
    await revealRow(login);
    await ui.waitFor(`${$.row(login)}?.textContent.includes('Вход заблокирован')`, 'отметка о блокировке');
    await action('Разблокировать', $.row(login), 'POST', '/unlock');
    await ui.waitFor(`!${$.row(login)}?.textContent.includes('Вход заблокирован')`, 'блокировка снята');

    await action('Сбросить пароль', $.row(login), 'POST', '/reset-password');
    await ui.waitFor(`document.querySelector('[role=dialog] h2')?.textContent === 'Пароль сброшен'`, 'окно сброса пароля');
    await ui.click($.button('Готово'));

    await action('Отключить', $.row(login), 'POST', '/disable');
    await ui.waitFor(`${$.row(login)}?.textContent.includes('Отключён')`, 'пользователь отключён');
    await action('Включить', $.row(login), 'POST', '/enable');
    await ui.waitFor(`${$.row(login)}?.textContent.includes('Активен')`, 'пользователь включён');
    // Уборка: созданный тестом пользователь остаётся отключённым.
    await action('Отключить', $.row(login), 'POST', '/disable');
  });

  it('журнал (раздел «Журнал», фильтр «Настройки — всё») показывает действия теста', async () => {
    await ui.goto('/settings/journal');
    await ui.waitFor(`location.pathname === '/audit'`, 'вкладка журнала настроек ведёт в раздел «Журнал»');
    const settingsGroup = await ui.evaluate(`fetch('/api/v1/audit/facets').then((r) => r.json()).then((j) => j.entities.find((e) => e.label === 'Настройки — всё')?.code)`);
    assert.ok(settingsGroup, 'пункт «Настройки — всё» в фильтре раздела');
    await ui.goto(`/audit?entity=${encodeURIComponent(settingsGroup)}`);
    await ui.waitFor(`document.querySelector('.audit-tbl tbody tr[data-audit]')?.textContent.includes(${JSON.stringify(`e2e.${RUN}`)})`, 'последняя запись журнала про тестового пользователя');
  });
});

describe('Отметка «Является начальником ИБ» (1.4.0)', () => {
  const json = (method, path, body) => ui.evaluate(`fetch(${JSON.stringify(path)}, ${JSON.stringify({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })})
    .then(async (r) => ({ status: r.status, body: await r.json() }))`);
  const people = [];
  /** Держатель отметки до теста — ему она возвращается в after, даже если тест упал. */
  let savedHead;
  before(async () => { savedHead = await saveIbHead(ui); });

  after(async () => {
    try {
      // Уборка: пользователи теста отключаются (отметка снимается вместе с отключением).
      for (const p of people) {
        const cur = await ui.evaluate(`fetch('/api/v1/users?limit=100&q=${p.login}').then((r) => r.json()).then((j) => j.items.find((u) => u.id === '${p.id}'))`);
        if (cur?.isActive) await json('POST', `/api/v1/users/${p.id}/disable`, { version: cur.version });
      }
    } finally {
      await restoreIbHead(ui, savedHead);
    }
  });

  it('отметить, передать через «Передать от …?», отключить держателя с предупреждением', async () => {
    const roles = await ui.evaluate(`fetch('/api/v1/roles').then((r) => r.json())`);
    const staff = roles.items.find((r) => r.code === 'ib_staff').id;
    for (const k of ['ha', 'hb']) {
      const r = await json('POST', '/api/v1/users', { login: `e2e.${RUN}.${k}`, fullName: tag(`Начальник ${k.toUpperCase()}`), roleIds: [staff] });
      assert.equal(r.status, 201);
      people.push({ id: r.body.user.id, login: r.body.user.login, fullName: r.body.user.fullName });
    }
    const [a, b] = people;
    const chip = (u) => `!!${$.row(u.login)}?.querySelector('[data-testid=ib-head-chip]')`;
    const dialog = `document.querySelector('[role=alertdialog]')`;

    // Отметить A: если отметка уже у кого-то (прошлые прогоны, данные dev), портал спрашивает о передаче.
    await ui.goto('/settings/users');
    await revealRow(a.login);
    await ui.click($.button('Изменить', $.row(a.login)), '«Изменить» у A');
    await ui.waitFor(`!!${$.editing}`, 'карточка A');
    let m = ui.mark();
    await ui.click($.button('Отметить', `${$.editing}.querySelector('[data-testid=ib-head]')`), '«Отметить»');
    const first = await ui.request(m, 'PUT', '/ib-head');
    if (first.status === 409) {
      await ui.waitFor(`${dialog}?.querySelector('h2')?.textContent.startsWith('Передать от ')`, 'вопрос о передаче');
      m = ui.mark();
      await ui.click($.button('Передать', dialog), '«Передать»');
      assert.equal((await ui.request(m, 'PUT', '/ib-head')).status, 200);
    } else {
      assert.equal(first.status, 200);
    }
    await ui.waitFor(`${$.editing}?.querySelector('[data-testid=ib-head]')?.textContent.includes('Да')`, 'в карточке A — «Да»');
    await ui.click($.button('Отмена', $.editing), '«Отмена»');
    await ui.waitFor(chip(a), 'метка «Начальник ИБ» у A в списке');

    // Передать B: вопрос с ФИО держателя.
    await revealRow(b.login);
    await ui.click($.button('Изменить', $.row(b.login)), '«Изменить» у B');
    await ui.waitFor(`!!${$.editing}`, 'карточка B');
    m = ui.mark();
    await ui.click($.button('Отметить', `${$.editing}.querySelector('[data-testid=ib-head]')`), '«Отметить» у B');
    assert.equal((await ui.request(m, 'PUT', '/ib-head')).status, 409);
    await ui.waitFor(`${dialog}?.querySelector('h2')?.textContent === ${JSON.stringify(`Передать от ${a.fullName}?`)}`, '«Передать от A?»');
    m = ui.mark();
    await ui.click($.button('Передать', dialog), '«Передать»');
    const moved = await ui.request(m, 'PUT', '/ib-head');
    assert.equal(moved.status, 200);
    assert.equal(moved.json.transfer, true);
    await ui.waitFor(`!${dialog}`, 'окно закрыто');
    await ui.click($.button('Отмена', $.editing), '«Отмена»');
    await ui.waitFor(`${chip(b)} && !(${chip(a)})`, 'метка перешла к B');

    // Отключить держателя: сначала предупреждение, отметка снимается вместе с отключением.
    m = ui.mark();
    await ui.click($.button('Отключить', $.row(b.login)), '«Отключить» у B');
    await ui.waitFor(`${dialog}?.textContent.includes('У пользователя отметка «Начальник ИБ», этап останется без исполнителя')`, 'предупреждение');
    assert.deepEqual(ui.requestsSince(m).filter((r) => r.method !== 'GET'), [], 'до подтверждения ничего не отправлено');
    await ui.click($.button('Отключить', dialog), '«Отключить» в окне');
    const off = await ui.request(m, 'POST', '/disable');
    assert.equal(off.status, 200);
    assert.equal((await ui.response(off)).isIbHead, false);
    await ui.waitFor(`${$.row(b.login)}?.textContent.includes('Отключён') && !(${chip(b)})`, 'B отключён, метки нет');
  });
});
