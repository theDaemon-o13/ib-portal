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
const tab = (name) => `[...document.querySelectorAll('.tabs a')].find((a) => a.textContent === ${JSON.stringify(name)})`;

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

after(() => {
  if (ui) {
    assert.deepEqual(ui.consoleErrors, [], 'ошибки JavaScript в странице');
    ui.close();
  }
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('Реестр', () => {
  it('создать и переименовать', async () => {
    await ui.goto('/registers');
    await ui.waitFor(`location.pathname.startsWith('/registers/')`, 'реестры открылись');
    await ui.click(tab('Поля'));
    await ui.type(`document.querySelector('input[aria-label="Название нового реестра"]')`, `${REG} черновик`);
    const m = ui.mark();
    await ui.click($.button('Создать реестр'));
    const req = await ui.request(m, 'POST', '/api/v1/registers');
    assert.equal(req.status, 201);
    await ui.waitFor(`document.querySelector('.reg-title')?.textContent === ${JSON.stringify(`${REG} черновик`)}`, 'новый реестр открыт');
    regId = await ui.evaluate(`location.pathname.split('/')[2]`);

    await ui.click($.button('Переименовать'));
    await ui.type(`document.querySelector('input[aria-label="Название реестра"]')`, REG);
    const m2 = ui.mark();
    await ui.click($.button('Сохранить'));
    const rn = await ui.request(m2, 'PATCH', `/registers/${regId}`);
    assert.equal(rn.status, 200);
    assert.equal(rn.json.name, REG);
    await ui.waitFor(`document.querySelector('.reg-title')?.textContent === ${JSON.stringify(REG)}`, 'новое имя');
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

  it('правка поля: переименование, порядок, роль аналитики', async () => {
    // Щелчок «Изменить» ничего не отправляет (урок этапа 2), затем «Сохранить».
    const m0 = ui.mark();
    await ui.click($.button('Изменить', fieldRow('Комментарий')));
    await sleep(300);
    assert.deepEqual(ui.requestsSince(m0).filter((r) => r.method !== 'GET'), []);
    await ui.type(`document.querySelector('input[aria-label="Название поля"]')`, 'Комментарий ДИКТ');
    const m1 = ui.mark();
    await ui.click($.button('Сохранить', `document.querySelector('table.fields-tbl tr.editing')`));
    assert.equal((await ui.request(m1, 'PATCH', '/register-fields/')).json.label, 'Комментарий ДИКТ');
    await ui.waitFor(`!!${fieldRow('Комментарий ДИКТ')}`, 'поле переименовано');

    await act('↑', fieldRow('Комментарий ДИКТ'), 'POST', '/move');
    const m2 = ui.mark();
    await ui.select(`${fieldRow('Баллы')}.querySelector('select')`, 'metric');
    assert.equal((await ui.request(m2, 'PATCH', '/register-fields/')).json.analyticsRole, 'metric');
  });

  it('значения списка: добавить, переименовать, архив, удалить; закрытый статус', async () => {
    await ui.click($.button('Значения', fieldRow('Уровень')));
    const editor = `document.querySelector('tr.sub-row .options-editor')`;
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
    await ui.click($.button('Значения', fieldRow('Уровень')));

    await ui.click($.button('Значения', fieldRow('Статус')));
    const box = `document.querySelector('input[aria-label="«В работе» закрывает запись"]')`;
    const m2 = ui.mark();
    await ui.click(box);
    assert.equal((await ui.request(m2, 'PATCH', '/register-field-options/')).json.isClosed, true);
    await ui.waitFor(`${box}?.checked === true`, 'отмечено');
    const m3 = ui.mark();
    await ui.click(box);
    assert.equal((await ui.request(m3, 'PATCH', '/register-field-options/')).json.isClosed, false);
    await ui.click($.button('Значения', fieldRow('Статус')));
  });
});

describe('Записи', () => {
  it('карточка: создать, вычисляемый срок, правка только изменённого, история', async () => {
    await ui.click(tab('Записи'));
    await ui.waitFor(`!!document.querySelector('table.recs')`, 'таблица записей');
    await ui.click($.button('Новая запись'));
    await ui.waitFor(`!!${drawer}?.querySelector('form.recform')`, 'карточка новой записи');
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
  it('число → текст с предпросмотром; архив поля с данными; удаление поля без данных; архив реестра', async () => {
    await ui.click(tab('Поля'));
    await ui.waitFor(`!!document.querySelector('table.fields-tbl')`, 'вкладка полей');
    await ui.click($.button('Сменить тип', fieldRow('Баллы')));
    await ui.waitFor(`document.querySelector('[role=dialog] .note')?.textContent.includes('Изменится записей: 1')`, 'предпросмотр смены типа');
    let m = ui.mark();
    await ui.click(`[...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.startsWith('Сменить тип'))`);
    const t = await ui.request(m, 'POST', '/type');
    assert.equal(t.status, 200);
    await ui.waitFor(`${fieldRow('Баллы')}?.textContent.includes('Текст')`, 'тип изменён');

    await act('В архив', fieldRow('Комментарий ДИКТ'), 'POST', '/archive');
    await addField('Временное', 'text');
    await submitField('Временное');
    await ui.click($.button('Удалить', fieldRow('Временное')));
    await act('Удалить', fieldRow('Временное'), 'POST', '/delete');
    await ui.waitFor(`!${fieldRow('Временное')}`, 'поле удалено');

    m = ui.mark();
    const head = `document.querySelector('.panel.min0 > .panel-h')`;
    await ui.click($.button('В архив', head));
    assert.equal((await ui.request(m, 'POST', `/registers/${regId}/archive`)).status, 200);
    await ui.waitFor(`${head}?.textContent.includes('В архиве')`, 'реестр в архиве');
  });
});
