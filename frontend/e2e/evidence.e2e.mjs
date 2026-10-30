// Сквозной тест этапа 7 тем же путём, что и браузер пользователя: Chrome → Vite (прокси /api) → backend → PostgreSQL.
// Загрузка файлов через <input type=file>, проверка типа по содержимому, просмотр в карточке (изображение, PDF через
// pdf.js из сборки, CSV), проверка ИБ с разделением полномочий, решение ОУР только с документом.
//
//   npm run test:e2e   (логин и пароль администратора — из frontend/.env.e2e или E2E_LOGIN / E2E_PASSWORD)
//
// В конце доказательства, записи, задачи, шаблон и система прогона уходят в архив, пользователи отключаются.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { $, launchBrowser } from './browser.mjs';
import { pickFiles, tempFile, tinyPdf, tinyPng } from './files.mjs';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const LOGIN = process.env.E2E_LOGIN;
const PASSWORD = process.env.E2E_PASSWORD;
const RUN = `E2E-${Date.now().toString(36)}`;

let ui;
let navSeq = 0;
const users = {};
const made = { system: null, template: null, records: [] };

const drawer = `document.querySelector('aside.drawer[aria-label="Доказательство"]')`;
const form = `document.querySelector('form[aria-label="Загрузить доказательство"]')`;
const label = (text, within) => `[...(${within}).querySelectorAll('label')].find((l) => l.firstChild?.textContent?.trim() === ${JSON.stringify(text)})?.querySelector('input, select, textarea')`;

async function api(method, path, body) {
  const res = await ui.evaluate(`fetch(${JSON.stringify(path)}, ${JSON.stringify(body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })})
    .then(async (r) => ({ status: r.status, text: await r.text() }))`);
  assert.ok(res.status >= 200 && res.status < 300, `${method} ${path} → ${res.status} ${res.text}`);
  return res.text ? JSON.parse(res.text) : null;
}
/** Запрос с ответом как есть: статус и заголовки (без проверки успеха). */
const raw = (path) => ui.evaluate(`fetch(${JSON.stringify(path)}).then(async (r) => ({
  status: r.status, type: r.headers.get('content-type'), disposition: r.headers.get('content-disposition'),
  nosniff: r.headers.get('x-content-type-options'), csp: r.headers.get('content-security-policy'), size: (await r.arrayBuffer()).byteLength }))`);

const newPassword = (u) => `Док-${RUN.slice(4)}-${u.key.length}-Ev7!`;
const admin = { key: 'admin', get login() { return LOGIN; }, get password() { return PASSWORD; }, set password(_) { /* не меняется */ } };

async function loginAs(u) {
  await api('POST', '/api/v1/auth/logout').catch(() => undefined);
  await ui.goto(`/login?n=${++navSeq}`);
  await ui.type(`document.querySelector('input[name=username]')`, u.login);
  await ui.type(`document.querySelector('input[name=password]')`, u.password);
  await ui.click(`document.querySelector('form button[type=submit]')`);
  await ui.waitFor(`location.pathname !== '/login'`, `вход ${u.login}`);
  if (await ui.evaluate(`location.pathname === '/change-password'`)) {
    const next = newPassword(u);
    await ui.type(`document.querySelector('input[autocomplete=current-password]')`, u.password);
    await ui.type(`document.querySelectorAll('input[autocomplete=new-password]')[0]`, next);
    await ui.type(`document.querySelectorAll('input[autocomplete=new-password]')[1]`, next);
    await ui.click($.button('Сменить пароль'));
    await ui.waitFor(`location.pathname !== '/change-password'`, `смена пароля ${u.login}`);
    u.password = next;
  }
}

/** PDF отрисован pdf.js: на canvas есть не только белые пиксели (текст страницы). */
const pdfRendered = (within) => `(() => { const c = (${within}).querySelector('.ev-prev canvas'); if (!c || !c.width) return false;
  const d = c.getContext('2d').getImageData(0, 0, c.width, Math.min(c.height, 400)).data;
  for (let i = 0; i < d.length; i += 4) if (d[i] < 200) return true; return false; })()`;

