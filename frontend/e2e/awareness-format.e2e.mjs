// Сквозной тест оформления в редакторе письма (1.13.11, docs/tasks/1.13.11-letter-editor-formatting.md, п. 13):
// свой цвет в избранное → он в палитре цвета текста и подчёркивания, но не фона → шаблон с таблицей (40/60, заливка
// заголовка из избранного фона), картинкой по центру и картинкой справа с обтеканием, цветным текстом, фоном текста,
// цветным подчёркиванием, Times New Roman, выравниванием → письмо из шаблона → предпросмотр как в почте → .eml.
// Картинки — сгенерированные PNG, тексты — вымышленные.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { after, before, describe, it } from 'node:test';
import { $, launchBrowser, sleep } from './browser.mjs';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const LOGIN = process.env.E2E_LOGIN;
const PASSWORD = process.env.E2E_PASSWORD;
const RUN = `E2E-${Date.now().toString(36)}`;
const FAV_TEXT = '#7C3AED';
const FAV_BG = '#FDE68A';

let ui;
let tmp;
let staff;
let templateId;
const letters = [];

/** PNG w×h: полосы цвета — сгенерированное тестовое изображение. */
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
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function api(method, path, body) {
  const res = await ui.evaluate(`fetch(${JSON.stringify(path)}, ${JSON.stringify(body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })})
    .then(async (r) => ({ status: r.status, text: await r.text() }))`);
  assert.ok(res.status >= 200 && res.status < 300, `${method} ${path} → ${res.status} ${res.text}`);
  return res.text ? JSON.parse(res.text) : null;
}

async function loginAs(login, password) {
  await api('POST', '/api/v1/auth/logout').catch(() => undefined);
  await ui.goto('/login');
  await ui.type(`document.querySelector('input[name=username]')`, login);
  await ui.type(`document.querySelector('input[name=password]')`, password);
  await ui.click(`document.querySelector('form button[type=submit]')`);
  await ui.waitFor(`location.pathname !== '/login'`, `вход ${login}`);
  if (await ui.evaluate(`location.pathname === '/change-password'`)) {
    const next = `Оф-${RUN.slice(4)}-Zq9!x`;
    await ui.type(`document.querySelector('input[autocomplete=current-password]')`, password);
    await ui.type(`document.querySelectorAll('input[autocomplete=new-password]')[0]`, next);
    await ui.type(`document.querySelectorAll('input[autocomplete=new-password]')[1]`, next);
    await ui.click($.button('Сменить пароль'));
    await ui.waitFor(`location.pathname !== '/change-password'`, 'смена пароля');
    return next;
  }
  return password;
}

const ed = `[...document.querySelectorAll('.aw-editor')].find((e) => e.offsetParent)`;
const doc = `${ed}?.querySelector('.aw-doc')`;
const tb = (label) => `${ed}?.querySelector('.aw-toolbar [aria-label^=${JSON.stringify(label)}]')`;
const arrow = (kind) => `${ed}?.querySelector('.aw-split-arrow[data-kind=${kind}]')`;
const main = (kind) => `${ed}?.querySelector('.aw-split-main[data-kind=${kind}]')`;
const palette = `${ed}?.querySelector('.aw-palette')`;
const favHexes = `[...(${palette}?.querySelectorAll('[data-testid=palette-favorites] .aw-sw') ?? [])].map((b) => b.dataset.hex)`;

/** Выделить текст в видимом редакторе (как мышью): подстрока абзаца, даже если она разбита на несколько span. */
async function select(text) {
  const ok = await ui.evaluate(`(() => {
    const t = ${JSON.stringify(text)};
    for (const block of ${doc}.querySelectorAll('p, h2, h3, h4, li, td, th')) {
      const i = block.textContent.indexOf(t);
      if (i < 0) continue;
      const w = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      let pos = 0, start = null, end = null, n;
      while ((n = w.nextNode())) {
        const len = n.data.length;
        if (start === null && i < pos + len) start = [n, i - pos];
        if (start !== null && i + t.length <= pos + len) { end = [n, i + t.length - pos]; break; }
        pos += len;
      }
      if (!start || !end) return false;
      const r = document.createRange(); r.setStart(start[0], start[1]); r.setEnd(end[0], end[1]);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      return true;
    }
    return false; })()`);
  assert.ok(ok, `текст «${text}» в редакторе`);
  await sleep(200);
}

