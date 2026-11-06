// Сквозной тест этапа 8 тем же путём, что и браузер пользователя: Chrome → Vite (прокси /api) → backend → PostgreSQL.
// Дашборд: щелчок по KPI, плитке и строке виджета открывает реестр с тем же фильтром и тем же числом.
// Мониторинг: автолистание каждые 12 с, пауза, клавиши ← → и пробел, панель прячется без мыши,
// при потере связи данные остаются и видна плашка, после восстановления плашка исчезает.
//
//   npm run test:e2e   (логин и пароль — из frontend/.env.e2e или E2E_LOGIN / E2E_PASSWORD)
//
// Свои записи прогона помечены RUN и в конце уходят в архив, плитка удаляется (мягко).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { after, before, describe, it } from 'node:test';
import { $, launchBrowser, portalToday, sleep } from './browser.mjs';
import { cleanE2eGroups } from './vulns-cleanup.mjs';

const ExcelJS = createRequire(new URL('../../backend/package.json', import.meta.url))('exceljs');

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const LOGIN = process.env.E2E_LOGIN;
const PASSWORD = process.env.E2E_PASSWORD;
const RUN = `E2E-${Date.now().toString(36)}`;
const VULNS = 14;

let ui;
let vulns;
let field;
const created = [];
let tileId = null;
// Когда заведена последняя запись прогона: KPI, посчитанные раньше, их не учитывают.
let seededAt = 0;

async function api(method, path, body) {
  const res = await ui.evaluate(`fetch(${JSON.stringify(path)}, ${JSON.stringify(body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })})
    .then(async (r) => ({ status: r.status, text: await r.text() }))`);
  assert.ok(res.status >= 200 && res.status < 300, `${method} ${path} → ${res.status} ${res.text}`);
  return res.text ? JSON.parse(res.text) : null;
}

const iso = (days) => portalToday(days);
const kpiCard = (label) => `[...document.querySelectorAll('.kpi')].find((k) => k.querySelector('.l')?.textContent === ${JSON.stringify(label)})`;
const recordsTotal = `Number((document.querySelector('.rec-tools .hint.mono')?.textContent ?? '').split(' из ')[1])`;
const monStep = `Number(document.querySelector('.mon')?.dataset.step)`;