before(async () => {
  assert.ok(LOGIN && PASSWORD, 'Задайте E2E_LOGIN и E2E_PASSWORD (пользователь с ролью «Супер-администратор»)');
  ui = await launchBrowser({ baseUrl: BASE });
  await loginAs(admin);
  const roles = (await api('GET', '/api/v1/roles')).items;
  const role = (code) => roles.find((r) => r.code === code).id;
  for (const [key, fullName, codes] of [
    ['staff', 'Сотрудник Загрузил', ['ib_staff']],
    ['reviewer', 'Сотрудник Проверил', ['ib_staff']],
    ['legal', 'Читатель Документов', ['doc_reader']],
  ]) {
    const r = await api('POST', '/api/v1/users', { login: `${RUN.toLowerCase()}.${key}`, fullName: `${fullName} ${RUN}`, roleIds: codes.map(role) });
    users[key] = { key, id: r.user.id, login: r.user.login, fullName: r.user.fullName, password: r.temporaryPassword };
  }
  made.system = await api('POST', '/api/v1/catalogs/systems/items', { value: `${RUN} АБС` });
  let t = await api('POST', '/api/v1/form-templates', { name: `${RUN} Парольная защита`, basis: 'Инструкция по парольной защите', validMonths: 12 });
  t = await api('POST', `/api/v1/form-templates/${t.id}/fields`, { label: 'Минимальная длина пароля', checkKind: 'min', threshold: 12 });
  t = await api('POST', `/api/v1/form-templates/${t.id}/fields`, { label: 'MFA для привилегированных УЗ', checkKind: 'yes' });
  made.template = t;
});

after(async () => {
  if (!ui) return;
  await loginAs(admin).catch(() => undefined);
  const ev = await api('GET', `/api/v1/evidence?archived=false&q=${encodeURIComponent(RUN)}&limit=500`).catch(() => ({ items: [] }));
  for (const e of ev.items) await api('POST', `/api/v1/evidence/${e.id}/archive`, { version: e.version }).catch(() => undefined);
  for (const id of made.records) {
    const r = await api('GET', `/api/v1/register-records/${id}`).catch(() => null);
    if (r && !r.archived) await api('POST', `/api/v1/register-records/${id}/archive`, { version: r.version }).catch(() => undefined);
  }
  const tasks = await api('GET', '/api/v1/tasks?archived=false').catch(() => ({ items: [] }));
  for (const t of tasks.items.filter((x) => x.title.includes(RUN))) await api('POST', `/api/v1/tasks/${t.id}/archive`, { version: t.version }).catch(() => undefined);
  if (made.template) {
    const cur = (await api('GET', '/api/v1/form-templates').catch(() => ({ items: [] }))).items.find((x) => x.id === made.template.id);
    if (cur) await api('POST', `/api/v1/form-templates/${cur.id}/archive`, { version: cur.version }).catch(() => undefined);
  }
  if (made.system) {
    const cur = (await api('GET', '/api/v1/catalogs/systems/items').catch(() => ({ items: [] }))).items.find((x) => x.id === made.system.id);
    if (cur) await api('POST', `/api/v1/catalog-items/${cur.id}/archive`, { version: cur.version }).catch(() => undefined);
  }
  for (const u of Object.values(users)) {
    const cur = (await api('GET', '/api/v1/users').catch(() => ({ items: [] }))).items.find((x) => x.id === u.id);
    if (cur?.isActive) await api('POST', `/api/v1/users/${u.id}/disable`, { version: cur.version }).catch(() => undefined);
  }
  assert.deepEqual(ui.consoleErrors, [], 'в консоли браузера нет ошибок');
  ui.close();
});