async function openPalette(kind) {
  await ui.click(arrow(kind), `палитра ${kind}`);
  await ui.waitFor(`!!${palette}`, `палитра ${kind} открыта`);
}

before(async () => {
  assert.ok(LOGIN && PASSWORD, 'Задайте E2E_LOGIN и E2E_PASSWORD');
  tmp = mkdtempSync(join(tmpdir(), 'ibportal-fmt-'));
  writeFileSync(join(tmp, 'center.png'), png(320, 160, [[37, 99, 235], [191, 219, 254]]));
  writeFileSync(join(tmp, 'side.png'), png(240, 240, [[22, 163, 74], [187, 247, 208], [254, 240, 138]]));
  ui = await launchBrowser({ baseUrl: BASE });
  await loginAs(LOGIN, PASSWORD);
  const roles = (await api('GET', '/api/v1/roles')).items;
  const r = await api('POST', '/api/v1/users', { login: `${RUN.toLowerCase()}.fmt`, fullName: `Оформитель ${RUN}`, roleIds: [roles.find((x) => x.code === 'ib_staff').id] });
  staff = { id: r.user.id, login: r.user.login, password: r.temporaryPassword };
  staff.password = await loginAs(staff.login, staff.password);
  const t = await api('POST', '/api/v1/awareness/templates', { title: `${RUN} Доступ к флешке`, subjectRu: 'Как получить доступ к флешке', subjectTj: '', htmlRu: '<p>черновик</p>', htmlTj: '' });
  templateId = t.template.id;
});