before(async () => {
  assert.ok(LOGIN && PASSWORD, 'Задайте E2E_LOGIN и E2E_PASSWORD (пользователь с ролью «Супер-администратор»)');
  ui = await launchBrowser({ baseUrl: BASE });
  await ui.goto('/login');
  // Подпись автора с версией сборки — и на странице входа.
  await ui.waitFor(`document.querySelector('.auth-wrap .credit')?.textContent.includes('Разработал: Машарипов Искандар')`, 'подпись на странице входа');
  await ui.type(`document.querySelector('input[name=username]')`, LOGIN);
  await ui.type(`document.querySelector('input[name=password]')`, PASSWORD);
  await ui.click(`document.querySelector('form button[type=submit]')`);
  await ui.waitFor(`location.pathname !== '/login'`, 'вход');

  // В списке реестров нет systemKey — он в карточке реестра.
  for (const r of (await api('GET', '/api/v1/registers')).items) {
    const detail = await api('GET', `/api/v1/registers/${r.id}`);
    if (detail.systemKey === 'vulns') vulns = detail;
  }
  assert.ok(vulns, 'нет реестра уязвимостей');
  field = (key) => vulns.fields.find((f) => f.systemKey === key);
  // Уязвимости прогона: срок из решения ИБ (п. 7.3) — от −3 до +10 дней; половина критические.
  // Записи появляются только из скана (релиз 1.5.0, ADR-0029): своя группа прогона, скан, затем решение ИБ в карточке.
  const type = (await api('GET', '/api/v1/catalogs/system_types/items')).items[0];
  const group = await api('POST', '/api/v1/vulns/groups', { name: `${RUN} дашборд`, kind: 'service', systemTypeIds: [type.id] });
  const nodeId = group.nodes[0].id;
  const book = new ExcelJS.Workbook();
  const ws = book.addWorksheet('Находки');
  ws.addRow(['Пакет', 'CVE', 'Уровень', 'CVSS']);
  for (let i = 0; i < VULNS; i++) ws.addRow([`Пакет ${RUN}`, `${RUN}-${String(i).padStart(2, '0')}`, 'Важная', 5]);
  const b64 = Buffer.from(await book.xlsx.writeBuffer()).toString('base64');
  const applied = await ui.evaluate(`(async () => {
    const bin = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0));
    const prev = await fetch('/api/v1/vulns/nodes/${nodeId}/scan-imports', { method: 'POST',
      headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'X-File-Name': encodeURIComponent('dashboard-e2e.xlsx') }, body: bin });
    if (prev.status !== 201) return { error: 'предпросмотр ' + prev.status + ' ' + await prev.text() };
    const { id } = await prev.json();
    const ap = await fetch('/api/v1/vulns/scan-imports/' + id + '/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scanDate: ${JSON.stringify(portalToday())} }) });
    return ap.status === 200 ? ap.json() : { error: 'применение ' + ap.status + ' ' + await ap.text() };
  })()`);
  assert.ok(!applied.error, `скан прогона: ${applied.error}`);
  const page = await api('GET', `/api/v1/vulns/nodes/${nodeId}/records?state=all&limit=200`);
  const crit = field('crit').options.find((o) => o.systemKey === 'critical');
  for (const r of page.items) {
    const i = Number(r.values[field('cve').id].split('-').pop());
    const rec = await api('PATCH', `/api/v1/register-records/${r.id}`, {
      version: r.version,
      values: {
        [field('measures').id]: 'Сегментация сети (e2e)',
        [field('newDue').id]: iso(i - 3),
        ...(i % 2 === 0 ? { [field('crit').id]: crit.id } : {}),
      },
    });
    created.push(rec);
  }
  seededAt = Date.now();
});

after(async () => {
  try {
    if (tileId) {
      const t = (await api('GET', '/api/v1/dashboard/tiles')).items.find((x) => x.id === tileId);
      if (t) await api('POST', `/api/v1/dashboard/tiles/${t.id}/delete`, { version: t.version });
    }
    assert.deepEqual(ui.consoleErrors, [], 'ошибки JavaScript на странице');
  } finally {
    ui?.close();
    await cleanE2eGroups();
  }
});

