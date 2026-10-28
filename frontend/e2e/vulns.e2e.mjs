// Сквозной тест реестра уязвимостей тем же путём, что и браузер пользователя:
// Chrome → Vite (прокси /api) → backend → PostgreSQL, настоящие щелчки мыши и ввод с клавиатуры.
// Загружает обезличенный образец отчёта сканера, проверяет предпросмотр, применение, сроки в таблице,
// карточку записи (оценка, ручная критичность, события) и вкладку «Автоматизация».
//
//   npm run test:e2e   (логин и пароль — из frontend/.env.e2e или E2E_LOGIN / E2E_PASSWORD)
//
// Работает с системным «Реестром уязвимостей» dev-базы. В конце отправляет в архив всё, что создал:
// записи из отчёта, сам отчёт и тестовое правило (данные реестров не удаляются).
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { $, launchBrowser } from './browser.mjs';

// exceljs — из backend: тесту нужно собрать файл неизвестного формата, во frontend зависимость не добавляется.
const ExcelJS = createRequire(new URL('../../backend/package.json', import.meta.url))('exceljs');

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const LOGIN = process.env.E2E_LOGIN;
const PASSWORD = process.env.E2E_PASSWORD;
const SAMPLE_SRC = fileURLToPath(new URL('../../backend/test/fixtures/scan-report-sample-2026-10-15.xlsx', import.meta.url));
// Свой отдел в ячейке A1 листа «Хосты» (этап Б.2: дубли — по отделу): записи прогона не сливаются с записями
// отчётов, которые загружали на стенд вручную, и тест их не меняет.
const DEPT = `E2E-${Date.now().toString(36)} отдел`;
/** Образец с отделом прогона — создаётся в before(). */
let SAMPLE = '';

let ui;
let tmp;
let regId;
/** Последний номер записи до импорта: всё, что выше, создал этот прогон. */
let numberBefore = 0;
let reportId = null;
let ruleId = null;

const api = (path, init) => ui.evaluate(`fetch(${JSON.stringify(path)}, ${JSON.stringify(init ?? {})}).then((r) => r.status === 204 ? null : r.json())`);
const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

const recRow = (text) => `[...document.querySelectorAll('table.recs tbody tr')].find((tr) => tr.textContent.includes(${JSON.stringify(text)}))`;
const drawer = `document.querySelector('aside.drawer[aria-label="Запись реестра"]')`;
const dialog = `document.querySelector('[role=dialog][aria-labelledby=scan-title]')`;
const cardField = (label) => `[...document.querySelectorAll('.recform > label')].find((l) => l.firstChild?.textContent === ${JSON.stringify(label)})`;
const tab = (name) => `[...document.querySelectorAll('.reg-bar [role=tab]')].find((b) => b.textContent === ${JSON.stringify(name)})`;
const startsWith = (prefix, within = 'document') => `[...(${within}).querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(prefix)}) && !b.disabled)`;

/** Каждый тест начинает с чистой страницы: полная загрузка, без открытых карточек и окон. */
async function openTab(name) {
  await ui.goto(`/registers?run=${Date.now()}#${regId}/${name}`);
  await ui.waitFor(`location.hash.endsWith('/${name}') && !!document.querySelector('.reg-bar')`, `вкладка ${name}`);
}

/**
 * Тестам таблицы и карточки нужен загруженный отчёт. Если тест импорта упал раньше применения,
 * отчёт загружается через API (те же предпросмотр и применение), чтобы остальные тесты проверяли своё.
 */
