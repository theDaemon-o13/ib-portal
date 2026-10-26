// Сквозной тест конструктора реестров тем же путём, что и браузер пользователя:
// Chrome → Vite (прокси /api) → backend → PostgreSQL, cookie сессии и Origin,
// настоящие щелчки мыши и ввод с клавиатуры. Каждая операция изменения проверяется по телу запроса,
// ответу и результату на экране.
//
//   E2E_LOGIN=admin.dev E2E_PASSWORD=... npm run test:e2e
//
// Создаёт реестр «Реестр E2E-…» и в конце отправляет его в архив (данные реестров не удаляются).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { $, launchBrowser, sleep } from './browser.mjs';

// exceljs — из backend: тесту нужно собрать файл импорта, во frontend зависимость не добавляется.
const ExcelJS = createRequire(new URL('../../backend/package.json', import.meta.url))('exceljs');

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const LOGIN = process.env.E2E_LOGIN;
const PASSWORD = process.env.E2E_PASSWORD;
const RUN = Date.now().toString(36);
const REG = `Реестр E2E-${RUN}`;

let ui;
let tmp;
let regId;
let adminName;

const fieldRow = (label) => `[...document.querySelectorAll('table.fields-tbl tbody tr')].find((tr) => tr.querySelector('b')?.textContent === ${JSON.stringify(label)})`;
const recRow = (text) => `[...document.querySelectorAll('table.recs tbody tr')].find((tr) => tr.textContent.includes(${JSON.stringify(text)}))`;
const drawer = `document.querySelector('aside.drawer')`;
const cardInput = (label) => `[...document.querySelectorAll('.recform > label')].find((l) => l.firstChild?.textContent === ${JSON.stringify(label)})?.querySelector('input, select, textarea')`;
const addForm = `document.querySelector('form.add-field')`;
const fieldDrawer = `document.querySelector('aside.drawer[aria-label="Настройки поля"]')`;
const tab = (name) => `[...document.querySelectorAll('.reg-bar [role=tab]')].find((b) => b.textContent === ${JSON.stringify(name)})`;
const pickerTitle = `document.querySelector('.picker-btn .reg-title')?.textContent`;
const tabsRect = `(() => { const r = document.querySelector('.reg-bar [role=tablist]').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width)].join(','); })()`;

async function act(label, within, method, urlPart, status = 200) {
  const m = ui.mark();
  await ui.click($.button(label, within), `«${label}»`);
  const req = await ui.request(m, method, urlPart);
  assert.equal(req.status, status, `${label}: ${method} ${urlPart} → ${req.status} ${req.body ?? ''}`);
  return req;
}

const setNative = (expr, value) => ui.evaluate(`(() => { const el = ${expr};
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true })); })()`);

/** Открыть панель «Настройки поля» щелчком по строке; сам щелчок ничего не отправляет. */
async function openField(label) {
  const m0 = ui.mark();
  await ui.click(fieldRow(label), `строка поля «${label}»`);
  await ui.waitFor(`${fieldDrawer}?.querySelector('.dr-title')?.textContent === ${JSON.stringify(label)}`, `панель поля «${label}»`);
  await sleep(250);
  assert.deepEqual(ui.requestsSince(m0).filter((r) => r.method !== 'GET'), [], 'щелчок по строке поля не должен отправлять запросы');
  await assertDrawerPlacement(fieldDrawer);
}

/** Боковая панель у правого края окна, затемнение — на всё окно (а не внутри стеклянной колонки). */
async function assertDrawerPlacement(drawerExpr) {
  const g = await ui.evaluate(`(() => { const d = ${drawerExpr}.getBoundingClientRect(); const b = document.querySelector('.drawer-backdrop').getBoundingClientRect();
    return { right: Math.round(innerWidth - d.right), bw: Math.round(b.width), bh: Math.round(b.height), w: innerWidth, h: innerHeight }; })()`);
  assert.ok(g.right >= 0 && g.right <= 24, `панель у правого края окна (отступ ${g.right}px)`);
  assert.deepEqual([g.bw, g.bh], [g.w, g.h], 'затемнение на всё окно');
}

async function closeField() {
  await ui.click($.button('Закрыть', fieldDrawer));
  await ui.waitFor(`!${fieldDrawer}`, 'панель поля закрыта');
}

