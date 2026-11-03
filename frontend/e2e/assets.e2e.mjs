// Сквозной тест реестра активов (релиз 1.6.0, ADR-0031, ADR-0032): Chrome → Vite (прокси /api) → backend → PostgreSQL.
//
// Администратор заводит значимый продукт без владельцев и видит его в сверке со ссылкой на карточку. Реестр сервисов
// загружается в «Компоненты» с предпросмотром (продукты создаются, хосты можно снять), отчёт о развёртывании KSC —
// в «Хосты»; обрезанный отчёт не принимается. Файлы генерируются здесь, имена вымышленные.
// В конце записи прогона уходят в архив.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { $, launchBrowser } from './browser.mjs';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const LOGIN = process.env.E2E_LOGIN;
const PASSWORD = process.env.E2E_PASSWORD;
const RUN = `E2E-${Date.now().toString(36)}`;

let ui;
let navSeq = 0;
let service;
let registers;
const DIR = mkdtempSync(join(tmpdir(), 'ibportal-assets-'));
// Адреса прогона: в dev-базе не пересекаются с другими прогонами.
const NET = `10.254.${Math.floor(Math.random() * 250)}`;

/** Книга XML Spreadsheet 2003 — как отчёт KSC «.xls». */
function spreadsheetML(sheets) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const cell = (v) => (v === '' ? '<Cell/>' : typeof v === 'number' ? `<Cell><Data ss:Type="Number">${v}</Data></Cell>` : `<Cell><Data ss:Type="String">${esc(v)}</Data></Cell>`);
  return '<?xml version="1.0"?>\n<?mso-application progid="Excel.Sheet"?>\n<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">'
    + sheets.map((s) => `<Worksheet ss:Name="${s.name}"><Table>${s.rows.map((r) => `<Row>${r.map(cell).join('')}</Row>`).join('')}</Table></Worksheet>`).join('')
    + '</Workbook>';
}
function file(name, sheets) {
  const path = join(DIR, name);
  writeFileSync(path, spreadsheetML(sheets));
  return path;
}
const deployment = (devices, total = devices.length) => file(`deploy-${total}.xls`, [
  { name: 'Summary', rows: [['Kaspersky Security Center'], ['Отчет о развертывании защиты'], [''], ['Статус', 'Количество устройств'], ['Агент и защита', total]] },
  { name: 'Details', rows: [['Виртуальный Сервер администрирования', 'Группа', 'Устройство', 'Версия Агента администрирования', 'Название программы безопасности', 'Версия программы безопасности'],
    ...devices.map((d) => ['', 'Филиал 1', d, '15.1', 'Kaspersky Endpoint Security для Windows', '12.5'])] },
]);
const registry = () => file('registry.xls', [{
  name: 'Список активов',
  rows: [['Реестр ИТ-активов'], ['Подразделение:', 'Тестовый отдел'], [''], [''], [''],
    ['№', 'Наименование актива', 'Тип актива', 'Важность/Критичность', 'Местоположение', 'Описание/назначение', 'Операционная система/ПО', 'IP-адрес', 'Владелец', 'Класификация', 'Команда'],
    [1, `${RUN}-api`, 'Сервис', 'Mission Critical', '', '', 'Linux Centos 7', `${NET}.5:8080`, 'Иванов И.', 'В эксплуатации', `${RUN}-команда`],
    [2, `${RUN}-db`, 'База данных', 'Business Operatinal', '', '', '', `${NET}.6:5432`, 'Иванов И.', 'Тест', `${RUN}-команда`]],
}]);

/** Записи прогона в реестре — по поиску. */
async function runRecords(registerId, q = RUN) {
  return (await ok('GET', `/api/v1/registers/${registerId}/records?q=${encodeURIComponent(q)}&limit=100`)).items;
}

async function api(method, path, body) {
  const res = await ui.evaluate(`fetch(${JSON.stringify(path)}, ${JSON.stringify(body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })})
    .then(async (r) => ({ status: r.status, text: await r.text() }))`);
  return { status: res.status, json: res.text ? JSON.parse(res.text) : null };
}