async function ensureReport() {
  if (reportId) return;
  const b64 = readFileSync(SAMPLE).toString('base64');
  const res = await ui.evaluate(`(async () => {
    const bin = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0));
    const prev = await fetch('/api/v1/registers/${regId}/scan-imports', { method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(${JSON.stringify(basename(SAMPLE))}) }, body: bin });
    if (prev.status !== 201) return { error: 'предпросмотр ' + prev.status + ' ' + await prev.text() };
    const { id } = await prev.json();
    const ap = await fetch('/api/v1/scan-imports/' + id + '/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    return ap.status === 200 ? ap.json() : { error: 'применение ' + ap.status + ' ' + await ap.text() };
  })()`);
  assert.ok(!res.error, `загрузка отчёта для теста: ${res.error}`);
  reportId = res.reportId;
}

before(async () => {
  assert.ok(LOGIN && PASSWORD, 'Задайте E2E_LOGIN и E2E_PASSWORD (пользователь с ролью «Супер-администратор»)');
  tmp = mkdtempSync(join(tmpdir(), 'ibportal-e2e-scan-'));
  const sampleBook = new ExcelJS.Workbook();
  await sampleBook.xlsx.readFile(SAMPLE_SRC);
  sampleBook.worksheets.find((w) => w.name.trim().toLowerCase() === 'хосты').getCell('A1').value = DEPT;
  SAMPLE = join(tmp, basename(SAMPLE_SRC));
  await sampleBook.xlsx.writeFile(SAMPLE);
  ui = await launchBrowser({ baseUrl: BASE });
  await ui.goto('/login');
  await ui.type(`document.querySelector('input[name=username]')`, LOGIN);
  await ui.type(`document.querySelector('input[name=password]')`, PASSWORD);
  await ui.click(`document.querySelector('form button[type=submit]')`);
  await ui.waitFor(`location.pathname !== '/login'`, 'вход');
  const list = await api('/api/v1/registers');
  for (const r of list.items) {
    const detail = await api(`/api/v1/registers/${r.id}`);
    if (detail.systemKey === 'vulns') regId = r.id;
  }
  assert.ok(regId, 'в dev-базе нет системного реестра уязвимостей — выполните миграции и seed');
  const last = await api(`/api/v1/registers/${regId}/records?sort=number&dir=desc&limit=1&includeArchived=true`);
  numberBefore = last.items[0]?.number ?? 0;
});