after(async () => {
  if (!ui) return;
  try {
    await loginAs(LOGIN, PASSWORD).catch(() => undefined);
    for (const id of letters) {
      const l = await api('GET', `/api/v1/awareness/letters/${id}`).catch(() => null);
      if (l && !l.archived) await api('POST', `/api/v1/awareness/letters/${id}/archive`, { version: l.version }).catch(() => undefined);
    }
    if (templateId) {
      const t = await api('GET', `/api/v1/awareness/templates/${templateId}`).catch(() => null);
      if (t && !t.archived) await api('POST', `/api/v1/awareness/templates/${templateId}/archive`, { version: t.version }).catch(() => undefined);
    }
    if (staff) {
      const cur = (await api('GET', `/api/v1/users?q=${encodeURIComponent(staff.login)}`).catch(() => ({ items: [] }))).items.find((u) => u.id === staff.id);
      if (cur?.isActive) await api('POST', `/api/v1/users/${staff.id}/disable`, { version: cur.version }).catch(() => undefined);
    }
    assert.deepEqual(ui.consoleErrors, [], 'ошибки JavaScript в странице');
  } finally {
    ui.close();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
});

describe('Осведомлённость: оформление в редакторе письма (1.13.11)', () => {
  it('избранное: свой цвет текста — в палитре цвета текста и подчёркивания, но не фона; клавиатура и Delete', async () => {
    await ui.goto(`/awareness/templates?template=${templateId}`);
    await ui.waitFor(`!!${doc}`, 'редактор шаблона');
    await ui.click(doc, 'текст шаблона');

    await openPalette('text');
    await ui.type(`${palette}.querySelector('input[aria-label^="Свой цвет"]')`, FAV_TEXT);
    await ui.click(`${palette}.querySelector('[aria-label="Свой цвет — в избранное"]')`, 'свой цвет в избранное');
    await ui.waitFor(`${favHexes}.includes(${JSON.stringify(FAV_TEXT)})`, 'свой цвет в избранном текста');
    // Клавиатура: фокус на образце, стрелка, подпись для диктора; Esc закрывает.
    await ui.evaluate(`${palette}.querySelector('[data-testid=palette-favorites] .aw-sw').focus()`);
    assert.equal(await ui.evaluate(`document.activeElement.getAttribute('aria-label')`), `${FAV_TEXT}, в избранном`);
    await ui.press('ArrowRight');
    assert.match(await ui.evaluate(`document.activeElement.getAttribute('aria-label')`), /^Обычный, #0F172A/);
    await ui.press('Escape');
    await ui.waitFor(`!${palette}`, 'палитра закрыта по Esc');

    await openPalette('underline');
    assert.ok((await ui.evaluate(favHexes)).includes(FAV_TEXT), 'тот же набор у подчёркивания');
    await ui.press('Escape');
    await openPalette('highlight');
    assert.ok(!(await ui.evaluate(favHexes)).includes(FAV_TEXT), 'в палитре фона цвета текста нет');
    await ui.type(`${palette}.querySelector('input[aria-label^="Свой цвет"]')`, FAV_BG);
    await ui.click(`${palette}.querySelector('[aria-label="Свой цвет — в избранное"]')`, 'фон в избранное');
    await ui.waitFor(`${favHexes}.includes(${JSON.stringify(FAV_BG)})`, 'свой фон в избранном фона');
    // Удаление с клавиатуры: Delete на цвете избранного; потом вернуть.
    await ui.evaluate(`[...${palette}.querySelectorAll('[data-testid=palette-favorites] .aw-sw')].find((b) => b.dataset.hex === ${JSON.stringify(FAV_BG)}).focus()`);
    await ui.press('Delete');
    await ui.waitFor(`!${favHexes}.includes(${JSON.stringify(FAV_BG)})`, 'убран клавишей Delete');
    await ui.click(`${palette}.querySelector('[aria-label="Свой цвет — в избранное"]')`, 'фон в избранное снова');
    await ui.waitFor(`${favHexes}.includes(${JSON.stringify(FAV_BG)})`, 'снова в избранном');
    await ui.press('Escape');

    // Переживает перезагрузку страницы.
    await ui.reload('перезагрузка');
    await ui.waitFor(`!!${doc}`, 'редактор после перезагрузки');
    await ui.click(doc, 'текст');
    await openPalette('text');
    assert.deepEqual(await ui.evaluate(favHexes), [FAV_TEXT]);
    await ui.press('Escape');
  });

  it('шаблон: цвет, фон, подчёркивание цветом, Times New Roman, выравнивание, таблица 40/60 с заливкой, две картинки', async () => {
    await ui.click(doc, 'текст шаблона');
    await ui.selectAll();
    await ui.insertText('Фиолетовый текст');
    for (const line of ['Выделено маркером', 'Подчёркнуто цветом', 'Шрифт Times', 'По центру', 'Текст рядом с картинкой справа']) {
      await ui.press('Enter');
      await ui.insertText(line);
    }

    await select('Фиолетовый');
    await openPalette('text');
    await ui.click(`[...${palette}.querySelectorAll('[data-testid=palette-favorites] .aw-sw')].find((b) => b.dataset.hex === ${JSON.stringify(FAV_TEXT)})`, 'цвет из избранного');
    // Браузер показывает встроенный стиль в своём виде (rgb), поэтому в редакторе — вычисленный цвет; HTML — после сохранения.
    await ui.waitFor(`[...${doc}.querySelectorAll('span')].find((x) => x.textContent === 'Фиолетовый')?.style.color === 'rgb(124, 58, 237)'`, 'цветной текст');
    assert.match(await ui.evaluate(`${main('text')}.getAttribute('aria-label')`), /#7C3AED/, 'основная часть — последний цвет');

    await select('маркером');
    await ui.click(main('highlight'), 'фон текста — последний цвет');
    await ui.waitFor(`[...${doc}.querySelectorAll('span')].find((x) => x.textContent === 'маркером')?.style.backgroundColor === 'rgb(254, 240, 138)'`, 'фон текста');
    // Контраст: тёмно-синий фон под тёмным текстом — предупреждение в палитре.
    await openPalette('highlight');
    await ui.evaluate(`[...${palette}.querySelectorAll('.aw-sw')].find((b) => b.dataset.hex === '#BFDBFE').focus()`);
    assert.equal(await ui.evaluate(`!!${palette}.querySelector('.aw-pal-warn')`), false, 'голубой фон читается');
    await ui.type(`${palette}.querySelector('input[aria-label^="Свой цвет"]')`, '#1E3A8A');
    await ui.waitFor(`${palette}.querySelector('.aw-pal-warn')?.textContent === 'Текст будет плохо виден'`, 'предупреждение о контрасте');
    await ui.press('Escape');

    await select('цветом');
    await openPalette('underline');
    await ui.click(`[...${palette}.querySelectorAll('[data-testid=palette-favorites] .aw-sw')].find((b) => b.dataset.hex === ${JSON.stringify(FAV_TEXT)})`, 'подчёркивание цветом из избранного');
    await ui.waitFor(`[...${doc}.querySelectorAll('u')].find((x) => x.textContent === 'цветом')?.style.textDecorationColor === 'rgb(124, 58, 237)'`, 'цветное подчёркивание');

    await select('Times');
    await ui.select(`${ed}.querySelector('select[aria-label="Шрифт"]')`, 'times', 'шрифт');
    await ui.waitFor(`[...${doc}.querySelectorAll('span')].find((x) => x.textContent === 'Times')?.style.fontFamily.includes('Times New Roman')`, 'Times New Roman');

    await select('По центру');
    await ui.mod('e');
    await ui.waitFor(`[...${doc}.querySelectorAll('p')].find((p) => p.textContent === 'По центру')?.style.textAlign === 'center'`, 'Ctrl+E — по центру');
    await select('Шрифт Times');
    await ui.click(tb('Выравнивание'), 'меню выравнивания');
    await ui.click(`${ed}.querySelector('.aw-menu [aria-label^="По правому краю"]')`, 'по правому краю');
    await ui.waitFor(`[...${doc}.querySelectorAll('p')].find((p) => p.textContent.startsWith('Шрифт'))?.style.textAlign === 'right'`, 'по правому краю');
    // «Очистить форматирование» снимает выравнивание и вернём его клавишей.
    await ui.click(tb('Очистить форматирование'), 'очистить');
    await ui.waitFor(`![...${doc}.querySelectorAll('p')].find((p) => p.textContent.startsWith('Шрифт'))?.style.textAlign`, 'выравнивание снято');
    assert.equal(await ui.evaluate(`[...${doc}.querySelectorAll('span')].some((x) => x.style.fontFamily.includes('Times New Roman'))`), false, 'шрифт снят');
    await ui.select(`${ed}.querySelector('select[aria-label="Шрифт"]')`, 'times', 'шрифт снова');
    await ui.waitFor(`[...${doc}.querySelectorAll('span')].some((x) => x.style.fontFamily.includes('Times New Roman'))`, 'Times New Roman снова');

    // Таблица: 2 столбца, ширины 40/60, заливка заголовка цветом из избранного фона.
    await select('Текст рядом');
    await ui.press('End');
    await ui.click(tb('Таблица'), 'вставить таблицу');
    await ui.waitFor(`!!${doc}.querySelector('table')`, 'таблица');
    await ui.click(tb('Удалить столбец'), 'минус столбец');
    await ui.waitFor(`${doc}.querySelector('table tr').children.length === 2`, 'два столбца');
    await ui.click(`${doc}.querySelector('table th')`, 'первая ячейка заголовка');
    await ui.insertText('Временный доступ');
    await ui.type(`${ed}.querySelector('input[aria-label="Ширина столбца, %"]')`, '40');
    await ui.press('Enter');
    await ui.waitFor(`[...${doc}.querySelector('table tr').children].map((c) => c.getAttribute('width')).join() === '40%,60%'`, 'ширины 40/60');
    await openPalette('cell');
    assert.ok((await ui.evaluate(favHexes)).includes(FAV_BG), 'избранный фон — в заливке');
    await ui.click(`[...${palette}.querySelectorAll('[data-testid=palette-favorites] .aw-sw')].find((b) => b.dataset.hex === ${JSON.stringify(FAV_BG)})`, 'заливка из избранного');
    await ui.waitFor(`${doc}.querySelector('table th')?.style.backgroundColor === 'rgb(253, 230, 138)'`, 'заливка заголовка');

    // Картинки: вставить в начало и в конец, первую — по центру, вторую — справа с обтеканием, шире 280 — предупреждение.
    await select('Фиолетовый');
    await ui.press('Home');
    // Выбор файла: селектор CSS; видимый редактор — тот, чей родитель не hidden (вкладка RU).
    const fileInput = '.aw-bilingual > div:not([hidden]) .aw-editor input[type=file]';
    await ui.setFiles(fileInput, [join(tmp, 'center.png')]);
    await ui.waitFor(`${doc}.querySelectorAll('img').length === 1`, 'картинка 1');
    await select('Текст рядом');
    await ui.press('Home');
    await ui.setFiles(fileInput, [join(tmp, 'side.png')]);
    await ui.waitFor(`${doc}.querySelectorAll('img').length === 2`, 'картинка 2');
    const imgPanel = `document.querySelector('[data-testid=image-panel]')`;
    await ui.click(`${doc}.querySelectorAll('img')[0]`, 'выбрать картинку 1');
    await ui.waitFor(`!!${imgPanel}?.offsetParent`, 'панель картинки');
    await ui.click(`${imgPanel}.querySelector('[aria-label="По центру"]')`, 'по центру');
    await ui.waitFor(`${doc}.querySelectorAll('img')[0].dataset.align === 'center'`, 'картинка по центру');
    await ui.click(`${doc}.querySelectorAll('img')[1]`, 'выбрать картинку 2');
    await ui.waitFor(`!!${imgPanel}?.offsetParent`, 'панель картинки 2');
    await ui.click(`${imgPanel}.querySelector('[aria-label="Справа, текст слева"]')`, 'справа с обтеканием');
    await ui.waitFor(`${doc}.querySelectorAll('img')[1].dataset.align === 'wrap-right'`, 'обтекание справа');
    await ui.click(`${imgPanel}.querySelector('[aria-label="75% ширины письма"]')`, '75%');
    await ui.waitFor(`(${imgPanel}.querySelector('.aw-img-warn')?.textContent ?? '').includes('не шире 280 px')`, 'предупреждение о ширине');
    await ui.click(`${imgPanel}.querySelector('.aw-img-warn button')`, 'уменьшить до 280');
    await ui.waitFor(`${doc}.querySelectorAll('img')[1].getAttribute('width') === '280'`, 'ширина 280');

    await ui.click($.button('Сохранить'), 'сохранить шаблон');
    await ui.waitFor(`(document.querySelector('.toast.on')?.textContent ?? '').length > 0`, 'сохранено');
    const t = await api('GET', `/api/v1/awareness/templates/${templateId}`);
    const html = t.content.htmlRu;
    for (const part of ['color:#7C3AED', 'background-color:#FEF08A', 'text-decoration-color:#7C3AED', "font-family:'Times New Roman', Times, serif",
      'style="text-align:center"', 'width="40%"', 'width="60%"', 'background-color:#FDE68A', 'data-align="center"', 'data-align="wrap-right"', 'width="280"']) {
      assert.ok(html.includes(part), `в шаблоне: ${part}\n${html.slice(0, 2000)}`);
    }
  });

  it('письмо из шаблона → предпросмотр как в почте → .eml: bgcolor, width="40%", align у картинки, Times New Roman, цвет подчёркивания', async () => {
    const r = await api('POST', `/api/v1/awareness/templates/${templateId}/letter`, { title: `${RUN} Доступ к флешке`, kind: 'planned', values: {} });
    const id = r.letter.id;
    assert.ok(id, JSON.stringify(r));
    letters.push(id);
    await ui.goto(`/awareness/letters?letter=${id}`);
    const panel = `document.querySelector('[data-testid=letter-panel]')`;
    await ui.waitFor(`!!${panel}?.querySelector('.aw-doc')`, 'карточка письма');
    await ui.waitFor(`[...${panel}.querySelectorAll('.aw-doc span')].some((x) => x.style.fontFamily.includes('Times New Roman'))`, 'оформление в письме');
    await ui.click(`[...${panel}.querySelectorAll('[role=tab]')].find((b) => b.textContent === 'Экспорт')`, 'вкладка «Экспорт»');
    await ui.waitFor(`!!${panel}.querySelector('[data-testid=mail-preview] iframe')`, 'предпросмотр');
    const src = await ui.evaluate(`${panel}.querySelector('[data-testid=mail-preview] iframe').getAttribute('src')`);
    const preview = await ui.evaluate(`fetch(${JSON.stringify(src)}).then((x) => x.text())`);
    const eml = await ui.evaluate(`fetch('/api/v1/awareness/letters/${id}/export.eml?lang=ru').then((x) => x.text())`);
    const htmlPart = eml.split('Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n')[1]?.split('\r\n--')[0] ?? '';
    const mail = Buffer.from(htmlPart.replace(/\r\n/g, ''), 'base64').toString('utf8');
    for (const [name, html] of [['предпросмотр', preview], ['.eml', mail]]) {
      for (const part of ['bgcolor="#FDE68A"', 'width="40%"', 'width="60%"', '<table width="100%"', 'align="right" hspace="12"', 'align="center"',
        "font-family:'Times New Roman', Times, serif", 'text-decoration-color:#7C3AED', 'color:#7C3AED', 'background-color:#FEF08A']) {
        assert.ok(html.includes(part), `${name}: ${part}`);
      }
      // Классы w600 — у таблиц макета 1.12.0 (ширина карточки на телефоне); в содержимом — ни float, ни div, ни классов.
      const content = html.slice(html.indexOf('Фиолетовый') - 400, html.indexOf('Постоянный') + 200);
      assert.doesNotMatch(content, /float:|class="|<div/, `${name}: содержимое без float, div и классов`);
    }
  });
});