describe('Доказательства: загрузка и просмотр файлов', () => {
  let evidenceId;

  it('форма по шаблону с файлами: подмена расширения отклонена, PNG, PDF и CSV загружены и показаны в карточке', async () => {
    await loginAs(users.staff);
    await ui.goto(`/evidence?n=${++navSeq}`);
    await ui.waitFor(`!!${form}`, 'панель «Загрузить»');
    await ui.select(label('Шаблон формы', form), made.template.id);
    await ui.select(label('Объект', form), 'system');
    await ui.select(label('Система', form), made.system.id);
    await ui.type(`${form}.querySelector('[aria-label="Минимальная длина пароля"]')`, '10');
    await ui.select(`${form}.querySelector('[aria-label="MFA для привилегированных УЗ"]')`, 'да');
    // Отметка соответствия видна до отправки: 10 < 12 — не соответствует.
    assert.deepEqual(await ui.evaluate(`[...${form}.querySelectorAll('.req .mark')].map((m) => m.textContent)`), ['✕', '✓']);

    const input = `form[aria-label="Загрузить доказательство"] input[type=file]`;
    // HTML под видом PNG: backend смотрит содержимое, файл не принимается.
    const [fake] = await pickFiles(ui, input, [tempFile('скрин.png', '<html><body><script>alert(1)</script></body></html>')]);
    assert.equal(fake.status, 400);
    await ui.waitFor(`${form}.querySelector('.form-error')?.textContent.includes('не соответствует расширению .png')`, 'ошибка подмены расширения');
    assert.equal(await ui.evaluate(`${form}.querySelectorAll('.file').length`), 0, 'поддельный файл не приложен');

    const ups = await pickFiles(ui, input, [
      tempFile(`${RUN} GPO.png`, tinyPng()),
      tempFile(`${RUN} Политика паролей.pdf`, tinyPdf('Password policy 12 chars')),
      tempFile(`${RUN} выгрузка.csv`, Buffer.from('Параметр;Значение\nMinimumPasswordLength;10\nMFA;да\n', 'utf8')),
    ]);
    assert.deepEqual(ups.map((r) => r.status), [201, 201, 201]);
    await ui.waitFor(`${form}.querySelectorAll('.file').length === 3`, 'три файла в форме');
    await ui.type(label('Подтвердил со стороны ДИКТ', form), 'Т. Абрамцев, ДИКТ');
    const m = ui.mark();
    await ui.click($.button('Загрузить на проверку', form));
    const created = await ui.request(m, 'POST', '/api/v1/evidence');
    assert.equal(created.status, 201, created.body);
    assert.equal(created.json.fileIds.length, 3);
    evidenceId = (await ui.response(created)).id;

    // Карточка открылась: форма со сверкой, три файла, PNG показан сразу.
    await ui.waitFor(`${drawer}?.querySelector('.dr-title')?.textContent.includes(${JSON.stringify(RUN)})`, 'карточка доказательства');
    assert.deepEqual(await ui.evaluate(`[...${drawer}.querySelectorAll('table.checks tbody tr')].map((r) => [r.cells[0].textContent, r.cells[2].textContent, r.cells[3].textContent])`),
      [['Минимальная длина пароля', '10', '✕'], ['MFA для привилегированных УЗ', 'да', '✓']]);
    assert.match(await ui.text(`${drawer}.querySelector('.meta-grid')`), /1 из 2/);
    assert.equal(await ui.evaluate(`${drawer}.querySelectorAll('.file-list .file').length`), 3);
    await ui.waitFor(`${drawer}.querySelector('.ev-prev img')?.naturalWidth > 0`, 'PNG показан');

    // PDF — pdf.js из сборки, без CDN: страница нарисована на canvas.
    const before = ui.mark();
    await ui.click(`[...${drawer}.querySelectorAll('.file-b')].find((b) => b.textContent.endsWith('.pdf'))`);
    await ui.waitFor(pdfRendered(drawer), 'PDF отрисован', 15000);
    assert.ok(ui.requestsSince(before).some((r) => r.url.endsWith('/content') && r.status === 200), 'содержимое PDF получено через backend');

    // CSV — таблицей.
    await ui.click(`[...${drawer}.querySelectorAll('.file-b')].find((b) => b.textContent.endsWith('.csv'))`);
    await ui.waitFor(`${drawer}.querySelector('table.csv-tbl')?.textContent.includes('MinimumPasswordLength')`, 'CSV показан таблицей');
    assert.equal(await ui.evaluate(`${drawer}.querySelector('table.csv-tbl th')?.textContent`), 'Параметр');

    // Сохранить файл — запрос содержимого через backend; ответ — attachment и nosniff.
    const s = ui.mark();
    await ui.click($.button('Сохранить файл', drawer));
    const saved = await ui.request(s, 'GET', '/content');
    assert.equal(saved.status, 200);
    const fileId = saved.url.split('/')[4];
    const head = await raw(`/api/v1/files/${fileId}/content`);
    assert.equal(head.type, 'text/csv');
    assert.match(head.disposition, /^attachment; filename="[^"]+"; filename\*=UTF-8''/);
    assert.equal(head.nosniff, 'nosniff');
    assert.equal(head.csp, "sandbox; default-src 'none'");

    // Своё доказательство не проверить: кнопок нет, есть пояснение.
    assert.equal(await ui.evaluate(`!!${$.button('Принять', drawer)}`), false);
    assert.match(await ui.text(`${drawer}.querySelector('.note.ro')`), /проверяет другой сотрудник/);
  });

  it('файл без права на объект не выдаётся; проверяющий отклоняет — загрузившему задача', async () => {
    const ev = await api('GET', `/api/v1/evidence/${evidenceId}`);
    const fileId = ev.fileList[0].id;
    await loginAs(users.legal);
    assert.equal((await raw(`/api/v1/files/${fileId}/content`)).status, 404, 'юрист без ib.work файл доказательства не получает');
    assert.equal((await raw(`/api/v1/evidence/${evidenceId}`)).status, 403);

    await loginAs(users.reviewer);
    await ui.goto(`/evidence?ev=${evidenceId}&n=${++navSeq}`);
    await ui.waitFor(`!!${$.button('Отклонить', drawer)}`, 'проверяющий видит «Принять / Отклонить»');
    await ui.click($.button('Отклонить', drawer));
    await ui.type(`${drawer}.querySelector('textarea')`, 'Длина пароля 10 — нужно не менее 12');
    const m = ui.mark();
    await ui.click(`[...${drawer}.querySelectorAll('form button[type=submit]')].find((b) => b.textContent === 'Отклонить')`);
    const req = await ui.request(m, 'POST', `/api/v1/evidence/${evidenceId}/review`);
    assert.equal(req.status, 200, req.body);
    assert.equal(req.json.decision, 'reject');
    await ui.waitFor(`${drawer}.querySelector('.dr-h .chip')?.textContent === 'Отклонено'`, 'статус «Отклонено»');
    // Уведомление — после перезапроса списков, позже смены статуса в карточке.
    await ui.waitFor(`document.querySelector('.toast.on')?.textContent === 'Отклонено. Загрузившему создана задача на исправление'`, 'уведомление об отклонении');
    const tasks = (await api('GET', '/api/v1/tasks?archived=false')).items.filter((t) => t.evidence?.id === evidenceId);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].assignee?.id, users.staff.id);
  });
});