describe('дашборд: переход по фильтру', () => {
  it('KPI «Уязвимости с просроченным сроком» открывает реестр с фильтром и тем же числом', async () => {
    // KPI кэшируются на сервере на минуту: ждём расчёт, начатый после последней записи прогона. Дашборд
    // открывается сразу после входа и запрашивает KPI, пока before ещё заводит записи, — такой кэш не годится.
    const since = Date.now();
    for (;;) {
      const k = await api('GET', '/api/v1/dashboard/kpis');
      if (Date.parse(k.computedAt) > seededAt) break;
      assert.ok(Date.now() - since < 70_000, 'KPI не пересчитались за минуту');
      await sleep(3000);
    }
    await ui.goto('/dashboard');
    await ui.waitFor(`${kpiCard('Уязвимости с просроченным сроком')}?.querySelector('.v')?.textContent !== '—'`, 'KPI');
    const value = Number(await ui.text(`${kpiCard('Уязвимости с просроченным сроком')}.querySelector('.v')`));
    assert.ok(value >= 3, `просрочено не меньше трёх записей прогона, на KPI ${value}`);

    await ui.click(kpiCard('Уязвимости с просроченным сроком'), 'KPI просроченных');
    await ui.waitFor(`location.pathname === '/registers' && location.hash.startsWith('#${vulns.id}')`, 'реестр уязвимостей');
    assert.match(await ui.evaluate('location.search'), /deadline=overdue/);
    await ui.waitFor(`document.querySelector('[data-testid=record-filter]')?.textContent.includes('Просрочено')`, 'плашка фильтра');
    await ui.waitFor(`${recordsTotal} >= 0 && document.querySelectorAll('tbody tr.rec-row').length > 0`, 'записи по фильтру');
    assert.equal(await ui.evaluate(recordsTotal), value, 'число на KPI = total списка по ссылке');
    assert.ok(await ui.evaluate(`[...document.querySelectorAll('tbody tr.rec-row')].some((tr) => tr.textContent.includes('${RUN}-00'))`), 'запись прогона в списке');

    // Крестик снимает фильтр, реестр остаётся открытым.
    await ui.click(`document.querySelector('[data-testid=record-filter] button')`, 'снять фильтр');
    await ui.waitFor(`!document.querySelector('[data-testid=record-filter]') && location.hash.startsWith('#${vulns.id}') && !location.search.includes('deadline')`, 'фильтр снят');
  });

  it('плитка: добавить в панели «Плитки», щелчок по числу открывает реестр с тем же фильтром', async () => {
    await ui.goto('/dashboard');
    await ui.click(`[...document.querySelectorAll('.head button')].find((b) => b.textContent === 'Плитки')`, 'кнопка «Плитки»');
    const drawer = `document.querySelector('aside.drawer[aria-label="Плитки дашборда"]')`;
    await ui.waitFor(`!!${drawer}`, 'панель плиток');
    const sel = (text) => `[...${drawer}.querySelectorAll('label')].find((l) => l.firstChild?.textContent?.trim() === ${JSON.stringify(text)})?.querySelector('select, input')`;
    // Список реестров приходит отдельным запросом: выбрать можно только когда вариант уже есть, иначе value не встанет.
    await ui.waitFor(`[...(${sel('Реестр')})?.options ?? []].some((o) => o.value === '${vulns.id}')`, 'реестр в списке');
    await ui.select(sel('Реестр'), vulns.id);
    await ui.waitFor(`[...${sel('Поле')}.options].some((o) => o.value === '${field('crit').id}')`, 'поля реестра');
    await ui.select(sel('Поле'), field('crit').id);
    await ui.click(`[...${drawer}.querySelectorAll('.opts label')].find((l) => l.textContent.trim() === 'Критическая')`, 'значение «Критическая»');
    await ui.type(sel('Название плитки'), `${RUN} Критические`);
    const mark = ui.mark();
    await ui.click(`[...${drawer}.querySelectorAll('button')].find((b) => b.textContent === 'Добавить плитку')`, 'Добавить плитку');
    const req = await ui.request(mark, 'POST', '/api/v1/dashboard/tiles');
    assert.equal(req.status, 201);
    tileId = (await ui.response(req)).id;
    // Ждём не всплывающее сообщение (оно живёт 3 с) и не число на экране, а ответы API: данные плитки — запрос
    // widgets/tile:<id> после создания, список записей — запрос records после перехода.
    const data = await ui.request(mark, 'GET', `/api/v1/dashboard/widgets/${encodeURIComponent(`tile:${tileId}`)}`, 'данные плитки');
    assert.equal(data.status, 200, data.body);
    const value = (await ui.response(data)).total;
    assert.ok(value >= VULNS / 2, `на плитке не меньше критических записей прогона: ${value}`);
    await ui.click(`[...${drawer}.querySelectorAll('button')].find((b) => b.textContent === 'Закрыть')`, 'закрыть панель');

    const tile = `document.querySelector('[data-widget="tile:${tileId}"]')`;
    await ui.waitFor(`${tile}?.querySelector('.v')?.textContent === ${JSON.stringify(String(value))}`, 'число плитки = ответу API');
    const open = ui.mark();
    await ui.click(`${tile}.querySelector('a.v')`, 'число плитки');
    await ui.waitFor(`location.pathname === '/registers' && location.search.includes('f=')`, 'реестр с фильтром плитки');
    const list = await ui.request(open, 'GET', `/api/v1/registers/${vulns.id}/records`, 'список записей с фильтром плитки');
    assert.equal((await ui.response(list)).total, value, 'total списка = числу плитки');
    await ui.waitFor(`document.querySelector('[data-testid=record-filter]')?.textContent.includes('Критичность: Критическая')`, 'плашка «Критичность: Критическая»');
    assert.match(await ui.text(`document.querySelector('[data-testid=record-filter]')`), /Открытые/);
    await ui.waitFor(`${recordsTotal} === ${value}`, `total на экране = числу плитки (${value})`);
  });

  it('строка виджета «Критичность» ведёт в реестр с фильтром по значению', async () => {
    await ui.goto('/dashboard');
    const w = `document.querySelector('[data-widget="field:${field('crit').id}"]')`;
    const bar = `[...(${w}?.querySelectorAll('a.bar-link') ?? [])].find((a) => a.querySelector('.t')?.textContent === 'Критическая')`;
    await ui.click(bar, 'строка «Критическая»');
    await ui.waitFor(`location.pathname === '/registers' && decodeURIComponent(location.search).includes('f=${field('crit').id}:')`, 'фильтр по значению');
    await ui.waitFor(`document.querySelector('[data-testid=record-filter]')?.textContent.includes('Критичность: Критическая')`, 'плашка фильтра');
  });
});

