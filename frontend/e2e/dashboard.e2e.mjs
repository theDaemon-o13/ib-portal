// Сквозной тест этапа 8 тем же путём, что и браузер пользователя: Chrome → Vite (прокси /api) → backend → PostgreSQL.
// Дашборд: щелчок по KPI, плитке и строке виджета открывает реестр с тем же фильтром и тем же числом.
// Мониторинг: автолистание каждые 12 с, пауза, клавиши ← → и пробел, панель прячется без мыши,
// при потере связи данные остаются и видна плашка, после восстановления плашка исчезает.
//
//   npm run test:e2e   (логин и пароль — из frontend/.env.e2e или E2E_LOGIN / E2E_PASSWORD)
//
// Свои записи прогона помечены RUN и в конце уходят в архив, плитка удаляется (мягко).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { launchBrowser, sleep } from './browser.mjs';

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

async function api(method, path, body) {
  const res = await ui.evaluate(`fetch(${JSON.stringify(path)}, ${JSON.stringify(body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })})
    .then(async (r) => ({ status: r.status, text: await r.text() }))`);
  assert.ok(res.status >= 200 && res.status < 300, `${method} ${path} → ${res.status} ${res.text}`);
  return res.text ? JSON.parse(res.text) : null;
}

const iso = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const kpiCard = (label) => `[...document.querySelectorAll('.kpi')].find((k) => k.querySelector('.l')?.textContent === ${JSON.stringify(label)})`;
const recordsTotal = `Number((document.querySelector('.rec-tools .hint.mono')?.textContent ?? '').split(' из ')[1])`;
const monStep = `Number(document.querySelector('.mon')?.dataset.step)`;

before(async () => {
  assert.ok(LOGIN && PASSWORD, 'Задайте E2E_LOGIN и E2E_PASSWORD (пользователь с ролью «Супер-администратор»)');
  ui = await launchBrowser({ baseUrl: BASE });
  await ui.goto('/login');
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
  const crit = field('crit').options.find((o) => o.systemKey === 'critical');
  for (let i = 0; i < VULNS; i++) {
    const rec = await api('POST', `/api/v1/registers/${vulns.id}/records`, {
      values: {
        [field('cve').id]: `${RUN}-${String(i).padStart(2, '0')}`,
        [field('measures').id]: 'Сегментация сети (e2e)',
        [field('newDue').id]: iso(i - 3),
        ...(i % 2 === 0 ? { [field('crit').id]: crit.id } : {}),
      },
    });
    created.push(rec);
  }
});

after(async () => {
  try {
    for (const r of created) {
      const cur = await api('GET', `/api/v1/register-records/${r.id}`);
      if (!cur.archived) await api('POST', `/api/v1/register-records/${r.id}/archive`, { version: cur.version });
    }
    if (tileId) {
      const t = (await api('GET', '/api/v1/dashboard/tiles')).items.find((x) => x.id === tileId);
      if (t) await api('POST', `/api/v1/dashboard/tiles/${t.id}/delete`, { version: t.version });
    }
    assert.deepEqual(ui.consoleErrors, [], 'ошибки JavaScript на странице');
  } finally {
    ui?.close();
  }
});

