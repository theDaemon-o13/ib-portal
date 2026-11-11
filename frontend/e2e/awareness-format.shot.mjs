// Скриншоты оформления в редакторе письма (1.13.11, задание п. 13): панель, палитра с избранным, меню таблицы с заливкой,
// панель картинки и предпросмотр как в почте — обе темы, 1440 и 375 px. Не тест сравнения и не входит в полный прогон.
// Запуск на одноразовой базе: npm run test:e2e -- e2e/awareness-format.shot.mjs (SHOTS_DIR — каталог).
// Данные вымышленные: шаблон «Как получить доступ к флешке», картинки — сгенерированные PNG.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { after, before, it } from 'node:test';
import { launchBrowser, sleep } from './browser.mjs';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5174';
const DIR = process.env.SHOTS_DIR ?? new URL('../../docs/design/ocean/screens/', import.meta.url).pathname;
const LOGIN = process.env.E2E_LOGIN;
const PASSWORD = process.env.E2E_PASSWORD;
const RUN = `SHOT-${Date.now().toString(36)}`;

let ui;
let templateId;
let letterId;

function png(w, h, colors) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const [r, g, b] = colors[Math.floor((y / h) * colors.length)];
    for (let x = 0; x < w; x++) raw.set([r, g, b], y * (w * 3 + 1) + 1 + x * 3);
  }
  return `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64')}`;
}

async function api(method, path, body) {
  const res = await ui.evaluate(`fetch(${JSON.stringify(path)}, ${JSON.stringify(body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })})
    .then(async (r) => ({ status: r.status, text: await r.text() }))`);
  assert.ok(res.status >= 200 && res.status < 300, `${method} ${path} → ${res.status} ${res.text}`);
  return res.text ? JSON.parse(res.text) : null;
}

async function login() {
  await ui.goto('/login');
  await ui.type(`document.querySelector('input[name=username]')`, LOGIN);
  await ui.type(`document.querySelector('input[name=password]')`, PASSWORD);
  await ui.click(`document.querySelector('form button[type=submit]')`);
  await ui.waitFor(`location.pathname !== '/login'`, 'вход');
}

async function theme(name) {
  const title = name === 'ocean' ? 'Тема «Океан»' : 'Тема «Чёрный океан»';
  await ui.evaluate(`(() => { const b = document.querySelector('.seg-top button[title=${JSON.stringify(title).replace(/"/g, '\\"')}]');
    if (b) b.click(); else { localStorage.setItem('ibportal.theme', ${JSON.stringify(name)}); document.documentElement.setAttribute('data-theme', ${JSON.stringify(name)}); } })()`);
  await sleep(600);
}
async function shot(name, th, width, focus = null) {
  await ui.viewport(width, width < 500 ? 812 : 1000);
  if (focus) await ui.evaluate(`document.querySelector(${JSON.stringify(focus)})?.scrollIntoView({ block: 'center' })`);
  await sleep(700);
  writeFileSync(join(DIR, `${name}-${th}-${width}.jpg`), await ui.screenshot('jpeg', 82));
}

const ed = `[...document.querySelectorAll('.aw-editor')].find((e) => e.offsetParent)`;
const doc = `${ed}?.querySelector('.aw-doc')`;

const HTML = `<h2>Как получить доступ к флешке</h2>
<p>Съёмные носители <span style="background-color:#FEF08A">по умолчанию заблокированы</span>. Доступ выдаётся по заявке и <u style="text-decoration-color:#DC2626">только на рабочее время</u>.</p>
<img src="${png(360, 150, [[37, 99, 235], [147, 197, 253], [219, 234, 254]])}" data-align="center" width="320" alt="Окно запроса доступа (тестовое изображение)" />
<p style="text-align:center"><span style="color:#64748B">Рис. 1. Окно запроса доступа — тестовое изображение</span></p>
<img src="${png(200, 200, [[22, 163, 74], [134, 239, 172]])}" data-align="wrap-right" width="180" alt="" />
<p><span style="font-family:'Times New Roman', Times, serif">Нажмите «Запросить доступ» и укажите причину. Заявку согласует руководитель, затем её исполняет ИБ. Пока доступа нет, файлы можно передать через корпоративное облако.</span></p>
<p style="text-align:justify"><span style="color:#1E3A8A">Срок рассмотрения — один рабочий день.</span></p>
<table><tbody><tr><th width="40%" style="background-color:#EFF6FF"><p>Временный доступ</p></th><th width="60%" style="background-color:#FEF2F2"><p>Постоянный доступ</p></th></tr>
<tr><td><p>До 8 часов, без согласования владельца системы</p></td><td style="background-color:#FFFBEB"><p>Только по служебной записке, пересмотр раз в год</p></td></tr></tbody></table>
<p>Вопросы — <span style="color:#DC2626">в отдел ИБ</span>.</p>`;