async function addField(label, type, { options, role } = {}) {
  await ui.type($.field('Название поля', addForm), label);
  await ui.select($.field('Тип', addForm), type);
  if (options) await ui.type($.field('Значения списка', addForm), options);
  if (role) await ui.select($.field('Для аналитики', addForm), role);
}

async function submitField(label) {
  const m = ui.mark();
  await ui.click($.button('Добавить поле'));
  const req = await ui.request(m, 'POST', '/fields');
  assert.equal(req.status, 200, `поле «${label}»: ${req.status}`);
  await ui.waitFor(`!!${fieldRow(label)}`, `поле «${label}» в таблице`);
  return req;
}

before(async () => {
  assert.ok(LOGIN && PASSWORD, 'Задайте E2E_LOGIN и E2E_PASSWORD (пользователь с ролью «Супер-администратор»)');
  tmp = mkdtempSync(join(tmpdir(), 'ibportal-e2e-xlsx-'));
  ui = await launchBrowser({ baseUrl: BASE });
  await ui.goto('/login');
  await ui.type(`document.querySelector('input[name=username]')`, LOGIN);
  await ui.type(`document.querySelector('input[name=password]')`, PASSWORD);
  await ui.click(`document.querySelector('form button[type=submit]')`);
  await ui.waitFor(`location.pathname !== '/login'`, 'вход');
  adminName = await ui.evaluate(`fetch('/api/v1/auth/me').then((r) => r.json()).then((j) => j.user.fullName)`);
});