describe('дашборд: «Настроить» (релиз 1.1.0)', () => {
  it('скрыть KPI, перетащить виджет, размер L, «Готово» — после перезагрузки так же; «Сбросить» — как было', async () => {
    // Своя раскладка прогона — с чистого листа.
    await api('POST', '/api/v1/dashboard/layout/reset');
    await ui.goto('/dashboard');
    const cells = (sel) => `[...document.querySelectorAll('${sel} > .lay-cell')]`;
    await ui.waitFor(`${cells('.dash')}.length >= 2 && ${cells('.kpis')}.length >= 2`, 'дашборд');
    const kpiKey = await ui.evaluate(`${cells('.kpis')}[1].dataset.layoutKey`);
    const [w1, w2] = await ui.evaluate(`${cells('.dash')}.slice(0, 2).map((c) => c.dataset.layoutKey)`);
    const cell = (key) => `document.querySelector('[data-layout-key="${key}"]')`;

    await ui.click($.button('Настроить'), '«Настроить»');
    await ui.waitFor(`!!document.querySelector('.lay-bar')`, 'режим настройки');
    await ui.click($.button('Скрыть', cell(kpiKey)), 'скрыть KPI');
    await ui.waitFor(`!${cell(kpiKey)} && !!document.querySelector('.lay-hidden')`, 'KPI в «Скрытых»');
    // Оба виджета на экране до нажатия: иначе drag прокрутит к цели и нажмёт по устаревшим координатам ручки.
    await ui.evaluate(`${cell(w1)}.scrollIntoView({ block: 'start' })`);
    await ui.drag(`${cell(w2)}.querySelector('.lay-handle')`, cell(w1), 'перетащить второй виджет на место первого');
    await ui.waitFor(`${cells('.dash')}[0]?.dataset.layoutKey === ${JSON.stringify(w2)}`, 'виджет перенесён');
    await ui.click($.button('L', cell(w2)), 'размер L');
    const m = ui.mark();
    await ui.click($.button('Готово'), '«Готово»');
    assert.equal((await ui.request(m, 'PUT', '/dashboard/layout')).status, 200);

    await ui.goto('/dashboard');
    await ui.waitFor(`${cells('.dash')}.length >= 2`, 'дашборд после перезагрузки');
    assert.equal(await ui.evaluate(`${cells('.dash')}[0].dataset.layoutKey`), w2, 'порядок сохранён');
    assert.ok(await ui.evaluate(`${cell(w2)}.classList.contains('w12')`), 'размер L — вся ширина');
    assert.ok(await ui.evaluate(`!${cell(kpiKey)}`), 'KPI скрыт');

    await ui.click($.button('Настроить'), '«Настроить»');
    const r = ui.mark();
    await ui.click($.button('Сбросить'), '«Сбросить»');
    assert.equal((await ui.request(r, 'POST', '/dashboard/layout/reset')).status, 200);
    await ui.waitFor(`!document.querySelector('.lay-bar') && !!${cell(kpiKey)} && ${cells('.dash')}[0]?.dataset.layoutKey === ${JSON.stringify(w1)}`, 'раскладка по умолчанию');
  });
});