describe('Риски ИБ: решение ОУР только с документом', () => {
  it('без файла решение не сохраняется; с документом — решение, «№ ОУР», «Пересмотр до» и доказательство', async () => {
    await loginAs(users.staff);
    const risks = (await api('GET', '/api/v1/registers')).items.find((r) => r.name.startsWith('Реестр рисков ИБ'));
    assert.ok(risks, 'системный «Реестр рисков ИБ» создан seed');
    const reg = await api('GET', `/api/v1/registers/${risks.id}`);
    const title = reg.fields.find((f) => f.isTitle);
    const rec = await api('POST', `/api/v1/registers/${risks.id}/records`, { values: { [title.id]: `${RUN} Компрометация УЗ AD` } });
    made.records.push(rec.id);

    await ui.goto(`/registers?record=${rec.id}&n=${++navSeq}#${risks.id}/records`);
    const rd = `document.querySelector('aside.drawer[aria-label="Запись реестра"]')`;
    await ui.waitFor(`${rd}?.textContent.includes('Решение ОУР')`, 'карточка записи по ссылке');
    await ui.click($.button('Внести решение', rd));
    const box = `${rd}.querySelector('[aria-label="Внести решение"]')`;
    await ui.waitFor(`!!${box}`, 'форма решения');
    await ui.select(label('Решение', box), reg.fields.find((f) => f.systemKey === 'decision').options.find((o) => o.label === 'Снижение').id);
    await ui.type(label('№ документа', box), '7');
    await ui.type(label('№ в реестре ОУР', box), 'ОР-2026-041');
    await ui.evaluate(`(() => { const el = ${label('Пересмотр до (по документу)', box)}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '2027-04-20'); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);

    // Без файла — отказ на месте, запрос не уходит.
    let m = ui.mark();
    await ui.click($.button('Сохранить решение', box));
    await ui.waitFor(`${box}.querySelector('.form-error')?.textContent.includes('Приложите документ-основание')`, 'без файла — отказ');
    assert.equal(ui.requestsSince(m).some((r) => r.url.endsWith('/decisions') && r.method === 'POST'), false);

    const [up] = await pickFiles(ui, `aside.drawer[aria-label="Запись реестра"] [aria-label="Внести решение"] input[type=file]`, [tempFile(`${RUN} Протокол РК 7.pdf`, tinyPdf('Risk committee 7'))]);
    assert.equal(up.status, 201);
    m = ui.mark();
    await ui.click($.button('Сохранить решение', box));
    const req = await ui.request(m, 'POST', `/api/v1/register-records/${rec.id}/decisions`);
    assert.equal(req.status, 200, req.body);
    assert.ok(req.json.fileId);
    await ui.waitFor(`${rd}.querySelector('.decision .chip')?.textContent === 'Снижение'`, 'решение в карточке');
    const after = await api('GET', `/api/v1/register-records/${rec.id}`);
    assert.equal(after.values[reg.fields.find((f) => f.systemKey === 'ormRef').id], 'ОР-2026-041');
    assert.equal(after.values[reg.fields.find((f) => f.systemKey === 'reviewDue').id], '2027-04-20');

    // Документ-основание — в истории решения и в доказательной базе; просмотр PDF прямо в карточке записи.
    await ui.click(`[...${rd}.querySelectorAll('.decision .hist button')].find((b) => b.textContent.endsWith('.pdf'))`);
    await ui.waitFor(pdfRendered(rd), 'PDF решения отрисован', 15000);
    const ev = (await api('GET', `/api/v1/evidence?objectType=record&objectId=${rec.id}`)).items;
    assert.equal(ev.length, 1);
    assert.equal(ev[0].kind, 'decision');
    assert.equal(ev[0].state, 'accepted');

    // Тот же файл нельзя «потерять»: на него ссылаются решение и доказательство.
    const meta = await api('GET', `/api/v1/files/${req.json.fileId}`);
    assert.deepEqual(meta.refs.map((r) => r.kind).sort(), ['decision', 'evidence']);
  });
});