after(async () => {
  // Уборка: всё, что создал прогон, — в архив, даже если тест упал на середине.
  if (ui && regId) {
    const page = await api(`/api/v1/registers/${regId}/records?sort=number&dir=desc&limit=200`).catch(() => ({ items: [] }));
    const mine = page.items.filter((x) => x.number > numberBefore && !x.archived);
    // Задачи, которые автоматизации поставили по записям прогона, — тоже в архив.
    const ids = new Set(mine.map((r) => r.id));
    const tasks = await api('/api/v1/tasks?archived=false').catch(() => ({ items: [] }));
    for (const t of tasks.items.filter((x) => x.record && ids.has(x.record.id))) {
      await post(`/api/v1/tasks/${t.id}/archive`, { version: t.version }).catch(() => undefined);
    }
    for (const r of mine) {
      await post(`/api/v1/register-records/${r.id}/archive`, { version: r.version }).catch(() => undefined);
    }
    if (reportId) await post(`/api/v1/scan-reports/${reportId}/archive`).catch(() => undefined);
    if (ruleId) {
      const rules = await api(`/api/v1/registers/${regId}/automations?includeArchived=true`).catch(() => ({ items: [] }));
      const rule = rules.items.find((x) => x.id === ruleId);
      if (rule && !rule.archived) await post(`/api/v1/register-automations/${ruleId}/archive`, { version: rule.version }).catch(() => undefined);
    }
  }
  if (ui) {
    assert.deepEqual(ui.consoleErrors, [], 'ошибки JavaScript в странице');
    ui.close();
  }
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('Реестр уязвимостей', () => {
  it('импорт отчёта сканера: предпросмотр с датой из имени файла, хосты, применение одной транзакцией', async () => {
    await openTab('records');
    await ui.waitFor(`!!document.querySelector('input[aria-label="Файл импорта"]')`, 'кнопка «Импорт из Excel»');
    assert.equal(await ui.evaluate(`[...document.querySelectorAll('.io button')].filter((b) => b.textContent.startsWith('Импорт')).map((b) => b.textContent).join()`), 'Импорт из Excel', 'одна кнопка импорта');
    assert.ok(await ui.evaluate(`[...document.querySelectorAll('table.recs th')].some((th) => th.textContent.startsWith('Дней до срока'))`), 'колонка «Дней до срока»');

    let m = ui.mark();
    await ui.setFiles('input[aria-label="Файл импорта"]', [SAMPLE]);
    const prev = await ui.request(m, 'POST', `/registers/${regId}/file-imports`);
    assert.equal(prev.status, 201, prev.body);
    const detected = await ui.response(prev);
    assert.equal(detected.format, 'scan', 'файл распознан как отчёт сканера');
    const s = detected.scan.summary;
    assert.equal(s.created + s.merged, 90, 'все 90 уязвимостей образца — новые или дубли открытых записей');
    assert.deepEqual([s.hostsCount, s.reportDate, s.errorRows], [12, '2026-10-15', 0]);
    // Предпросмотр ничего не меняет.
    assert.deepEqual(ui.requestsSince(m).filter((r) => r.method !== 'GET' && !r.url.includes('/file-imports')), []);

    await ui.waitFor(`!!${dialog}?.querySelector('.imp-kpis')`, 'окно предпросмотра отчёта');
    assert.match(await ui.text(`${dialog}.querySelector('.imp-kind')`), /распознан как Отчёт сканера/);
    const kpis = await ui.evaluate(`[...${dialog}.querySelectorAll('.imp-kpis > div')].map((d) => d.textContent)`);
    assert.equal(kpis[0], `${s.created}новых`);
    assert.equal(kpis[1], `${s.merged}уже в реестре`);
    assert.equal(await ui.evaluate(`${dialog}.querySelector('input[aria-label="Дата отчёта"]').value`), '2026-10-15', 'дата отчёта из имени файла');
    assert.equal(await ui.evaluate(`${dialog}.querySelector('input[aria-label="Дата передачи в ДИКТ"]').value`), '2026-10-15', 'передача в ДИКТ — по умолчанию дата отчёта');
    await ui.click(`${dialog}.querySelector('details:last-of-type summary')`, 'список хостов');
    assert.match(await ui.text(dialog), /HOST-01/);

    m = ui.mark();
    // Если прошлый прогон не убрал за собой, все строки — дубли, и кнопка называется «Сохранить отчёт…».
    await ui.click(`${startsWith('Загрузить', dialog)} ?? ${startsWith('Сохранить отчёт', dialog)}`, 'кнопка «Загрузить»');
    const applied = await ui.request(m, 'POST', '/apply');
    assert.equal(applied.status, 200, applied.body);
    const result = await ui.response(applied);
    reportId = result.reportId;
    assert.equal(result.created, s.created);
    await ui.waitFor(`!${dialog}`, 'окно закрыто');
    await ui.waitFor(`document.querySelector('.toast.on')?.textContent.startsWith('Отчёт загружен')`, 'уведомление о загрузке');
    await ui.waitFor(`[...document.querySelectorAll('.scan-report summary')].some((x) => x.textContent.includes('15.10.2026') && x.textContent.includes('хостов: 12'))`, 'отчёт в списке отчётов');
  });

  it('контроль сроков: срочное сначала, метка «Дней до срока»', async () => {
    await ensureReport();
    await openTab('records');
    await ui.waitFor(`!!${recRow('CVE-2024-21413')}`, 'запись из отчёта в таблице');
    // Четвёртая колонка: галочка, №, CVE / БДУ, «Дней до срока».
    const firstChip = await ui.text(`document.querySelector('table.recs tbody tr td:nth-child(4) .chip')`);
    assert.match(firstChip, /^(Просрочено \d+ дн\.|Осталось \d+ дн\.|Срок сегодня|В срок · \d+ дн\.)$/);
    const states = await ui.evaluate(`[...document.querySelectorAll('table.recs tbody tr')].map((tr) => tr.querySelector('td:nth-child(4) .chip')?.className ?? '')`);
    const rank = (c) => (c.includes('crit') ? 0 : c.includes('high') ? 1 : c.includes('low') ? 2 : 3);
    assert.deepEqual(states.map(rank), [...states.map(rank)].sort((a, b) => a - b), 'просрочено → скоро → в срок');
  });

  it('карточка: оценка и критичность по п. 7.1, ручная критичность, «Считать автоматически», событие → задача', async () => {
    await ensureReport();
    await openTab('records');
    await ui.click(recRow('CVE-2024-21413'), 'строка CVE-2024-21413');
    await ui.waitFor(`!!${drawer}?.querySelector('.recform')`, 'карточка записи');
    // 9,8 × 1,00 (эксплуатируется) × 0,95 (исправление выпущено) = 9,31 → 9,4.
    assert.match(await ui.text(cardField('Оценка')), /9,4/);
    const crit = `${cardField('Критичность')}.querySelector('select')`;
    // Метка «вручную» — chip; в подсказке под полем тоже есть слово «вручную».
    const manualChip = `[...${cardField('Критичность')}.querySelectorAll('.chip')].some((c) => c.textContent === 'вручную')`;
    const critical = await ui.evaluate(`[...${crit}.options].find((o) => o.textContent === 'Критическая').value`);
    assert.equal(await ui.evaluate(`${crit}.value`), critical);

    const high = await ui.evaluate(`[...${crit}.options].find((o) => o.textContent === 'Высокая').value`);
    await ui.select(crit, high);
    let m = ui.mark();
    await ui.click($.button('Сохранить', drawer));
    const saved = await ui.request(m, 'PATCH', '/register-records/');
    assert.equal(saved.status, 200, saved.body);
    assert.equal((await ui.response(saved)).manualFieldIds.length, 1, 'критичность отмечена ручной');
    await ui.waitFor(manualChip, 'отметка «вручную»');

    m = ui.mark();
    await ui.click($.button('Считать автоматически', drawer));
    const auto = await ui.request(m, 'POST', '/auto/');
    assert.equal(auto.status, 200, auto.body);
    await ui.waitFor(`${crit}.value === ${JSON.stringify(critical)} && !${manualChip}`, 'критичность снова по Оценке');

    // Срок 29.10 (15.10 + 14): после импорта правило «за 3 дня» или «просрочено» создало событие,
    // и оно сразу стало задачами получателям (этап 5): в карточке — ссылки на задачи.
    const ev = `${drawer}.querySelector('.hist-item.ev')`;
    await ui.waitFor(`!!${ev}?.querySelector('a[href^="/tasks?task="]')`, 'событие автоматизации со ссылкой на задачу');
    await ui.click(`${ev}.querySelector('a[href^="/tasks?task="]')`, 'ссылка на задачу');
    await ui.waitFor(`location.pathname === '/tasks' && !!document.querySelector('aside.drawer[aria-label="Задача"] .dr-title')`, 'карточка задачи');
    const card = `document.querySelector('aside.drawer[aria-label="Задача"]')`;
    await ui.waitFor(`${card}.textContent.includes('CVE-2024-21413') && ${card}.textContent.includes('Реестр уязвимостей')`, 'задача связана с записью реестра');
    assert.match(await ui.text(`${card}.querySelector('.eyebrow')`), /Реестр, автоматизация реестра/);
    await ui.click($.button('Закрыть', card));
    await ui.waitFor(`!${card}`, 'карточка задачи закрыта');
  });

  it('«Компенсирующие меры» — многострочное поле: от 6 строк, растёт с текстом, больше 4000 символов с переносами', async () => {
    await ensureReport();
    await openTab('records');
    await ui.click(recRow('CVE-2024-21413'), 'строка CVE-2024-21413');
    await ui.waitFor(`!!${drawer}?.querySelector('.recform')`, 'карточка записи');
    const area = `${cardField('Компенсирующие меры')}?.querySelector('textarea')`;
    await ui.waitFor(`!!${area}`, 'многострочное поле');
    assert.equal(await ui.evaluate(`${area}.rows`), 6);
    assert.equal(await ui.evaluate(`${area}.maxLength`), 20000);
    const before = await ui.evaluate(`${area}.value`);
    const h0 = await ui.evaluate(`${area}.clientHeight`);

    const text = Array.from({ length: 250 }, (_, i) => `Шаг ${i + 1}: сегментация сети, правило межсетевого экрана`).join('\n');
    assert.ok(text.length > 4000 && text.length < 20000);
    await ui.type(area, text, '«Компенсирующие меры»');
    assert.ok(await ui.evaluate(`${area}.clientHeight`) > h0, 'поле выросло вместе с текстом');
    let m = ui.mark();
    await ui.click($.button('Сохранить', drawer));
    const saved = await ui.request(m, 'PATCH', '/register-records/');
    assert.equal(saved.status, 200, saved.body);
    const rec = await ui.response(saved);
    assert.equal(Object.values(rec.values).find((v) => typeof v === 'string' && v.startsWith('Шаг 1:')), text, 'текст с переносами сохранён целиком');

    // Вернуть как было: следующие тесты считают сроки по п. 7.3 без компенсирующих мер.
    await ui.waitFor(`${area}.value === ${JSON.stringify(text)}`, 'значение в форме');
    await ui.type(area, before, '«Компенсирующие меры»');
    m = ui.mark();
    await ui.click($.button('Сохранить', drawer));
    assert.equal((await ui.request(m, 'PATCH', '/register-records/')).status, 200);
    await ui.click($.button('Закрыть', drawer));
  });

  it('вкладка «Автоматизация»: системные правила п. 7.4, новое правило, «Проверить сейчас», журнал событий', async () => {
    await openTab('records');
    await ui.click(tab('Автоматизация'));
    await ui.waitFor(`location.hash.endsWith('/automation') && document.querySelectorAll('.rules-tbl tbody tr').length >= 3`, 'правила реестра');
    const text = await ui.text(`document.querySelector('.rules-tbl')`);
    assert.match(text, /«Срок устранения» просрочен на 10 раб\. дн\. и пусто «Компенсирующие меры»/);
    assert.match(text, /Уведомить: Руководитель ДИКТ, Владелец системы/);

    const form = `document.querySelector('form[aria-label="Новое правило"]')`;
    // Форма свёрнута в <details>, когда правила уже есть.
    await ui.waitFor(`!!${form}`, 'форма нового правила');
    if (await ui.evaluate(`${form}.closest('details')?.open === false`)) await ui.click(`${form}.closest('details').querySelector('summary')`, '«Новое правило»');
    await ui.select(`${form}.querySelector('[aria-label="Условие"]')`, 'equals');
    const statusField = await ui.evaluate(`[...${form}.querySelector('[aria-label="Поле условия"]').options].find((o) => o.textContent === 'Статус').value`);
    await ui.select(`${form}.querySelector('[aria-label="Поле условия"]')`, statusField);
    const inWork = await ui.evaluate(`[...${form}.querySelector('[aria-label="Значение условия"]').options].find((o) => o.textContent === 'В работе').value`);
    await ui.select(`${form}.querySelector('[aria-label="Значение условия"]')`, inWork);
    await ui.select(`${form}.querySelector('[aria-label="Действие"]')`, 'notify');
    await ui.click($.button('+ Начальник ИБ', form));
    let m = ui.mark();
    await ui.click($.button('Добавить правило', form));
    const created = await ui.request(m, 'POST', `/registers/${regId}/automations`, 'создание правила');
    assert.equal(created.status, 201, created.body);
    const rule = await ui.response(created);
    ruleId = rule.id;
    assert.equal(rule.when, '«Статус» = «В работе»');
    assert.match(rule.then, /^Уведомить: Ответственный, Начальник ИБ$/);
    await ui.waitFor(`document.querySelector('.rules-tbl')?.textContent.includes('«Статус» = «В работе»')`, 'новое правило в списке');

    m = ui.mark();
    await ui.click($.button('Проверить сейчас'));
    const run = await ui.request(m, 'POST', '/automations/run');
    assert.equal(run.status, 200);
    assert.equal((await ui.response(run)).ran, true);
    // Повторная проверка дублей не создаёт.
    m = ui.mark();
    await ui.click($.button('Проверить сейчас'));
    assert.equal((await ui.response(await ui.request(m, 'POST', '/automations/run'))).created, 0);
    await ui.waitFor(`document.querySelector('.events-tbl tbody tr') !== null`, 'журнал событий');

    // Тестовое правило — в архив тем же путём, что у пользователя.
    const row = `[...document.querySelectorAll('.rules-tbl tbody tr')].find((tr) => tr.textContent.includes('«Статус» = «В работе»'))`;
    // Окно «Задачи, созданные им (N)»: по умолчанию задачи остаются.
    await ui.click($.button('В архив', row));
    const dlg = `document.querySelector('.bulk-dialog')`;
    await ui.waitFor(`!!${dlg}?.querySelector('[data-testid=rule-tasks]')`, 'окно задач правила');
    m = ui.mark();
    await ui.click($.button('В архив', dlg), '«В архив» в окне');
    const archived = await ui.request(m, 'POST', `/register-automations/${ruleId}/archive`);
    assert.equal(archived.status, 200);
    assert.deepEqual(archived.json.tasks, { action: 'keep' });
    await ui.waitFor(`!${row}`, 'правило ушло в архив');
  });
});

describe('Импорт из Excel одной кнопкой', () => {
  const impDialog = `document.querySelector('[role=dialog][aria-labelledby=imp-title]')`;
  const upload = async (file) => {
    await openTab('records');
    const m = ui.mark();
    await ui.setFiles('input[aria-label="Файл импорта"]', [file]);
    return ui.request(m, 'POST', `/registers/${regId}/file-imports`);
  };
  const cancel = async (within) => {
    const m = ui.mark();
    await ui.click($.button('Отмена', within), '«Отмена»');
    assert.equal((await ui.request(m, 'POST', '/cancel')).status, 204);
    await ui.waitFor(`!${within}`, 'окно закрыто');
  };

  it('отчёт сканера без даты в имени: предпросмотр просит дату, без неё загрузить нельзя', async () => {
    const file = join(tmp, 'отчёт сканера.xlsx');
    copyFileSync(SAMPLE, file);
    const prev = await upload(file);
    assert.equal(prev.status, 201, prev.body);
    await ui.waitFor(`!!${dialog}?.querySelector('.imp-kpis')`, 'окно предпросмотра отчёта');
    assert.match(await ui.text(`${dialog}.querySelector('.imp-kind')`), /распознан как Отчёт сканера/);
    assert.equal(await ui.evaluate(`${dialog}.querySelector('input[aria-label="Дата отчёта"]').value`), '');
    assert.match(await ui.text(`${dialog}.querySelector('[role=alert]')`), /нет даты отчёта/);
    const submit = `[...${dialog}.querySelectorAll('button.primary')].find((b) => /^(Загрузить|Сохранить отчёт)/.test(b.textContent.trim()))`;
    assert.equal(await ui.evaluate(`${submit}.disabled`), true, 'без даты применить нельзя');
    await ui.evaluate(`(() => { const el = ${dialog}.querySelector('input[aria-label="Дата отчёта"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '2026-10-20');
      el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await ui.waitFor(`${submit}.disabled === false && !${dialog}.querySelector('[role=alert]')`, 'с датой — можно применить');
    await cancel(dialog);
  });

  it('«Сравнение»: подсказка «нет в этом отчёте», область по умолчанию — отдел; неполный скан; статус с подтверждением; фильтр «Отдел»', async () => {
    await ensureReport();
    const regDetail = await api(`/api/v1/registers/${regId}`);
    const fld = (key) => regDetail.fields.find((f) => f.systemKey === key);
    const deptOpt = fld('department').options.find((o) => o.label === DEPT);
    assert.ok(deptOpt, 'отдел прогона — значение поля «Отдел»');
    const mine = (await api(`/api/v1/registers/${regId}/records?f=${fld('department').id}:${deptOpt.id}&limit=100`)).items
      .find((r) => r.values[fld('cve').id] !== 'CVE-2024-21413');
    assert.ok(mine, 'запись прогона');
    const cve = mine.values[fld('cve').id];
    const pkg = fld('pkg').options.find((o) => o.id === mine.values[fld('pkg').id]).label;
    // Повторный отчёт того же отдела: без этой уязвимости и без первого хоста.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(SAMPLE);
    let host = '';
    for (const ws of wb.worksheets) {
      const drop = [];
      ws.eachRow((row, n) => {
        const cells = row.values.map((v) => String(v ?? ''));
        if (cells.includes(cve) && cells.includes(pkg)) drop.push(n);
        const h = cells.find((v) => /^HOST-\d+$/.test(v));
        if (h && !host) { host = h; drop.push(n); }
      });
      for (const n of drop.reverse()) ws.spliceRows(n, 1);
    }
    assert.ok(host, 'в образце есть хост');
    const file = join(tmp, 'scan-report-sample-2026-11-15.xlsx');
    await wb.xlsx.writeFile(file);

    const prev = await upload(file);
    assert.equal(prev.status, 201, prev.body);
    await ui.waitFor(`!!${dialog}?.querySelector('.imp-kpis')`, 'окно предпросмотра отчёта');
    await ui.waitFor(`${dialog}.querySelector('[data-testid=not-in-report]')?.textContent.startsWith('1 запись нет в этом отчёте')`, 'подсказка «нет в этом отчёте»');
    assert.match(await ui.text(`${dialog}.querySelector('[data-testid=not-in-report]')`), new RegExp(`отдел «${DEPT}», все системы`));
    await ui.click($.button('Сравнение', dialog), '«Сравнение»');
    const cmp = `document.querySelector('.compare-dialog')`;
    await ui.waitFor(`${cmp}?.textContent.includes('CVE / БДУ + Пакет')`, 'окно сравнения с ключом');
    assert.equal(await ui.evaluate(`[...${cmp}.querySelectorAll('label.check')].find((l) => l.textContent.includes('Записи реестра: отдел'))?.querySelector('input').checked`), true, 'по умолчанию — отдел отчёта');
    let m = ui.mark();
    await ui.click($.button('Сравнить', cmp));
    assert.equal((await ui.request(m, 'POST', '/compare')).status, 200);
    await ui.waitFor(`${cmp}.querySelector('[data-testid=compare-summary]')?.textContent.includes('Сравнить с записями реестра: отдел «${DEPT}»')`, 'подпись области');
    const row = `[...${cmp}.querySelectorAll('.compare-tbl tbody tr')].find((tr) => tr.textContent.includes(${JSON.stringify(cve)}))`;
    await ui.waitFor(`!!${row} && ${cmp}.querySelectorAll('.compare-tbl tbody tr').length === 1`, 'нет в файле — одна запись прогона');
    assert.match(await ui.text(`${cmp}.querySelector('[data-testid=incomplete-scan]')`), new RegExp(host));
    const fixed = await ui.evaluate(`[...${row}.querySelector('select').options].find((o) => o.textContent === 'Устранена').value`);
    await ui.select(`${row}.querySelector('select')`, fixed);
    await ui.click(startsWith('Проставить статус (1)', cmp), '«Проставить статус»');
    await ui.waitFor(`${cmp}?.querySelector('[data-testid=compare-preview]')?.textContent.includes('Изменится статус: 1 запись')`, 'предпросмотр');
    assert.equal(await ui.evaluate(`[...${cmp}.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Подтвердить').disabled`), true, 'без галочки неполного скана — нельзя');
    await ui.click(`[...${cmp}.querySelectorAll('label.check')].find((l) => l.textContent.includes('не все хосты'))?.querySelector('input')`, 'галочка неполного скана');
    m = ui.mark();
    await ui.click($.button('Подтвердить', cmp));
    const applied = await ui.request(m, 'POST', '/compare-status/apply');
    assert.equal(applied.status, 200, applied.body);
    await ui.waitFor(`!${cmp}`, 'окно сравнения закрыто');
    await cancel(dialog);

    const after = await api(`/api/v1/register-records/${mine.id}`);
    assert.equal(after.values[fld('status').id], fixed);
    const history = await api(`/api/v1/register-records/${mine.id}/history`);
    assert.ok(history.items.some((h) => h.via === 'compare'), 'в истории — сравнение с файлом');

    // Фильтр «Отдел» в таблице реестра.
    await openTab('records');
    await ui.select(`document.querySelector('select[aria-label="Фильтр: поле"]')`, fld('department').id);
    await ui.select(`document.querySelector('select[aria-label="Фильтр: значение"]')`, deptOpt.id);
    await ui.waitFor(`location.search.includes('f=') && document.querySelector('[data-testid=record-filter]')?.textContent.includes(${JSON.stringify(DEPT)})`, 'фильтр «Отдел»');
  });

  it('выгрузка реестра через ту же кнопку — обычный импорт по колонке ID', async () => {
    await openTab('records');
    const b64 = await ui.evaluate(`fetch('/api/v1/registers/${regId}/export').then((r) => r.arrayBuffer())
      .then((b) => { let s = ''; new Uint8Array(b).forEach((x) => { s += String.fromCharCode(x); }); return btoa(s); })`);
    const file = join(tmp, 'выгрузка реестра.xlsx');
    writeFileSync(file, Buffer.from(b64, 'base64'));
    const prev = await upload(file);
    assert.equal(prev.status, 201, prev.body);
    assert.equal((await ui.response(prev)).format, 'records');
    await ui.waitFor(`!!${impDialog}?.querySelector('.imp-kpis')`, 'окно предпросмотра выгрузки');
    assert.match(await ui.text(`${impDialog}.querySelector('.imp-kind')`), /распознан как Выгрузка реестра/);
    await cancel(impDialog);
  });

  it('файл неизвестного формата — понятная ошибка: что ожидалось и что найдено', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Лист1').addRow(['Имя', 'Дата', 'Сумма']);
    const file = join(tmp, 'что-то.xlsx');
    writeFileSync(file, Buffer.from(await wb.xlsx.writeBuffer()));
    const prev = await upload(file);
    assert.equal(prev.status, 400);
    await ui.waitFor(`document.querySelector('.toast.on')?.textContent.includes('Не удалось распознать файл')`, 'сообщение об ошибке');
    const msg = await ui.toast();
    assert.match(msg, /лист «Хосты» и лист с колонками «CVE» и «Пакет»/);
    assert.match(msg, /колонка «ID» или скрытый лист «_поля»/);
    assert.match(msg, /«Лист1»: «Имя», «Дата», «Сумма»/);
    assert.equal(await ui.evaluate(`!!document.querySelector('[role=dialog]')`), false, 'окно предпросмотра не открылось');
  });
});