describe('подпись автора и «О портале»', () => {
  it('внизу меню — «designed by», подпись автора и версия (1.13.0); щелчок по версии — окно только с версией и подписью (1.6.4)', async () => {
    await ui.goto('/dashboard');
    const credit = `document.querySelector('.rail .credit')`;
    await ui.waitFor(`!!${credit}`, 'подпись в меню');
    // E2E_EXPECT_VERSION — при проверке архива релиза: версия берётся из сборки, а не вписана в код.
    const version = process.env.E2E_EXPECT_VERSION;
    assert.equal(await ui.text(`${credit}.querySelector('.credit-by')`), 'designed by');
    assert.equal(await ui.evaluate(`${credit}.querySelector('.sig[role=img]')?.getAttribute('aria-label')`), 'Iskandar Masharipov');
    assert.match(await ui.text(`${credit}.querySelector('.credit-v')`), version ? new RegExp(`^Портал ИБ Версия ${version.replace(/\./g, '\\.')}`) : /^Портал ИБ Версия \S+/);
    assert.match(await ui.text(`${credit}.querySelector('.credit-a')`), /^Разработал: Машарипов Искандар$/);
    await ui.click(`${credit}.querySelector('.credit-v')`, 'версия');
    const dlg = `document.querySelector('[role=dialog][aria-labelledby=about-title]')`;
    await ui.waitFor(`!!${dlg}`, 'окно «О портале»');
    const rows = await ui.evaluate(`Object.fromEntries([...${dlg}.querySelectorAll('dt')].map((dt) => [dt.textContent, dt.nextElementSibling.textContent]))`);
    assert.deepEqual(Object.keys(rows), ['Версия', 'Разработал']);
    assert.equal(rows['Разработал'], 'Машарипов Искандар');
    assert.equal(await ui.text(`${dlg}.querySelector('h2')`), 'Портал ИБ');
    if (version) assert.equal(rows['Версия'], version);
    await ui.press('Escape');
    await ui.waitFor(`!${dlg}`, 'окно закрыто по Esc');
    // Узкий экран (1.13.0): меню — по кнопке «Меню», в нём версия; страница без горизонтальной прокрутки.
    await ui.viewport(390, 844);
    assert.equal(await ui.evaluate(`document.documentElement.scrollWidth <= innerWidth`), true, 'без горизонтальной прокрутки');
    await ui.click(`document.querySelector('button.rail-toggle')`, 'кнопка «Меню»');
    await ui.waitFor(`document.querySelector('.app').classList.contains('menu-open') && ${credit}.querySelector('.credit-v').getBoundingClientRect().right > 0`, 'меню открыто, версия видна');
    await ui.press('Escape');
    await ui.waitFor(`!document.querySelector('.app').classList.contains('menu-open')`, 'меню закрыто по Esc');
    await ui.viewport(1440, 1000);
  });
});

