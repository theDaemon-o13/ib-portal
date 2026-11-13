// Сквозной тест системных цепочек автозадач реестров (1.14.0, ADR-0053): 52 синтетических напоминания по двум группам
// «Уязвимостей» → в Backlog две карточки цепочек; «Взять себе» на одной задаче → в «Поставленные» карточка той же
// цепочки с одной задачей; «Взять себе все» с подтверждением; панель системной цепочки без правки; ссылка
// «Задачи: N активных» со страницы группы; блок «Цепочка» в карточке задачи. Данные вымышленные: группы «E2E-…»,
// CVE-2099-NNNNN — файл собирается из образца сканера, идентификаторы заменяются.
//
//   npm run test:e2e -- e2e/system-chains.e2e.mjs
//
// В конце: правило напоминания — в архив, группы прогона с задачами и цепочками удаляет vulns-cleanup.mjs.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { launchBrowser, portalToday } from './browser.mjs';
import { cleanE2eGroups } from './vulns-cleanup.mjs';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const LOGIN = process.env.E2E_LOGIN;
const PASSWORD = process.env.E2E_PASSWORD;
const RUN = `E2E-${Date.now().toString(36)}`;
const SAMPLE = fileURLToPath(new URL('../../backend/test/fixtures/vuln-windows-2026-10-15.xlsx', import.meta.url));
const ExcelJS = createRequire(new URL('../../backend/package.json', import.meta.url))('exceljs');
const PER_GROUP = 26;

let ui;
let tmp;
let rule;
const groups = {};

