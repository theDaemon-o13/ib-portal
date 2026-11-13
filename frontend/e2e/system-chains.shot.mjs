// Скриншоты доски до и после системных цепочек (1.14.0, задание п. 10): 52 синтетических напоминания по двум группам
// «Уязвимостей» и пара ручных задач. «До» — доска без группировки: так её видел 1.13.12 (автозадачи не были в цепочках).
// «После» — с группировкой (по умолчанию), плюс раскрытая карточка и панель цепочки. Обе темы, 1440 и 375 px.
// Не тест сравнения и не входит в полный прогон. Запуск на одноразовой базе:
//   npm run test:e2e -- e2e/system-chains.shot.mjs   (SHOTS_DIR — каталог, по умолчанию docs/screens/1.14.0)
// Данные вымышленные: группы «Сервис А», «Отдел Б», CVE-2099-NNNNN, задачи «Иванов И.И.».
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, it } from 'node:test';
import { launchBrowser, sleep } from './browser.mjs';
import { chainsKit } from './system-chains-kit.mjs';
import { cleanE2eGroups } from './vulns-cleanup.mjs';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5174';
const DIR = process.env.SHOTS_DIR ?? new URL('../../docs/screens/1.14.0/', import.meta.url).pathname;
const LOGIN = process.env.E2E_LOGIN;
const PASSWORD = process.env.E2E_PASSWORD;
const RUN = `E2E-${Date.now().toString(36)}`;

let ui;
let tmp;
let kit;
let rule;
let groups;

async function theme(name) {
  const title = name === 'ocean' ? 'Тема «Океан»' : 'Тема «Чёрный океан»';
  await ui.evaluate(`(() => { const b = document.querySelector('.seg-top button[title=${JSON.stringify(title).replace(/"/g, '\\"')}]');
    if (b) b.click(); else { localStorage.setItem('ibportal.theme', ${JSON.stringify(name)}); document.documentElement.setAttribute('data-theme', ${JSON.stringify(name)}); } })()`);
  await sleep(600);
}
async function shot(name, th, width) {
  // На телефоне доска ниже фильтров — снимок с неё (панель цепочки открыта поверх и так видна).
  if (width < 500 && !name.startsWith('chain-panel')) await ui.evaluate(`document.querySelector('.board')?.scrollIntoView({ block: 'start' })`);
  await sleep(700);
  writeFileSync(join(DIR, `${name}-${th}-${width}.jpg`), await ui.screenshot('jpeg', 82));
}
async function board(grouped) {
  await ui.evaluate(`localStorage.setItem('ibportal.tasks.groupChains', ${JSON.stringify(grouped ? '1' : '0')})`);
  await kit.open('/tasks', `document.querySelectorAll('.board .col').length >= 5 && document.querySelectorAll('.board .card, .board .chain-group').length > 0`, 'доска');
  // Обрезанные названия группы «E2E-…» на снимке не нужны: метка прогона убирается из видимого текста.
  await ui.evaluate(`document.querySelectorAll('.cc-t, .card-t, .dp-title, h2').forEach((el) => { el.childNodes.forEach((n) => { if (n.nodeType === 3) n.textContent = n.textContent.replace(/${RUN} /g, ''); }); })`);
}

before(async () => {
  assert.ok(LOGIN && PASSWORD, 'Задайте E2E_LOGIN и E2E_PASSWORD');
  mkdirSync(DIR, { recursive: true });
  tmp = mkdtempSync(join(tmpdir(), 'ibportal-shot-chains-'));
  ui = await launchBrowser({ baseUrl: BASE });
  kit = chainsKit(ui, tmp);
  await ui.goto('/login');
  await ui.type(kit.q('input[name=username]'), LOGIN);
  await ui.type(kit.q('input[name=password]'), PASSWORD);
  await ui.click(kit.q('form button[type=submit]'));
  await ui.waitFor(`location.pathname !== '/login'`, 'вход');
  ({ groups, rule } = await kit.setup(RUN));
  const cats = (await kit.call('GET', '/api/v1/catalogs/task_categories/items')).items;
  const project = cats.find((c) => !c.systemKey) ?? cats[0];
  for (const title of ['Проверить права в АБС после увольнения — Иванов И.И.', 'Согласовать доступ подрядчика к стенду']) {
    await kit.call('POST', '/api/v1/tasks', { title, categoryId: project.id });
  }
});

after(async () => {
  if (ui) {
    try {
      if (rule) await kit.call('POST', `/api/v1/register-automations/${rule.id}/archive`, { version: rule.version, tasks: { action: 'keep' } }).catch(() => undefined);
    } finally {
      ui.close();
    }
  }
  await cleanE2eGroups();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

it('доска до и после, раскрытая цепочка, панель цепочки — обе темы, 1440 и 375 px', async () => {
  for (const th of ['ocean', 'black']) {
    for (const width of [1440, 375]) {
      await ui.viewport(width, width < 500 ? 812 : 1000);
      await theme(th);
      await board(false);
      // В 1.13.12 автозадачи не были в цепочках: метки «Цепочка: …» на их карточках не было.
      await ui.evaluate(`document.querySelectorAll('.card-chain').forEach((el) => el.closest('.meta')?.remove())`);
      await shot('board-before', th, width);
      await board(true);
      await shot('board-after', th, width);
      const card = `document.querySelector(${JSON.stringify(`[data-chain="Уязвимости · ${groups.a.name}"]`)})`;
      await ui.click(`${card}.querySelector('.cc-toggle')`);
      await ui.waitFor(`${card}.querySelectorAll('article.card').length > 0`, 'раскрыта');
      await ui.evaluate(`document.querySelectorAll('.cc-t, .card-t').forEach((el) => { el.childNodes.forEach((n) => { if (n.nodeType === 3) n.textContent = n.textContent.replace(/${RUN} /g, ''); }); })`);
      await shot('board-expanded', th, width);
      const chain = await kit.call('GET', `/api/v1/task-chains/by-source?type=vuln_group&id=${groups.a.id}`);
      await kit.open(`/tasks?chain=${chain.chain.id}`, `!!${kit.q('[data-testid=system-chain-note]')}`, 'панель цепочки');
      await ui.evaluate(`document.querySelectorAll('[data-testid=chain-panel] *').forEach((el) => { el.childNodes.forEach((n) => { if (n.nodeType === 3) n.textContent = n.textContent.replace(/${RUN} /g, ''); }); })`);
      await shot('chain-panel', th, width);
    }
  }
});