after(async () => {
  // Уборка: всё, что создал прогон, — в архив, даже если тест упал на середине.
  if (ui && regId) {
    await ui.evaluate(`fetch('/api/v1/registers/${regId}').then((r) => r.json()).then((reg) => reg.archived ? null
      : fetch('/api/v1/registers/${regId}/archive', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: reg.version }) }))`).catch(() => undefined);
  }
  if (ui) {
    assert.deepEqual(ui.consoleErrors, [], 'ошибки JavaScript в странице');
    ui.close();
  }
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('Реестр', () => {
  it('шапка: создать реестр в выборе реестра, переименовать через меню; адрес #реестр/вкладка', async () => {
    await ui.goto('/registers');
    await ui.waitFor(`/^#[0-9a-f-]{36}\\/records$/.test(location.hash)`, 'адрес с реестром и вкладкой');
    await ui.click(`document.querySelector('button[aria-label="Выбрать реестр"]')`);
    await ui.type(`document.querySelector('input[aria-label="Название нового реестра"]')`, `${REG} черновик`);
    const m = ui.mark();
    await ui.click($.button('Создать реестр'));
    const req = await ui.request(m, 'POST', '/api/v1/registers');
    assert.equal(req.status, 201);
    await ui.waitFor(`${pickerTitle} === ${JSON.stringify(`${REG} черновик`)} && location.hash.endsWith('/fields')`, 'новый реестр открыт на «Полях»');
    regId = await ui.evaluate(`location.hash.slice(1).split('/')[0]`);

    await ui.click(`document.querySelector('button[aria-label="Действия реестра"]')`);
    await ui.click(`[...document.querySelectorAll('[role=menuitem]')].find((b) => b.textContent === 'Переименовать')`);
    await ui.type(`document.querySelector('input[aria-label="Название реестра"]')`, REG);
    const m2 = ui.mark();
    await ui.click($.button('Сохранить', `document.querySelector('[role=dialog]')`));
    const rn = await ui.request(m2, 'PATCH', `/registers/${regId}`);
    assert.equal(rn.status, 200);
    assert.equal(rn.json.name, REG);
    await ui.waitFor(`${pickerTitle} === ${JSON.stringify(REG)}`, 'новое имя в шапке');
  });

  it('переключатель вкладок не сдвигается; «Автоматизация» неактивна; выбор сохраняется после обновления', async () => {
    const onFields = await ui.evaluate(tabsRect);
    await ui.click(tab('Записи'));
    await ui.waitFor(`location.hash === ${JSON.stringify(`#${regId}/records`)} && !!document.querySelector('table.recs')`, 'вкладка «Записи»');
    assert.equal(await ui.evaluate(tabsRect), onFields, 'переключатель на том же месте');
    const auto = tab('Автоматизация');
    assert.equal(await ui.evaluate(`${auto}.getAttribute('aria-disabled')`), 'true');
    assert.equal(await ui.evaluate(`${auto}.title`), 'Появится в следующем выпуске');
    await ui.click(auto);
    assert.equal(await ui.evaluate('location.hash'), `#${regId}/records`, 'щелчок по «Автоматизации» ничего не меняет');
    await ui.click(tab('Поля'));
    await ui.waitFor(`location.hash === ${JSON.stringify(`#${regId}/fields`)}`, 'вкладка «Поля»');
    await ui.goto(`/registers#${regId}/fields`);
    await ui.evaluate('location.reload()');
    await ui.waitFor(`${pickerTitle} === ${JSON.stringify(REG)} && !!document.querySelector('table.fields-tbl')`, 'после обновления — тот же реестр и вкладка');
    assert.equal(await ui.evaluate(tabsRect), onFields, 'после обновления переключатель на том же месте');
  });
});

describe('Поля', () => {
  it('добавить поля всех типов, включая вычисляемое и решение', async () => {
    await addField('Уровень', 'select', { options: 'Высокий, Средний', role: 'dimension' });
    await submitField('Уровень');
    await addField('Баллы', 'number');
    await submitField('Баллы');
    for (const label of ['Выявлено', 'Новый срок']) {
      await addField(label, 'date');
      await submitField(label);
    }
    await addField('Ответственный', 'user');
    await submitField('Ответственный');
    await addField('Комментарий', 'text');
    await submitField('Комментарий');
    await addField('Решение ОУР', 'decision', { options: 'Ожидает решения, Принят, Отклонён' });
    await submitField('Решение ОУР');

    await addField('Срок устранения', 'calc');
    await ui.select(`document.querySelector('.calc-editor select[aria-label="Поле-дата"]')`, await ui.evaluate(`[...document.querySelector('.calc-editor select[aria-label="Поле-дата"]').options].find((o) => o.textContent === 'Выявлено').value`));
    await ui.select(`document.querySelector('.calc-editor select[aria-label="Поле-список"]')`, await ui.evaluate(`[...document.querySelector('.calc-editor select[aria-label="Поле-список"]').options].find((o) => o.textContent === 'Уровень').value`));
    await ui.select(`document.querySelector('.calc-editor select[aria-label="Переопределение"]')`, await ui.evaluate(`[...document.querySelector('.calc-editor select[aria-label="Переопределение"]').options].find((o) => o.textContent === 'Новый срок').value`));
    await ui.type(`document.querySelector('input[aria-label="Дней: Высокий"]')`, '14');
    await ui.type(`document.querySelector('input[aria-label="Дней: Средний"]')`, '30');
    const req = await submitField('Срок устранения');
    const rule = req.json.calcRule;
    assert.equal(Object.values(rule.days).sort((a, b) => a - b).join(), '14,30');
    assert.ok(rule.overrideFieldId);
    assert.match(await ui.text(fieldRow('Срок устранения')), /«Выявлено» \+ срок по «Уровень»/);
  });

  it('строка поля — одна линия, «Для аналитики» в каждой строке', async () => {
    const rows = await ui.evaluate(`[...document.querySelectorAll('table.fields-tbl tbody tr')].map((tr) => ({
      label: tr.querySelector('b')?.textContent, select: !!tr.querySelector('select.role-select'),
      disabled: tr.querySelector('select.role-select')?.disabled, buttons: tr.querySelectorAll('button').length,
    }))`);
    assert.ok(rows.every((r) => r.select), 'список «Для аналитики» есть в каждой строке');
    assert.equal(rows.find((r) => r.label === 'Комментарий').disabled, true, 'для текста — неактивный «Не используется»');
    assert.ok(rows.every((r) => r.buttons <= 2), 'в строке только стрелки порядка');
  });

  it('панель поля: переименование; стрелки порядка и роль аналитики в строке', async () => {
    await openField('Комментарий');
    await ui.type(`${fieldDrawer}.querySelector('input[aria-label="Название поля"]')`, 'Комментарий ДИКТ');
    const m1 = ui.mark();
    await ui.click($.button('Сохранить', fieldDrawer));
    assert.equal((await ui.request(m1, 'PATCH', '/register-fields/')).json.label, 'Комментарий ДИКТ');
    await ui.waitFor(`!!${fieldRow('Комментарий ДИКТ')}`, 'поле переименовано');
    await closeField();

    const m2 = ui.mark();
    await ui.click(`document.querySelector('button[aria-label="Поле «Комментарий ДИКТ» выше"]')`);
    assert.equal((await ui.request(m2, 'POST', '/move')).status, 200);
    assert.equal(await ui.evaluate(`!!${fieldDrawer}`), false, 'стрелка не открывает панель');
    const m3 = ui.mark();
    await ui.select(`${fieldRow('Баллы')}.querySelector('select')`, 'metric');
    assert.equal((await ui.request(m3, 'PATCH', '/register-fields/')).json.analyticsRole, 'metric');
    await ui.waitFor(`[...document.querySelectorAll('.prev-card .ttl span')].some((s) => s.textContent === 'Баллы')`, 'виджет «Баллы» в «Попадёт на дашборд»');
  });

  it('значения списка в панели: добавить, переименовать, архив, удалить; закрытый статус', async () => {
    await openField('Уровень');
    const editor = `${fieldDrawer}.querySelector('.options-editor')`;
    await ui.type(`${editor}.querySelector('input[aria-label="Новое значение поля «Уровень»"]')`, 'Низкий');
    await act('Добавить значение', editor, 'POST', '/options');
    const optRow = (l) => `[...${editor}.querySelectorAll('tbody tr')].find((tr) => tr.querySelector('b')?.textContent === ${JSON.stringify(l)})`;
    await ui.waitFor(`!!${optRow('Низкий')}`, 'новое значение');
    await ui.click($.button('Изменить', optRow('Низкий')));
    await ui.type(`${editor}.querySelector('input[aria-label="Значение списка"]')`, 'Низкая');
    const m = ui.mark();
    await ui.click($.button('Сохранить', `${editor}.querySelector('tr.editing')`));
    assert.equal((await ui.request(m, 'PATCH', '/register-field-options/')).status, 200);
    await ui.waitFor(`!!${optRow('Низкая')}`, 'переименовано');
    await act('В архив', optRow('Низкая'), 'POST', '/archive');
    await act('Вернуть', optRow('Низкая'), 'POST', '/restore');
    await act('Удалить', optRow('Низкая'), 'POST', '/delete');
    await ui.waitFor(`!${optRow('Низкая')}`, 'значение удалено');
    await closeField();

    await openField('Статус');
    const box = `document.querySelector('input[aria-label="«В работе» закрывает запись"]')`;
    const m2 = ui.mark();
    await ui.click(box);
    assert.equal((await ui.request(m2, 'PATCH', '/register-field-options/')).json.isClosed, true);
    await ui.waitFor(`${box}?.checked === true`, 'отмечено');
    const m3 = ui.mark();
    await ui.click(box);
    assert.equal((await ui.request(m3, 'PATCH', '/register-field-options/')).json.isClosed, false);
    await closeField();
  });
});

describe('Записи', () => {
  it('карточка: создать, вычисляемый срок, правка только изменённого, история', async () => {
    await ui.click(tab('Записи'));
    await ui.waitFor(`!!document.querySelector('table.recs')`, 'таблица записей');
    await ui.click($.button('Новая запись'));
    await ui.waitFor(`!!${drawer}?.querySelector('form.recform')`, 'карточка новой записи');
    await assertDrawerPlacement(drawer);
    await ui.type(cardInput('Наименование'), 'CVE-2026-0001');
    await ui.select(cardInput('Уровень'), await ui.evaluate(`[...${cardInput('Уровень')}.options].find((o) => o.textContent === 'Высокий').value`));
    await ui.type(cardInput('Баллы'), '7,5');
    await setNative(cardInput('Выявлено'), '2026-10-01');
    await ui.select(cardInput('Ответственный'), await ui.evaluate(`[...${cardInput('Ответственный')}.options].find((o) => o.textContent === ${JSON.stringify(adminName)}).value`));
    let m = ui.mark();
    await ui.click($.button('Создать запись', drawer));
    const created = await ui.request(m, 'POST', `/registers/${regId}/records`);
    assert.equal(created.status, 201);
    assert.equal(Object.values(created.json.values).includes(7.5), true);
    await ui.waitFor(`${drawer}?.textContent.includes('15.10.2026')`, 'вычисляемый срок 01.10 + 14 дней');

    await ui.type(cardInput('Баллы'), '8');
    m = ui.mark();
    await ui.click($.button('Сохранить', drawer));
    const upd = await ui.request(m, 'PATCH', '/register-records/');
    assert.equal(upd.status, 200);
    assert.deepEqual(Object.values(upd.json.values), [8], 'уходит только изменённое поле');
    assert.equal(typeof upd.json.version, 'number');
    await ui.waitFor(`${drawer}?.querySelector('.hist')?.textContent.includes('«Баллы»: 7,5 → 8')`, 'история изменений');
    await ui.click($.button('Закрыть', drawer));

    await ui.click($.button('Новая запись'));
    await ui.type(cardInput('Наименование'), 'Второй инцидент');
    m = ui.mark();
    await ui.click($.button('Создать запись', drawer));
    assert.equal((await ui.request(m, 'POST', '/records')).status, 201);
    await ui.click($.button('Закрыть', drawer));
    await ui.waitFor(`!!${recRow('Второй инцидент')}`, 'вторая запись в таблице');
  });

  it('поиск, сортировка, закрепление столбцов', async () => {
    let m = ui.mark();
    await ui.type(`document.querySelector('input[aria-label="Поиск по реестру"]')`, 'втор');
    await ui.request(m, 'GET', 'q=%D0%B2%D1%82%D0%BE%D1%80');
    await ui.waitFor(`document.querySelectorAll('table.recs tbody tr.rec-row').length === 1 && !!${recRow('Второй инцидент')}`, 'найдена одна запись');
    await ui.type(`document.querySelector('input[aria-label="Поиск по реестру"]')`, '');
    await ui.waitFor(`document.querySelectorAll('table.recs tbody tr.rec-row').length === 2`, 'обе записи');

    m = ui.mark();
    await ui.click(`[...document.querySelectorAll('table.recs th button')].find((b) => b.textContent.startsWith('Баллы'))`);
    assert.match((await ui.request(m, 'GET', 'sort=')).url, /dir=desc/);

    await ui.select(`document.querySelector('#rec-pin')`, '2');
    await ui.waitFor(`document.querySelectorAll('table.recs thead th.pin').length === 2`, 'закреплены 2 столбца');
    const lefts = await ui.evaluate(`[...document.querySelectorAll('table.recs thead th.pin')].map((th) => th.style.left)`);
    assert.equal(lefts[0], '0px');
    assert.notEqual(lefts[1], '0px');
  });

  it('архив, возврат и удаление записи', async () => {
    await ui.click(recRow('Второй инцидент'));
    await ui.waitFor(`!!${drawer}?.querySelector('form.recform')`, 'карточка');
    await act('В архив', drawer, 'POST', '/archive');
    await ui.waitFor(`${drawer}?.textContent.includes('В архиве')`, 'в архиве');
    await act('Вернуть из архива', drawer, 'POST', '/restore');
    await ui.click($.button('Удалить запись', drawer));
    await act('Удалить', `${drawer}.querySelector('.danger-zone')`, 'POST', '/delete', 204);
    await ui.waitFor(`!${drawer} && !${recRow('Второй инцидент')}`, 'запись удалена');
  });
});

describe('Excel', () => {
  it('экспорт, затем импорт с предпросмотром и применением', async () => {
    let m = ui.mark();
    await ui.click($.button('Экспорт в Excel'));
    const exp = await ui.request(m, 'GET', `/registers/${regId}/export`);
    assert.equal(exp.status, 200);

    // Файл, как его заполнит ДИКТ: та же выгрузка, полученная в браузере с cookie сессии.
    const b64 = await ui.evaluate(`fetch('/api/v1/registers/${regId}/export').then((r) => r.arrayBuffer())
      .then((b) => { let s = ''; new Uint8Array(b).forEach((x) => { s += String.fromCharCode(x); }); return btoa(s); })`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(b64, 'base64'));
    const ws = wb.getWorksheet('Реестр');
    const header = [];
    ws.getRow(1).eachCell((c, n) => { header[n] = String(c.value); });
    const col = (h) => header.indexOf(h);
    const me = await ui.evaluate(`fetch('/api/v1/auth/me').then((r) => r.json()).then((j) => j.user.login)`);
    assert.equal(ws.getRow(2).getCell(col('Ответственный')).value, `${adminName} (${me})`, 'сотрудник выгружается как «ФИО (логин)»');
    ws.getRow(2).getCell(col('Баллы')).value = 9;
    const added = ws.addRow([]);
    added.getCell(col('Наименование')).value = 'Из Excel';
    added.getCell(col('Ответственный')).value = `Кто угодно (${me})`;
    ws.addRow([999, 'Неизвестный ID']);
    const file = join(tmp, `импорт ${RUN}.xlsx`);
    writeFileSync(file, Buffer.from(await wb.xlsx.writeBuffer()));

    m = ui.mark();
    await ui.setFiles('input[aria-label="Файл импорта"]', [file]);
    const prev = await ui.request(m, 'POST', `/registers/${regId}/imports`);
    assert.equal(prev.status, 201);
    await ui.waitFor(`!!document.querySelector('[role=dialog] .imp-kpis')`, 'окно предпросмотра');
    const kpis = await ui.evaluate(`[...document.querySelectorAll('.imp-kpis > div')].map((d) => d.textContent)`);
    assert.deepEqual(kpis, ['1добавится', '1изменится', '0без изменений', '1строк с ошибками']);
    assert.match(await ui.text(`document.querySelector('.imp-errors')`), /Записи с ID 999 нет в реестре/);

    m = ui.mark();
    await ui.click(`[...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.startsWith('Применить'))`);
    const applied = await ui.request(m, 'POST', '/apply');
    assert.equal(applied.status, 200);
    await ui.waitFor(`!document.querySelector('[role=dialog]') && !!${recRow('Из Excel')}`, 'новая запись из Excel');
    assert.match(await ui.text(recRow('CVE-2026-0001')), /9/);
  });
});

describe('Смена типа и архив поля', () => {
  it('панель поля: число → текст с предпросмотром; архив поля с данными; удаление поля без данных; архив реестра', async () => {
    await ui.click(tab('Поля'));
    await ui.waitFor(`!!document.querySelector('table.fields-tbl')`, 'вкладка полей');
    await openField('Баллы');
    await ui.click($.button('Сменить тип', fieldDrawer));
    await ui.waitFor(`${fieldDrawer}?.querySelector('.type-change .note')?.textContent.includes('Изменится записей: 1')`, 'предпросмотр смены типа');
    let m = ui.mark();
    await ui.click(`[...${fieldDrawer}.querySelectorAll('.type-change button')].find((b) => b.textContent.startsWith('Сменить тип'))`);
    const t = await ui.request(m, 'POST', '/type');
    assert.equal(t.status, 200);
    await ui.waitFor(`${fieldRow('Баллы')}?.textContent.includes('Текст')`, 'тип изменён');
    await closeField();

    await openField('Комментарий ДИКТ');
    await act('В архив', fieldDrawer, 'POST', '/archive');
    await ui.waitFor(`${fieldRow('Комментарий ДИКТ')}?.textContent.includes('В архиве')`, 'поле в архиве');
    await closeField();

    await addField('Временное', 'text');
    await submitField('Временное');
    await openField('Временное');
    await ui.click($.button('Удалить поле', fieldDrawer));
    await act('Удалить', `${fieldDrawer}.querySelector('.danger-zone')`, 'POST', '/delete');
    await ui.waitFor(`!${fieldRow('Временное')} && !${fieldDrawer}`, 'поле удалено, панель закрыта');

    m = ui.mark();
    await ui.click(`document.querySelector('button[aria-label="Действия реестра"]')`);
    await ui.click(`[...document.querySelectorAll('[role=menuitem]')].find((b) => b.textContent === 'В архив')`);
    assert.equal((await ui.request(m, 'POST', `/registers/${regId}/archive`)).status, 200);
    await ui.waitFor(`document.querySelector('.picker-btn')?.textContent.includes('архив')`, 'реестр в архиве');
  });
});
