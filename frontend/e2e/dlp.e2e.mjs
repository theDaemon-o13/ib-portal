// Сквозной тест этапа 8б: разрешение на доступ с документом-основанием, фиксация после «Действует»,
// причина изменения «Устройств», статус основания и обратные связи в карточке устройства, глобальный поиск.
// Настоящие щелчки и ввод; данные — в стартовых реестрах «Устройства DLP» и «Разрешения на доступ».
// В конце записи прогона уходят в архив (действующее разрешение не удаляется — так задумано).
//
//   npm run test:e2e
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { $, launchBrowser, sleep } from './browser.mjs';
import { pickFiles, tempFile, tinyPdf } from './files.mjs';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const LOGIN = process.env.E2E_LOGIN;
const PASSWORD = process.env.E2E_PASSWORD;
const RUN = Date.now().toString(36).toUpperCase();
const HOST1 = `WS-E2E-${RUN}-1`;
const HOST2 = `WS-E2E-${RUN}-2`;
const DOC = `E2E-${RUN}`;

let ui;
let dev;
let perm;
const created = [];
let navSeq = 0;

const drawer = `document.querySelector('aside.drawer[aria-label="Запись реестра"]')`;
const block = (label) => `${drawer}?.querySelector('[role=group][aria-label=${JSON.stringify(label)}]')`;
const cardInput = (label) => `[...${drawer}.querySelectorAll('.recform > label')].find((l) => l.firstChild?.textContent === ${JSON.stringify(label)})?.querySelector('input, select, textarea')`;

async function api(method, path, body) {
  const res = await ui.evaluate(`fetch(${JSON.stringify(path)}, ${JSON.stringify(body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })})
    .then(async (r) => ({ status: r.status, text: await r.text() }))`);
  assert.ok(res.status >= 200 && res.status < 300, `${method} ${path} → ${res.status} ${res.text}`);
  return res.text ? JSON.parse(res.text) : null;
}
const field = (reg, label) => {
  const f = reg.fields.find((x) => x.label === label);
  assert.ok(f, `нет поля «${label}» в «${reg.name}»`);
  return f;
};
const option = (reg, label, value) => field(reg, label).options.find((o) => o.label === value).id;

async function openRecord(reg, id) {
  await ui.goto(`/registers?record=${id}&run=${++navSeq}#${reg.id}/records`);
  await ui.waitFor(`!!${drawer}?.querySelector('.recform')`, 'карточка записи');
}

async function save() {
  const m = ui.mark();
  await ui.click($.button('Сохранить', drawer), '«Сохранить»');
  return ui.request(m, 'PATCH', '/api/v1/register-records/');
}

before(async () => {
  assert.ok(LOGIN && PASSWORD, 'Задайте E2E_LOGIN и E2E_PASSWORD');
  ui = await launchBrowser({ baseUrl: BASE });
  await ui.goto('/login');
  await ui.type(`document.querySelector('input[name=username]')`, LOGIN);
  await ui.type(`document.querySelector('input[name=password]')`, PASSWORD);
  await ui.click(`document.querySelector('form button[type=submit]')`);
  await ui.waitFor(`location.pathname !== '/login'`, 'вход');
  const regs = (await api('GET', '/api/v1/registers')).items;
  const byName = (n) => {
    const r = regs.find((x) => x.name === n);
    assert.ok(r, `нет стартового реестра «${n}» (seed этапа 8б)`);
    return api('GET', `/api/v1/registers/${r.id}`);
  };
  dev = await byName('Устройства DLP');
  perm = await byName('Разрешения на доступ');
});

after(async () => {
  for (const id of ui ? created : []) {
    await ui.evaluate(`fetch('/api/v1/register-records/${id}').then((r) => r.json()).then((rec) => rec.archived ? null
      : fetch('/api/v1/register-records/${id}/archive', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: rec.version }) }))`).catch(() => undefined);
  }
  if (ui) {
    assert.deepEqual(ui.consoleErrors, [], 'ошибки JavaScript в странице');
    ui.close();
  }
});