before(async () => {
  assert.ok(LOGIN && PASSWORD, 'Задайте E2E_LOGIN и E2E_PASSWORD');
  ui = await launchBrowser({ baseUrl: BASE });
  mkdirSync(DIR, { recursive: true });
  await login();
  const t = await api('POST', '/api/v1/awareness/templates', { title: 'Как получить доступ к флешке', subjectRu: 'Как получить доступ к флешке', subjectTj: '', htmlRu: HTML, htmlTj: '' });
  templateId = t.template.id;
  const l = await api('POST', `/api/v1/awareness/templates/${templateId}/letter`, { title: `${RUN} Как получить доступ к флешке`, kind: 'planned', values: {} });
  letterId = l.letter.id;
  // Избранное — вымышленный набор, чтобы палитра была заполнена.
  await ui.evaluate(`(async () => { const me = await fetch('/api/v1/auth/me').then((r) => r.json()); const id = me.user.id;
    localStorage.setItem('ibportal.awareness.favoriteColors.' + id + '.text', JSON.stringify(['#7C3AED', '#0E7490', '#B45309']));
    localStorage.setItem('ibportal.awareness.favoriteColors.' + id + '.bg', JSON.stringify(['#FDE68A', '#DDD6FE'])); })()`);
});

after(async () => {
  if (!ui) return;
  try {
    if (letterId) {
      const l = await api('GET', `/api/v1/awareness/letters/${letterId}`).catch(() => null);
      if (l && !l.archived) await api('POST', `/api/v1/awareness/letters/${letterId}/archive`, { version: l.version }).catch(() => undefined);
    }
    if (templateId) {
      const t = await api('GET', `/api/v1/awareness/templates/${templateId}`).catch(() => null);
      if (t && !t.archived) await api('POST', `/api/v1/awareness/templates/${templateId}/archive`, { version: t.version }).catch(() => undefined);
    }
  } finally {
    await ui.close();
  }
});

it('скриншоты редактора (панель, палитра, таблица, картинка) и предпросмотра в обеих темах, 1440 и 375 px', async () => {
  for (const th of ['ocean', 'black']) {
    for (const width of [1440, 375]) {
      await ui.viewport(width, width < 500 ? 812 : 1000);
      await ui.goto(`/awareness/templates?template=${templateId}`);
      await ui.waitFor(`!!${doc}`, 'редактор шаблона');
      await theme(th);
      await ui.evaluate(`document.querySelector('.aw-toolbar').scrollIntoView({ block: 'start' })`);
      await shot('letter-editor', th, width);

      await ui.click(doc, 'текст');
      await ui.click(`${ed}.querySelector('.aw-split-arrow[data-kind=text]')`, 'палитра');
      await ui.waitFor(`!!${ed}.querySelector('.aw-palette')`, 'палитра открыта');
      await shot('letter-editor-palette', th, width, '.aw-toolbar');
      await ui.press('Escape');

      await ui.click(`${doc}.querySelector('table th')`, 'ячейка таблицы');
      await ui.waitFor(`!!${ed}.querySelector('.aw-tbl-tools')`, 'меню таблицы');
      await ui.click(`${ed}.querySelector('.aw-split-arrow[data-kind=cell]')`, 'палитра заливки');
      await ui.waitFor(`!!${ed}.querySelector('.aw-palette')`, 'палитра заливки открыта');
      await shot('letter-editor-table', th, width, '.aw-tbl-tools');
      await ui.press('Escape');

      await ui.waitFor(`!${ed}.querySelector('.aw-palette')`, 'палитра закрыта');
      await ui.evaluate(`${doc}.querySelectorAll('img')[1].scrollIntoView({ block: 'center' })`);
      await sleep(300);
      await ui.click(`${doc}.querySelectorAll('img')[1]`, 'картинка с обтеканием');
      await ui.waitFor(`!!document.querySelector('[data-testid=image-panel]')?.offsetParent`, 'панель картинки');
      await shot('letter-editor-image', th, width, '[data-testid=image-panel]');

      await ui.goto(`/awareness/letters?letter=${letterId}`);
      const panel = `document.querySelector('[data-testid=letter-panel]')`;
      await ui.waitFor(`!!${panel}?.querySelector('.aw-doc')`, 'карточка письма');
      await ui.click(`[...${panel}.querySelectorAll('[role=tab]')].find((b) => b.textContent === 'Экспорт')`, 'вкладка «Экспорт»');
      await ui.waitFor(`!!${panel}.querySelector('[data-testid=mail-preview] iframe')`, 'предпросмотр');
      if (width < 500) await ui.click(`[...${panel}.querySelectorAll('[data-testid=mail-preview] button')].find((b) => b.textContent === 'Телефон')`, 'вид «Телефон»');
      await sleep(800);
      await shot('letter-preview-format', th, width, '[data-testid=mail-preview]');
    }
  }
});