describe('дашборд: переход по фильтру', () => {
  it('KPI «Уязвимости с просроченным сроком» открывает реестр с фильтром и тем же числом', async () => {
    // KPI кэшируются на сервере на минуту: ждём расчёт после того, как завели записи прогона.
    const since = Date.now();
    for (;;) {
      const k = await api('GET', '/api/v1/dashboard/kpis');
      if (Date.parse(k.computedAt) >= since - 1000) break;
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
    await ui.waitFor(`document.querySelector('.toast.on')?.textContent.includes('добавлена на дашборд')`, 'уведомление о плитке');
    await ui.click(`[...${drawer}.querySelectorAll('button')].find((b) => b.textContent === 'Закрыть')`, 'закрыть панель');

    const tile = `document.querySelector('[data-widget="tile:${tileId}"]')`;
    await ui.waitFor(`/^\\d+$/.test(${tile}?.querySelector('.v')?.textContent ?? '')`, 'число плитки');
    const value = Number(await ui.text(`${tile}.querySelector('.v')`));
    assert.ok(value >= VULNS / 2, `на плитке не меньше критических записей прогона: ${value}`);
    await ui.click(`${tile}.querySelector('a.v')`, 'число плитки');
    await ui.waitFor(`location.pathname === '/registers' && location.search.includes('f=')`, 'реестр с фильтром плитки');
    await ui.waitFor(`document.querySelector('[data-testid=record-filter]')?.textContent.includes('Критичность: Критическая')`, 'плашка «Критичность: Критическая»');
    assert.match(await ui.text(`document.querySelector('[data-testid=record-filter]')`), /Открытые/);
    await ui.waitFor(`${recordsTotal} === ${value}`, `total списка = числу плитки (${value})`);
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

describe('экран мониторинга', () => {
  it('листается сам каждые 12 с; пауза останавливает; ← → и пробел; панель прячется без мыши', async () => {
    await ui.goto('/monitor');
    await ui.waitFor(`document.querySelectorAll('.mon .mk').length === 8 && document.querySelectorAll('.mon .mrow').length > 0`, 'экран мониторинга с данными');
    assert.equal(await ui.evaluate(`document.documentElement.dataset.theme ?? ''`), 'dark', 'чёрная тема по умолчанию');
    assert.equal(await ui.evaluate(`document.documentElement.scrollHeight <= innerHeight`), true, 'без прокрутки');
    const pages = await ui.text(`document.querySelector('.mp-h .pg')`);
    assert.match(pages, /^стр\. 1 из \d+$/, 'уязвимости не помещаются на одну страницу');

    const t0 = Date.now();
    const step0 = await ui.evaluate(monStep);
    await ui.waitFor(`${monStep} === ${step0 + 1}`, 'автолистание', 15_000);
    const took = Date.now() - t0;
    assert.ok(took > 10_000 && took < 14_500, `перелистнулось через ${took} мс`);
    assert.match(await ui.text(`document.querySelector('.mp-h .pg')`), /^стр\. 2 из/);

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
    await ui.waitFor(`document.querySelectorAll('.mon .mk').length === 8`, 'экран мониторинга');
    const kpis = await ui.evaluate(`[...document.querySelectorAll('.mon .mk .v')].map((v) => v.textContent).join('|')`);
    const updated = await ui.text(`document.querySelector('.mon-foot span')`);

    await ui.failRequests('/api/v1/monitor');
    // Минутное обновление ускоряем возвратом на вкладку: TanStack Query перечитывает данные при фокусе.
    await ui.evaluate(`window.dispatchEvent(new Event('visibilitychange'))`);
    await ui.waitFor(`document.querySelector('.mon-offline')?.textContent.includes('Нет связи с сервером')`, 'плашка «Нет связи»', 15_000);
    assert.equal(await ui.evaluate(`[...document.querySelectorAll('.mon .mk .v')].map((v) => v.textContent).join('|')`), kpis, 'данные на экране остались');
    assert.equal(await ui.text(`document.querySelector('.mon-foot span')`), updated, 'время обновления — прежнее');
    assert.ok(await ui.evaluate(`document.querySelectorAll('.mon .mrow').length > 0`), 'список уязвимостей на месте');

    await ui.allowRequests();
    await ui.evaluate(`window.dispatchEvent(new Event('visibilitychange'))`);
    await ui.waitFor(`!document.querySelector('.mon-offline')`, 'плашка исчезла', 15_000);
  });

  it('Esc закрывает мониторинг и возвращает на дашборд', async () => {
    await ui.goto('/monitor');
    await ui.waitFor(`!!document.querySelector('.mon')`, 'экран мониторинга');
    await ui.press('Escape');
    await ui.waitFor(`location.pathname === '/dashboard'`, 'дашборд');
    assert.equal(await ui.evaluate(`document.documentElement.dataset.theme ?? ''`), '', 'тема вернулась к «Авто»');
  });
});