async function ok(method, path, body) {
  const r = await api(method, path, body);
  assert.ok(r.status >= 200 && r.status < 300, `${method} ${path} → ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

async function login(name, password) {
  await ui.goto(`/login?n=${++navSeq}`);
  await ui.type(`document.querySelector('input[name=username]')`, name);
  await ui.type(`document.querySelector('input[name=password]')`, password);
  await ui.click(`document.querySelector('form button[type=submit]')`);
  await ui.waitFor(`location.pathname !== '/login'`, `вход ${name}`);
}

const factRow = (code) => `document.querySelector('[data-fact=${JSON.stringify(code)}]')`;

before(async () => {
  assert.ok(LOGIN && PASSWORD, 'Задайте E2E_LOGIN и E2E_PASSWORD (пользователь с ролью «Супер-администратор»)');
  ui = await launchBrowser({ baseUrl: BASE });
  await login(LOGIN, PASSWORD);
  ({ registers } = await ok('GET', '/api/v1/assets/checks'));
  const reg = await ok('GET', `/api/v1/registers/${registers.services}`);
  const title = reg.fields.find((f) => f.isTitle);
  const level = reg.fields.find((f) => f.systemKey === 'level');
  service = await ok('POST', `/api/v1/registers/${registers.services}/records`, {
    values: { [title.id]: `${RUN} сервис`, [level.id]: level.options.find((o) => o.label === 'Mission Critical').id },
  });
});

after(async () => {
  if (!ui) return;
  if (service) await api('POST', `/api/v1/register-records/${service.id}/archive`, { version: service.version });
  // Записи, созданные импортом: продукты, компоненты, хосты по имени прогона и адресам прогона.
  for (const [id, q] of [[registers?.services, RUN], [registers?.components, RUN], [registers?.hosts, RUN], [registers?.hosts, NET]]) {
    if (!id) continue;
    for (const r of await runRecords(id, q).catch(() => [])) await api('POST', `/api/v1/register-records/${r.id}/archive`, { version: r.version });
  }
  await ui.close();
});

describe('Активы', () => {
  it('пункт меню, нарушитель со ссылкой на карточку', async () => {
    await ui.goto('/dashboard');
    await ui.click(`[...document.querySelectorAll('nav.nav a')].find((a) => a.textContent.trim() === 'Активы')`, 'пункт «Активы»');
    await ui.waitFor(`location.pathname === '/assets' && !!${factRow('products.ownership')}`, 'раздел «Активы»');

    // Сервис прогона без владельцев — нарушитель; список раскрывается щелчком.
    await ui.waitFor(`${factRow('products.ownership')}.textContent.includes('Не выполнено')`, 'проверка владельцев не выполнена');
    await ui.click(`[...${factRow('products.ownership')}.querySelectorAll('button')].find((b) => b.textContent.startsWith('Показать'))`, '«Показать»');
    await ui.waitFor(`${factRow('products.ownership')}.textContent.includes(${JSON.stringify(RUN)})`, 'сервис прогона в списке');

    // Раздел методики: название, полный текст, ссылка раскрывает текст; ссылка в самооценку — только с её правом.
    const sec = (code) => `document.querySelector('[data-section=${JSON.stringify(code)}]')`;
    await ui.waitFor(`${sec('2.2')}.querySelector('h3').textContent.includes('Инвентаризация активов')`, 'название раздела');
    await ui.click(`[...${factRow('products.without_risk')}.querySelectorAll('a')].find((a) => a.textContent === '1.2')`, 'ссылка на связанный раздел');
    await ui.waitFor(`location.hash === '#sec-1.2' && ${sec('1.2')}.querySelector('details').open`, 'раздел 1.2 раскрыт');
    await ui.waitFor(`${sec('1.2')}.textContent.includes('Уровень 4 · Продвинутый')`, 'критерии уровней');
    assert.equal(await ui.evaluate(`[...${sec('1.2')}.querySelectorAll('a')].some((a) => a.textContent === 'Открыть в самооценке')`), false);

    // Ссылка ведёт в карточку записи.
    await ui.click(`[...${factRow('products.ownership')}.querySelectorAll('a')].find((a) => a.textContent.includes(${JSON.stringify(RUN)}))`, 'ссылка на запись');
    await ui.waitFor(`location.pathname.startsWith('/registers') && location.search.includes(${JSON.stringify(service.id)})`, 'переход к записи');
  });

  it('реестр сервисов → компоненты: предпросмотр, продукты создаются, снятые хосты — нет', async () => {
    await ui.goto(`/registers/${registers.components}/records?n=${++navSeq}`);
    await ui.waitFor(`!!${$.button('Импорт реестра сервисов')}`, 'кнопка адаптера');
    await ui.setFiles('input[aria-label="Файл реестра сервисов"]', [registry()]);
    const dialog = `document.querySelector('[role=dialog]')`;
    await ui.waitFor(`${dialog}?.textContent.includes('лист «Список активов», заголовки в строке 6')`, 'предпросмотр реестра сервисов');
    await ui.waitFor(`${dialog}.querySelector('[data-block="new_products"]')?.textContent.includes(${JSON.stringify(`${RUN}-команда`)})`, 'блок «Будут созданы продукты»');
    assert.match(await ui.evaluate(`${dialog}.querySelector('[data-block="new_products"]').textContent`), /Параметры портала/);
    assert.equal((await runRecords(registers.components)).length, 0, 'предпросмотр ничего не создал');
    // Хосты снимаем: компоненты останутся без хоста.
    await ui.click(`${dialog}.querySelector('[data-block="new_hosts"] input[type=checkbox]')`, 'снять «Будут созданы хосты»');
    await ui.click(`[...${dialog}.querySelectorAll('button')].find((b) => b.textContent.startsWith('Применить'))`, '«Применить»');
    await ui.waitFor(`!document.querySelector('[role=dialog]')`, 'окно закрыто');
    await ui.waitFor(`document.body.textContent.includes(${JSON.stringify(`${RUN}-api`)})`, 'компонент в реестре');
    assert.equal((await runRecords(registers.components)).length, 2);
    assert.equal((await runRecords(registers.services, `${RUN}-команда`)).length, 1, 'продукт создан');
    assert.equal((await runRecords(registers.hosts, NET)).length, 0, 'хосты не созданы');
  });

  it('отчёт о развёртывании KSC → хосты; обрезанный отчёт не принимается', async () => {
    await ui.goto(`/registers/${registers.hosts}/records?n=${++navSeq}`);
    await ui.waitFor(`!!${$.button('Импорт отчёта KSC')}`, 'кнопка адаптера');
    // 1.6.4: перед выбором файла — «Как загружать отчёты KSC» с порядком отчётов; «Больше не показывать» запоминается.
    await ui.evaluate(`localStorage.removeItem('ksc.guide.hidden')`);
    await ui.click($.button('Импорт отчёта KSC'));
    const guide = `document.querySelector('[data-testid=ksc-guide]')`;
    await ui.waitFor(`!!${guide}`, 'окно «Как загружать отчёты KSC»');
    const steps = await ui.evaluate(`[...${guide}.querySelectorAll('.ksc-steps b')].map((b) => b.textContent)`);
    assert.deepEqual(steps, ['Отчёт о развёртывании защиты', 'Отчёт о статусе антивирусных баз', 'Отчёт о версиях программ «Лаборатории Касперского»']);
    assert.ok((await ui.text(guide)).includes('1000 строк'), 'про лимит записей в KSC');
    await ui.click(`${guide}.querySelector('label.check input')`, '«Больше не показывать»');
    await ui.click($.button('Закрыть', guide));
    assert.equal(await ui.evaluate(`localStorage.getItem('ksc.guide.hidden')`), '1');
    await ui.click($.button('Как загружать'));
    await ui.waitFor(`!!${guide}`, 'окно открывается ссылкой «Как загружать»');
    await ui.press('Escape');
    await ui.waitFor(`!${guide}`, 'окно закрыто');
    await ui.setFiles('input[aria-label="Файл отчёта KSC"]', [deployment([`${RUN}-PC01NB`, `${RUN}-PC02NB`, `${RUN}-PC03NB`], 4)]);
    await ui.waitFor(`[...document.querySelectorAll('.toast, [role=status], [role=alert]')].some((t) => t.textContent.includes('Отчёт обрезан: в сводке 4 устройств, в таблице 3'))`, 'обрезанный отчёт — ошибка');
    assert.equal(await ui.evaluate(`!!document.querySelector('[role=dialog]')`), false);

    await ui.setFiles('input[aria-label="Файл отчёта KSC"]', [deployment([`${RUN}-PC01NB`, `${RUN}-PC02NB`])]);
    const dialog = `document.querySelector('[role=dialog]')`;
    await ui.waitFor(`${dialog}?.textContent.includes('Отчёт о развёртывании защиты')`, 'предпросмотр отчёта KSC');
    await ui.click(`[...${dialog}.querySelectorAll('button')].find((b) => b.textContent.startsWith('Применить'))`, '«Применить»');
    await ui.waitFor(`!document.querySelector('[role=dialog]')`, 'окно закрыто');
    const hosts = await runRecords(registers.hosts);
    assert.equal(hosts.length, 2);
    const reg = await ok('GET', `/api/v1/registers/${registers.hosts}`);
    const coverage = reg.fields.find((f) => f.systemKey === 'coverage');
    assert.deepEqual(hosts.map((h) => h.display[coverage.id]), ['Агент и защита', 'Агент и защита']);
  });

  it('«Настройки → Параметры портала»: неверное значение не сохраняется, изменение в журнале, сброс к умолчанию', async () => {
    const before = (await ok('GET', '/api/v1/settings/portal-params')).items.find((p) => p.key === 'vulns');
    const panel = `document.querySelector('[data-param="vulns"]')`;
    await ui.goto('/settings/params');
    await ui.waitFor(`!!${panel}`, 'панель параметра');
    const input = `${panel}.querySelector('input[aria-label="Порог, дней"]')`;
    await ui.evaluate(`(() => { const i = ${input}; i.focus(); i.select(); })()`);
    await ui.type(input, '0');
    await ui.click($.button('Сохранить', panel));
    await ui.waitFor(`${panel}.querySelector('[role=alert]')?.textContent.includes('Порог: не меньше 1 дня')`, 'понятная ошибка');
    assert.deepEqual((await ok('GET', '/api/v1/settings/portal-params')).items.find((p) => p.key === 'vulns').value, before.value, 'неверное значение не сохранилось');

    await ui.evaluate(`(() => { const i = ${input}; i.focus(); i.select(); })()`);
    await ui.type(input, '45');
    await ui.click($.button('Сохранить', panel));
    await ui.waitFor(`${panel}.querySelector('.chip')?.textContent === 'Изменено' && ${input}.value === '45'`, 'сохранено');
    const audit = (await ok('GET', '/api/v1/audit?limit=5')).items.find((e) => e.action === 'portal_param.updated');
    assert.ok(audit, 'в журнале');

    await ui.click($.button('Сбросить к умолчанию', panel));
    await ui.waitFor(`${panel}.querySelector('.chip')?.textContent === 'По умолчанию' && ${input}.value === '90'`, 'сброшено');

    // JSON: не разобрался — сообщение на месте.
    const json = `document.querySelector('[data-param="assets.teamProducts"]')`;
    await ui.evaluate(`(() => { const t = ${json}.querySelector('textarea'); t.focus(); t.select(); })()`);
    await ui.type(`${json}.querySelector('textarea')`, '{не json');
    await ui.click($.button('Сохранить', json));
    await ui.waitFor(`${json}.querySelector('[role=alert]')?.textContent.includes('Это не JSON')`, 'ошибка JSON');
  });
});