describe('экран мониторинга', () => {
  it('слайды по 12 с: KPI, затем уязвимости; пауза останавливает; ← → и пробел; панель прячется без мыши', async () => {
    await ui.goto('/monitor');
    // Первый слайд набора по умолчанию — «Ключевые показатели» (8 KPI стены).
    await ui.waitFor(`document.querySelectorAll('.mon .mon-kpis-big .mk').length === 8`, 'экран мониторинга с данными');
    assert.equal(await ui.evaluate(`document.documentElement.dataset.theme ?? ''`), 'black', '«Чёрный океан» по умолчанию');
    assert.equal(await ui.evaluate(`document.documentElement.scrollHeight <= innerHeight`), true, 'без прокрутки');
    assert.equal(await ui.evaluate(`!!document.querySelector('.credit')`), false, 'на мониторе подписи нет');

    const t0 = Date.now();
    const step0 = await ui.evaluate(monStep);
    await ui.waitFor(`${monStep} === ${step0 + 1}`, 'автолистание', 15_000);
    const took = Date.now() - t0;
    assert.ok(took > 10_000 && took < 14_500, `перелистнулось через ${took} мс`);
    await ui.waitFor(`document.querySelector('.mon-slide')?.dataset.slide === 'vulns' && document.querySelectorAll('.mon .mrow').length > 0`, 'второй слайд — уязвимости');

    // Панель управления видна при движении мыши; пауза — щелчком.
    await ui.moveMouse(700, 500);
    await ui.waitFor(`!document.body.classList.contains('mon-idle')`, 'панель видна');
    await ui.click(`document.querySelector('.mon-ctl button[aria-label="Пауза"]')`, 'Пауза');
    await ui.waitFor(`document.querySelector('.mon').dataset.paused === 'true'`, 'на паузе');
    assert.match(await ui.text(`document.querySelector('.mon-foot span:last-child')`), /на паузе/);
    const paused = await ui.evaluate(monStep);
    // Без движения мыши панель прячется через 3,5 с.
    await ui.waitFor(`document.body.classList.contains('mon-idle')`, 'панель спряталась', 6000);
    await sleep(13_000);
    assert.equal(await ui.evaluate(monStep), paused, 'на паузе не листается');

    await ui.press('Space');
    await ui.waitFor(`document.querySelector('.mon').dataset.paused === 'false'`, 'пробел — продолжить');
    assert.equal(await ui.evaluate(`document.body.classList.contains('mon-idle')`), false, 'клавиша показывает панель');
    await ui.press('ArrowRight');
    assert.equal(await ui.evaluate(monStep), paused + 1, '→ — вперёд');
    await ui.press('ArrowLeft');
    await ui.press('ArrowLeft');
    assert.equal(await ui.evaluate(monStep), paused - 1, '← — назад');
    await ui.click(`document.querySelector('.mon-ctl button[aria-label="Следующая страница"]')`, 'Вперёд');
    assert.equal(await ui.evaluate(monStep), paused, 'кнопка «вперёд»');
  });

  it('без связи с сервером данные остаются и видна плашка; после восстановления плашка исчезает', async () => {
    await ui.goto('/monitor');
    await ui.waitFor(`document.querySelectorAll('.mon .mon-kpis-big .mk').length === 8`, 'экран мониторинга');
    const kpis = await ui.evaluate(`[...document.querySelectorAll('.mon .mk .v')].map((v) => v.textContent).join('|')`);
    const updated = await ui.text(`document.querySelector('.mon-foot span')`);

    // Минутное обновление ускоряем возвратом на вкладку: TanStack Query перечитывает данные при фокусе — но только
    // если прежний запрос уже завершён (иначе присоединится к нему, и блокировка не сработает).
    await ui.settled('/api/v1/monitor');
    await ui.failRequests('/api/v1/monitor');
    try {
      await ui.evaluate(`window.dispatchEvent(new Event('visibilitychange'))`);
      await ui.waitFor(`document.querySelector('.mon-offline')?.textContent.includes('Нет связи с сервером')`, 'плашка «Нет связи»', 15_000);
      assert.equal(await ui.evaluate(`[...document.querySelectorAll('.mon .mk .v')].map((v) => v.textContent).join('|')`), kpis, 'данные на экране остались');
      assert.equal(await ui.text(`document.querySelector('.mon-foot span')`), updated, 'время обновления — прежнее');
      assert.ok(await ui.evaluate(`!!document.querySelector('.mon-slide')`), 'слайд на месте');
    } finally {
      // Блокировка не переживает тест, даже упавший: иначе следующие падают на «Failed to fetch».
      await ui.allowRequests();
    }
    await ui.settled('/api/v1/monitor');
    await ui.evaluate(`window.dispatchEvent(new Event('visibilitychange'))`);
    await ui.waitFor(`!document.querySelector('.mon-offline')`, 'плашка исчезла', 15_000);
  });

  it('новый слайд из настроек — без перезагрузки, на границе слайда; своё время показа; предпросмотр в настройках', async () => {
    const title = `${RUN} просроченные задачи`;
    const created = [];
    try {
      await ui.goto('/monitor');
      await ui.waitFor(`!!document.querySelector('.mon-slide')`, 'экран мониторинга');
      const before = await ui.evaluate(`document.querySelector('.mon-ctl .mon-pg .mono').textContent`);
      created.push(await api('POST', '/api/v1/monitor/slides', { kind: 'tasks', title, seconds: 5, filter: { period: 'overdue' }, enabled: true, skipEmpty: false }));
      // Обновление раз в минуту ускоряем возвратом на вкладку; набор меняется только на границе слайда.
      await ui.evaluate(`window.dispatchEvent(new Event('visibilitychange'))`);
      await sleep(1500);
      assert.equal(await ui.evaluate(`document.querySelector('.mon-ctl .mon-pg .mono').textContent`), before, 'посреди слайда набор не меняется');
      await ui.press('ArrowRight');
      await ui.waitFor(`document.querySelector('.mon').dataset.slideIndex === '0'`, 'новый набор — с первого слайда');
      await ui.press('ArrowLeft');
      await ui.waitFor(`document.querySelector('.mon-slide-h h2')?.textContent === ${JSON.stringify(title)}`, 'новый слайд — последний');
      assert.match(await ui.text(`document.querySelector('.mon-foot span:last-child')`), /каждые 5 с/);
      const t0 = Date.now();
      await ui.waitFor(`document.querySelector('.mon-slide-h h2')?.textContent !== ${JSON.stringify(title)}`, 'слайд сменился сам', 9000);
      const took = Date.now() - t0;
      assert.ok(took > 3000 && took < 7000, `слайд показан ${took} мс, ожидалось около 5 с`);

      // Настройки: слайд в списке, предпросмотр — так же, как на мониторе.
      await ui.goto('/settings/monitor');
      const row = `document.querySelector('[data-slide-id="${created[0].id}"]')`;
      await ui.waitFor(`!!${row}`, 'слайд в настройках');
      await ui.click(`[...${row}.querySelectorAll('button')].find((b) => b.textContent === 'Предпросмотр')`, '«Предпросмотр»');
      await ui.waitFor(`document.querySelector('[aria-label="Предпросмотр слайда"] .mon-slide-h h2')?.textContent === ${JSON.stringify(title)}`, 'предпросмотр слайда');
      await ui.press('Escape');
      await ui.waitFor(`!document.querySelector('[aria-label="Предпросмотр слайда"]')`, 'предпросмотр закрыт');
    } finally {
      for (const s of created) await api('POST', `/api/v1/monitor/slides/${s.id}/delete`, { version: s.version }).catch(() => undefined);
    }
  });

  it('Esc закрывает мониторинг и возвращает на дашборд', async () => {
    await ui.goto('/monitor');
    await ui.waitFor(`!!document.querySelector('.mon')`, 'экран мониторинга');
    await ui.press('Escape');
    await ui.waitFor(`location.pathname === '/dashboard'`, 'дашборд');
    assert.equal(await ui.evaluate(`document.documentElement.dataset.theme ?? ''`), '', 'тема вернулась к «Авто»');
  });
});