const api = (path, init) => ui.evaluate(`fetch(${JSON.stringify(path)}, ${JSON.stringify(init ?? {})}).then(async (r) => ({ status: r.status, body: r.status === 204 ? null : await r.json() }))`);
async function call(method, path, body) {
  const r = await api(path, body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.ok(r.status >= 200 && r.status < 300, `${method} ${path} → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
const q = (s) => `document.querySelector(${JSON.stringify(s)})`;
const button = (text, within = 'document') => `[...(${within}).querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)} && !b.disabled)`;
const startsWith = (text, within = 'document') => `[...(${within}).querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(text)}) && !b.disabled)`;
const col = (key) => `document.querySelector('.board .col[data-status="' + (window.__cols?.[${JSON.stringify(key)}] ?? '') + '"]')`;
const chainCard = (colExpr, title) => `(${colExpr})?.querySelector(${JSON.stringify(`[data-chain="${title}"]`)})`;
let cols = {};

async function open(path, ready, what) {
  await ui.goto(`${path}${path.includes('?') ? '&' : '?'}run=${Date.now()}`);
  await ui.waitFor(ready, what);
}
async function openBoard() {
  await open('/tasks', `document.querySelectorAll('.board .col').length >= 5`, 'доска');
  await ui.evaluate(`window.__cols = ${JSON.stringify(cols)}`);
}

/**
 * Образец сканера → новый файл: лист хостов как есть, на листе находок — первые PER_GROUP строк с CVE-2099-NNNNN
 * (тег группы в номере). Значения копируются (формулы — результатом): exceljs не вырезает строки с общими формулами.
 */
async function syntheticScan(tag) {
  const src = new ExcelJS.Workbook();
  await src.xlsx.readFile(SAMPLE);
  const out = new ExcelJS.Workbook();
  const plain = (v) => (v && typeof v === 'object' && 'result' in v ? v.result : v && typeof v === 'object' && 'formula' in v ? null : v);
  for (const ws of src.worksheets) {
    const to = out.addWorksheet(ws.name);
    let cveCol = 0;
    ws.getRow(1).eachCell((cell, c) => {
      const v = String(cell.value ?? '').trim().toLowerCase();
      if (v === 'cve' || v.startsWith('идентификатор')) cveCol = c;
    });
    const last = cveCol ? Math.min(ws.rowCount, 1 + PER_GROUP) : ws.rowCount;
    for (let r = 1; r <= last; r++) {
      const values = (ws.getRow(r).values ?? []).map(plain);
      if (cveCol && r > 1) values[cveCol] = `CVE-2099-${tag}${String(r - 1).padStart(3, '0')}`;
      to.getRow(r).values = values;
    }
  }
  const file = join(tmp, `vuln-windows-${portalToday()}-${tag}.xlsx`);
  await out.xlsx.writeFile(file);
  return file;
}

async function groupWithScan(name, tag) {
  const types = (await call('GET', '/api/v1/catalogs/system_types/items')).items;
  const windows = types.find((t) => t.value === 'Windows');
  const g = await call('POST', '/api/v1/vulns/groups', { name, kind: tag === '10' ? 'service' : 'department', systemTypeIds: [windows.id] });
  const node = g.nodes[0];
  await open(`/vulns/node/${node.id}`, `!!${button('Импорт скана')}`, 'экран узла');
  await ui.click(button('Импорт скана'));
  await ui.waitFor(`!!${q('[role=dialog][aria-label="Импорт скана"]')}`, 'окно импорта');
  await ui.setFiles('[role=dialog] input[type=file]', [await syntheticScan(tag)]);
  await ui.waitFor(`!!document.querySelector('[role=dialog] .v-dcards')`, 'предпросмотр', 20_000);
  await ui.click(`document.querySelector('[role=dialog] .btn.primary')`, 'Загрузить');
  await ui.waitFor(`location.pathname.startsWith('/vulns/scan/')`, 'экран скана', 30_000);
  const scanId = await ui.evaluate(`location.pathname.split('/').pop()`);
  await call('POST', `/api/v1/vulns/scans/${scanId}/handover`, { date: portalToday() });
  return { ...g, node, title: `Уязвимости · ${name}` };
}

before(async () => {
  assert.ok(LOGIN && PASSWORD, 'Задайте E2E_LOGIN и E2E_PASSWORD');
  tmp = mkdtempSync(join(tmpdir(), 'ibportal-e2e-chains-'));
  ui = await launchBrowser({ baseUrl: BASE });
  await ui.goto('/login');
  await ui.type(q('input[name=username]'), LOGIN);
  await ui.type(q('input[name=password]'), PASSWORD);
  await ui.click(q('form button[type=submit]'));
  await ui.waitFor(`location.pathname !== '/login'`, 'вход');
  const statuses = (await call('GET', '/api/v1/catalogs/task_statuses/items')).items;
  cols = Object.fromEntries(statuses.filter((s) => s.systemKey).map((s) => [s.systemKey, s.id]));

  groups.a = await groupWithScan(`${RUN} Сервис А`, '10');
  groups.b = await groupWithScan(`${RUN} Отдел Б`, '20');
  // Напоминание за 200 дней до «Срока устранения» метке без участников: задачи «не назначен», в Backlog.
  const label = await call('POST', '/api/v1/catalogs/notify_recipients/items', { value: `${RUN} Дежурные` });
  // Реестр «Уязвимости» — системный, systemKey есть только в карточке реестра.
  let reg;
  for (const r of (await call('GET', '/api/v1/registers')).items.filter((x) => x.system)) {
    const d = await call('GET', `/api/v1/registers/${r.id}`);
    if (d.systemKey === 'vulns') reg = d;
  }
  const vulns = reg;
  const due = reg.fields.find((f) => f.label === 'Срок устранения');
  rule = await call('POST', `/api/v1/registers/${vulns.id}/automations`, {
    condition: { kind: 'before', fieldId: due.id, days: 200 },
    action: { eventType: 'remind', recipients: [{ kind: 'label', itemId: label.id }] },
  });
  const run = await call('POST', `/api/v1/registers/${vulns.id}/automations/run`);
  assert.ok(run.tasksCreated >= 2 * PER_GROUP, `напоминаний ${run.tasksCreated}`);
});

after(async () => {
  if (ui) {
    try {
      if (rule) await call('POST', `/api/v1/register-automations/${rule.id}/archive`, { version: rule.version, tasks: { action: 'keep' } }).catch(() => undefined);
    } finally {
      assert.deepEqual(ui.consoleErrors, [], 'ошибки JavaScript в странице');
      ui.close();
    }
  }
  await cleanE2eGroups();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('Системные цепочки автозадач реестров (1.14.0)', () => {
  it('52 напоминания по двум группам → в Backlog две карточки цепочек, отдельных карточек этих задач нет', async () => {
    await openBoard();
    for (const g of [groups.a, groups.b]) {
      await ui.waitFor(`!!${chainCard(col('new'), g.title)}`, `карточка «${g.title}» в Backlog`);
      const text = await ui.evaluate(`${chainCard(col('new'), g.title)}.textContent`);
      assert.match(text, new RegExp(`${PER_GROUP} задач`), text);
      assert.match(text, new RegExp(`не назначено: ${PER_GROUP}`), text);
      assert.match(text, /ближайший срок \d\d\.\d\d\.\d{4}/);
      assert.match(text, /Реестр/);
      assert.match(text, /авто/);
    }
    // Ни одной отдельной карточки задач этих цепочек вне карточек цепочек.
    const loose = await ui.evaluate(`[...${col('new')}.querySelectorAll('article.card')].filter((c) => !c.closest('.chain-group') && /CVE-2099-(10|20)/.test(c.textContent)).length`);
    assert.equal(loose, 0);
  });

  it('раскрыть карточку: задачи по сроку с подзаголовками; «Взять себе» → в «Поставленные» карточка той же цепочки с одной задачей', async () => {
    await openBoard();
    const card = chainCard(col('new'), groups.a.title);
    await ui.click(`${card}.querySelector('.cc-toggle')`);
    await ui.waitFor(`${card}.querySelectorAll('article.card').length === ${PER_GROUP}`, 'задачи цепочки раскрыты');
    assert.ok(await ui.evaluate(`${card}.querySelectorAll('.sys-day-h').length >= 1`), 'подзаголовки по дате срока');
    await ui.click(`[...${card}.querySelectorAll('article.card .card-step button')].find((b) => b.textContent.trim() === 'Взять себе')`);
    await ui.waitFor(`!!${chainCard(col('assigned'), groups.a.title)}`, 'цепочка в «Поставленные»', 15_000);
    assert.match(await ui.evaluate(`${chainCard(col('assigned'), groups.a.title)}.querySelector('[data-testid=sys-count]').textContent`), /^1 задача$/);
    await ui.waitFor(`/${PER_GROUP - 1} задач/.test(${chainCard(col('new'), groups.a.title)}.querySelector('[data-testid=sys-count]').textContent)`, 'в Backlog на одну меньше');
  });

  it('«Взять себе все»: подтверждение «Взять N задач?», все не назначенные задачи колонки — мои', async () => {
    await openBoard();
    const card = chainCard(col('new'), groups.b.title);
    await ui.click(startsWith('Взять себе все', card));
    await ui.waitFor(`(${card}.querySelector('.sys-confirm')?.textContent ?? '').includes('Взять ${PER_GROUP} задач?')`, 'подтверждение');
    await ui.click(button('Взять', card));
    await ui.waitFor(`!${chainCard(col('new'), groups.b.title)} && !!${chainCard(col('assigned'), groups.b.title)}`, 'цепочка ушла из Backlog', 30_000);
    const me = (await call('GET', '/api/v1/auth/me')).user;
    const chain = await call('GET', `/api/v1/task-chains/by-source?type=vuln_group&id=${groups.b.id}`);
    const detail = await call('GET', `/api/v1/task-chains/${chain.chain.id}`);
    assert.equal(detail.tasks.length, PER_GROUP);
    for (const t of detail.tasks) assert.equal(t.assignee?.id, me.id);
  });

  it('страница группы: «Задачи: N активных» открывает панель системной цепочки — источник, фильтр, без правки', async () => {
    await open(`/vulns/group/${groups.a.id}`, `!!${q('[data-testid=source-tasks]')}`, 'ссылка на задачи группы');
    assert.equal(await ui.evaluate(`${q('[data-testid=source-tasks]')}.textContent.trim()`), `Задачи: ${PER_GROUP} активных`);
    await ui.click(q('[data-testid=source-tasks]'));
    await ui.waitFor(`!!${q('[data-testid=chain-panel]')} && !!${q('[data-testid=system-chain-note]')}`, 'панель цепочки');
    const panel = await ui.evaluate(`${q('[data-testid=chain-panel]')}.textContent`);
    assert.match(panel, /системная/);
    assert.ok(!panel.includes('Закрыть цепочку') && !panel.includes('Удалить'), 'без правки, закрытия и удаления');
    assert.ok(await ui.evaluate(`!!${q('[data-testid=system-chain-note] a')}`), 'ссылка на группу');
    await ui.click(button('Все', q('[data-testid=chain-panel]')));
    await ui.waitFor(`${q('[data-testid=chain-panel]')}.querySelectorAll('.chain-timeline li[data-task]').length === ${PER_GROUP}`, 'все задачи');
  });

  it('карточка задачи: блок «Цепочка» — системная, источник, «Отвязать»; отвязанная задача — обычная карточка', async () => {
    const chain = await call('GET', `/api/v1/task-chains/by-source?type=vuln_group&id=${groups.a.id}`);
    const detail = await call('GET', `/api/v1/task-chains/${chain.chain.id}`);
    const t = detail.tasks.find((x) => !x.assignee);
    await open(`/tasks?task=${t.id}`, `!!${q('[data-testid=chain-block]')}`, 'карточка задачи');
    const block = await ui.evaluate(`${q('[data-testid=chain-block]')}.textContent`);
    assert.match(block, /системная/);
    assert.ok(await ui.evaluate(`!!${q('[data-testid=chain-source] a')}`), 'ссылка на источник');
    await ui.click(button('Отвязать', q('[data-testid=chain-block]')));
    await ui.waitFor(`!${q('[data-testid=chain-block]')}`, 'задача отвязана');
    const after = await call('GET', `/api/v1/tasks/${t.id}`);
    assert.equal(after.chain, null);
  });
  it('«Найти цепочки среди старых задач»: блок «Системные цепочки реестров» — новые автозадачи уже в цепочках, собирать нечего', async () => {
    await open('/tasks/chains', `!!${startsWith('Найти цепочки')}`, 'список цепочек');
    const row = `[...document.querySelectorAll('tbody tr')].find((tr) => tr.textContent.includes(${JSON.stringify(groups.a.title)}))`;
    assert.match(await ui.evaluate(`${row}?.textContent ?? ''`), /системная/);
    await ui.click(startsWith('Найти цепочки'));
    await ui.waitFor(`!!${q('[data-testid=system-discover]')} && !${q('[data-testid=system-discover]')}.textContent.includes('Ищем')`, 'блок системных цепочек');
    const text = await ui.evaluate(`${q('[data-testid=system-discover]')}.textContent`);
    assert.ok(!text.includes(groups.a.title) && !text.includes(groups.b.title), text);
    await ui.click(button('Отмена'));
  });
});