describe('Разрешения на доступ', () => {
  let d1;
  let d2;
  let p;

  it('документ прикладывается в карточке: sha256 и дата загрузки; после «Действует» — зафиксировано', async () => {
    const soc = option(dev, 'Соцсети и мессенджеры', 'Разрешён Telegram');
    d1 = await api('POST', `/api/v1/registers/${dev.id}/records`, { values: { [field(dev, 'Имя хоста').id]: HOST1, [field(dev, 'Соцсети и мессенджеры').id]: soc } });
    d2 = await api('POST', `/api/v1/registers/${dev.id}/records`, { values: { [field(dev, 'Имя хоста').id]: HOST2, [field(dev, 'Соцсети и мессенджеры').id]: soc } });
    created.push(d1.id, d2.id);
    p = await api('POST', `/api/v1/registers/${perm.id}/records`, {
      values: {
        [field(perm, 'Сотрудник').id]: 'Тестов Тест',
        [field(perm, 'Вид').id]: option(perm, 'Вид', 'Соцсети и мессенджеры'),
        [field(perm, 'Устройства').id]: [d1.id, d2.id],
        [field(perm, '№ документа').id]: DOC,
        [field(perm, 'Дата документа').id]: `${new Date().getFullYear()}-01-15`,
      },
    });
    created.push(p.id);
    assert.equal(p.values[field(perm, 'Действует до').id], `${new Date().getFullYear()}-12-31`, 'по умолчанию — 31.12 года документа');

    await openRecord(perm, p.id);
    const m = ui.mark();
    await pickFiles(ui, 'aside.drawer [data-file-field="Документ-основание"] input[type=file]', [tempFile(`${DOC}.pdf`, tinyPdf(`Permission ${DOC}`))]);
    const attach = await ui.request(m, 'POST', `/api/v1/register-records/${p.id}/files`);
    assert.equal(attach.status, 200, attach.body);
    await ui.waitFor(`${block('Документ-основание')}?.textContent.includes('sha256')`, 'sha256 приложенного файла');
    assert.match(await ui.evaluate(`${block('Документ-основание')}.querySelector('.sha').textContent`), /^[0-9a-f]{64}$/);
    // Кнопки файла дорисовываются после перечитывания записи — ждём, а не проверяем сразу.
    await ui.waitFor(`!!${$.button('Отвязать', block('Документ-основание'))}`, 'до «Действует» документ можно отвязать');

    await ui.select(cardInput('Статус'), option(perm, 'Статус', 'Действует'));
    const req = await save();
    assert.equal(req.status, 200, req.body);
    await ui.waitFor(`${block('Документ-основание')}?.textContent.includes('зафиксировано')`, 'документ зафиксирован');
    assert.equal(await ui.evaluate(`!!${$.button('Отвязать', block('Документ-основание'))}`), false, 'кнопки «Отвязать» нет');
    assert.equal(await ui.evaluate(`!!document.querySelector('aside.drawer [data-file-field="Документ-основание"] input[type=file]')`), false, 'загрузки нет');
    assert.equal(await ui.evaluate(`${cardInput('№ документа')}.disabled`), true, '№ документа только для чтения');
  });

  it('«Устройства» действующего разрешения — только с причиной, она в истории', async () => {
    await openRecord(perm, p.id);
    await ui.waitFor(`[...${block('Устройства')}.querySelectorAll('button[aria-label^="Убрать"]')].some((b) => b.ariaLabel.includes(${JSON.stringify(HOST2)}))`, 'подписи хостов');
    await ui.click(`[...${block('Устройства')}.querySelectorAll('button[aria-label^="Убрать"]')].find((b) => b.ariaLabel.includes(${JSON.stringify(HOST2)}))`, 'убрать второй хост');
    await ui.waitFor(`!!${drawer}.querySelector('textarea[required]')`, 'поле «Причина изменения»');
    await ui.type(`${drawer}.querySelector('textarea[required]')`, 'Ноутбук списан, заявка E2E');
    const req = await save();
    assert.equal(req.status, 200, req.body);
    assert.equal(req.json.reason, 'Ноутбук списан, заявка E2E');
    assert.deepEqual(req.json.values[field(perm, 'Устройства').id], [d1.id], 'остался первый хост');
    await ui.waitFor(`${drawer}.querySelector('.hist')?.textContent.includes('Причина: Ноутбук списан, заявка E2E')`, 'причина в истории');
  });

  it('карточка устройства: статус основания и обратная связь на разрешение', async () => {
    await openRecord(dev, d1.id);
    await ui.waitFor(`${drawer}.textContent.includes('есть основание — разрешение ${DOC}')`, 'есть основание');
    await ui.waitFor(`${drawer}.textContent.includes('ссылаются полем «Устройства»') && ${drawer}.textContent.includes('Действует')`, 'обратная связь');
    // Второй хост убрали из разрешения — у него основания нет.
    await openRecord(dev, d2.id);
    await ui.waitFor(`${drawer}.textContent.includes('нет основания')`, 'нет основания у второго хоста');
  });

  it('глобальный поиск: имя хоста из меню находит устройство и разрешение', async () => {
    await ui.goto(`/dashboard?run=${++navSeq}`);
    await ui.type(`document.querySelector('.rail-search input')`, HOST1);
    await ui.press('Enter');
    await ui.waitFor(`location.pathname === '/search' && document.querySelectorAll('section[aria-label="Записи реестров"] .search-hit').length >= 2`, 'результаты поиска');
    const titles = await ui.evaluate(`[...document.querySelectorAll('section[aria-label="Записи реестров"] .search-hit b')].map((b) => b.textContent)`);
    assert.ok(titles.some((t) => t.includes(HOST1)), `устройство в результатах: ${titles}`);
    assert.ok(titles.some((t) => t.includes('Тестов Тест')), `разрешение в результатах: ${titles}`);
    await ui.click(`[...document.querySelectorAll('.search-hit')].find((a) => a.textContent.includes(${JSON.stringify(HOST1)}))`, 'открыть устройство');
    await ui.waitFor(`!!${drawer} && ${drawer}.textContent.includes(${JSON.stringify(HOST1)})`, 'карточка устройства по ссылке поиска');
    await sleep(100);
  });
});
