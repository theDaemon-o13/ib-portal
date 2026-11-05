// Сквозной тест учебных писем (релиз 1.9.0, docs/specs/awareness.md, часть 2): Chrome → Vite (прокси /api) →
// backend → PostgreSQL, настоящие щелчки и ввод с клавиатуры.
//
//   npm run test:e2e   (логин и пароль администратора — из frontend/.env.e2e или E2E_LOGIN / E2E_PASSWORD)
//
// Путь: правило с шаблоном → «Проверить сейчас» → задача на доске → «Взять себе» → письмо из шаблона заполнено →
// на согласование → начальник ИБ утверждает → «Отметить отправленным» → запись в «Рассылках» с «Согласованием» →
// письмо заморожено, правка недоступна, «Создать копию» работает. Экспорт .eml — с проверкой содержимого файла.
// Права: сотрудник ИБ не утверждает; без ib.work и служебной учётной записи раздела нет; «Подпись ИБ» — только при
// settings.manage и ib.work. Данные — с меткой прогона; в конце письма, шаблон, правило, задачи и запись «Рассылок» —
// в архив, пользователи отключаются (отметка «Начальник ИБ» снимается вместе с отключением).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { $, launchBrowser, portalToday } from './browser.mjs';
import { restoreIbHead, saveIbHead } from './ib-head.mjs';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const LOGIN = process.env.E2E_LOGIN;
const PASSWORD = process.env.E2E_PASSWORD;
const RUN = `E2E-${Date.now().toString(36)}`;

let ui;
let navSeq = 0;
/** Держатель отметки «Начальник ИБ» до прогона — ему она возвращается в after. */
let savedHead;
const users = {};
const ids = { template: null, rule: null, letters: new Set(), tasks: new Set(), records: new Set() };
const admin = { key: 'admin', get login() { return LOGIN; }, get password() { return PASSWORD; }, set password(_) { /* не меняется */ } };

async function api(method, path, body) {
  const res = await ui.evaluate(`fetch(${JSON.stringify(path)}, ${JSON.stringify(body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })})
    .then(async (r) => ({ status: r.status, text: await r.text() }))`);
  assert.ok(res.status >= 200 && res.status < 300, `${method} ${path} → ${res.status} ${res.text}`);
  return res.text ? JSON.parse(res.text) : null;
}
const status = (method, path) => ui.evaluate(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)} }).then(async (r) => ({ status: r.status, body: await r.text() }))`);

async function loginAs(u) {
  await api('POST', '/api/v1/auth/logout').catch(() => undefined);
  await ui.goto(`/login?n=${++navSeq}`);
  await ui.type(`document.querySelector('input[name=username]')`, u.login);
  await ui.type(`document.querySelector('input[name=password]')`, u.password);
  await ui.click(`document.querySelector('form button[type=submit]')`);
  await ui.waitFor(`location.pathname !== '/login'`, `вход ${u.login}`);
  if (await ui.evaluate(`location.pathname === '/change-password'`)) {
    const next = `Пис-${RUN.slice(4)}-${u.key}-Zq9!`;
    await ui.type(`document.querySelector('input[autocomplete=current-password]')`, u.password);
    await ui.type(`document.querySelectorAll('input[autocomplete=new-password]')[0]`, next);
    await ui.type(`document.querySelectorAll('input[autocomplete=new-password]')[1]`, next);
    await ui.click($.button('Сменить пароль'));
    await ui.waitFor(`location.pathname !== '/change-password'`, `смена пароля ${u.login}`);
    u.password = next;
  }
}

const panel = `document.querySelector('[data-testid=letter-panel]')`;
const statusChip = `${panel}?.querySelector('[data-testid=letter-status]')?.textContent`;
const visibleDoc = `[...${panel}.querySelectorAll('.aw-doc')].find((d) => d.offsetParent)`;

async function openLetter(id) {
  await ui.goto(`/awareness/letters?letter=${id}&n=${++navSeq}`);
  await ui.waitFor(`!!${panel}?.querySelector('.aw-doc')`, 'карточка письма с редактором');
}

/** Заменить текст видимого редактора и вернуть блок «Подпись ИБ» кнопкой панели. */
async function retypeEditor(text) {
  await ui.click(visibleDoc, 'текст письма');
  await ui.selectAll();
  await ui.insertText(text);
  await ui.waitFor(`!${visibleDoc}.textContent.includes('{{')`, 'текст заменён');
  await ui.click(`[...${panel}.querySelectorAll('.aw-toolbar')].find((t) => t.offsetParent)?.querySelector('[aria-label="Вставить блок «Подпись ИБ»"]')`, 'кнопка «Подпись ИБ»');
  await ui.waitFor(`!!${visibleDoc}.querySelector('.aw-sig')`, 'блок подписи в тексте');
}

const toastIs = (prefix) => `(document.querySelector('.toast.on')?.textContent ?? '').startsWith(${JSON.stringify(prefix)})`;

before(async () => {
  assert.ok(LOGIN && PASSWORD, 'Задайте E2E_LOGIN и E2E_PASSWORD (пользователь с ролью «Супер-администратор»)');
  ui = await launchBrowser({ baseUrl: BASE });
  await loginAs(admin);
  const roles = (await api('GET', '/api/v1/roles')).items;
  const role = (code) => roles.find((r) => r.code === code).id;
  for (const [key, fullName, codes] of [
    ['staff', 'Сотрудник Писем', ['ib_staff']],
    ['head', 'Начальник Писем', ['ib_staff', 'ib_head']],
    ['reader', 'Читатель Писем', ['doc_reader']],
    ['service', 'Служебный Писем', ['portal_admin']],
  ]) {
    const r = await api('POST', '/api/v1/users', { login: `${RUN.toLowerCase()}.${key}`, fullName: `${fullName} ${RUN}`, roleIds: codes.map(role) });
    users[key] = { key, id: r.user.id, login: r.user.login, fullName: r.user.fullName, password: r.temporaryPassword, version: r.user.version };
  }
  // Утверждает держатель отметки «Является начальником ИБ» (ADR-0027): запомнить прежнего, передать начальнику прогона.
  savedHead = await saveIbHead(ui);
  const marked = await api('PUT', `/api/v1/users/${users.head.id}/ib-head`, { version: users.head.version, value: true, transfer: true });
  assert.equal(marked.isIbHead, true);
});

after(async () => {
  if (!ui) return;
  try {
    await cleanup();
  } finally {
    // Отметку «Начальник ИБ» — прежнему держателю, даже если тест или уборка упали.
    await loginAs(admin).catch(() => undefined);
    console.log(`Начальник ИБ: ${await restoreIbHead(ui, savedHead)}`);
    ui.close();
  }
});

async function cleanup() {
  await loginAs(admin).catch(() => undefined);
  const letters = await api('GET', `/api/v1/awareness/letters?scope=all&q=${encodeURIComponent(RUN)}&limit=200`).catch(() => ({ items: [] }));
  for (const l of letters.items) if (!l.archived) await api('POST', `/api/v1/awareness/letters/${l.id}/archive`, { version: l.version }).catch(() => undefined);
  if (ids.rule) {
    const r = await api('GET', `/api/v1/awareness/rules/${ids.rule}`).catch(() => null);
    if (r && !r.archived) await api('POST', `/api/v1/awareness/rules/${ids.rule}/archive`, { version: r.version }).catch(() => undefined);
  }
  if (ids.template) {
    const t = await api('GET', `/api/v1/awareness/templates/${ids.template}`).catch(() => null);
    if (t && !t.archived) await api('POST', `/api/v1/awareness/templates/${ids.template}/archive`, { version: t.version }).catch(() => undefined);
  }
  for (const id of ids.tasks) {
    const t = await api('GET', `/api/v1/tasks/${id}`).catch(() => null);
    if (t && !t.archived) await api('POST', `/api/v1/tasks/${id}/archive`, { version: t.version }).catch(() => undefined);
  }
  for (const id of ids.records) {
    const r = await api('GET', `/api/v1/register-records/${id}`).catch(() => null);
    if (r && !r.archived) await api('POST', `/api/v1/register-records/${id}/archive`, { version: r.version }).catch(() => undefined);
  }
  for (const u of Object.values(users)) {
    const cur = (await api('GET', '/api/v1/users').catch(() => ({ items: [] }))).items.find((x) => x.id === u.id);
    if (cur?.isActive) await api('POST', `/api/v1/users/${u.id}/disable`, { version: cur.version }).catch(() => undefined);
  }
  assert.deepEqual(ui.consoleErrors, [], 'ошибки JavaScript в странице');
}

describe('Учебные письма: от правила до «Отправлено»', () => {
  it('правило с шаблоном → задача → письмо заполнено → согласование → отправка → «Рассылки» → заморожено, копия', async () => {
    // Шаблон и правило — администратор через интерфейс расписания (шаблон — через API, его экран проверен отдельно).
    const tpl = await api('POST', '/api/v1/awareness/templates', {
      title: `${RUN} Шаблон звонков`,
      subjectRu: 'Осторожно: {{схема}}', subjectTj: 'Эҳтиёт: {{схема}}',
      htmlRu: '<p>Схема: {{схема}}.</p><p>{{подпись}}</p>', htmlTj: '<p>Нақша: {{схема}}.</p><p>{{подпись}}</p>',
    });
    ids.template = tpl.template.id;

    const [y, m, d] = portalToday(10).split('-').map(Number);
    await ui.goto(`/awareness/schedule?rule=new&n=${++navSeq}`);
    const rp = `document.querySelector('[data-testid=rule-panel]')`;
    await ui.waitFor(`!!${rp}`, 'форма правила');
    await ui.type($.field('Название', rp), `${RUN} Ежегодная`);
    await ui.select($.field('Периодичность', rp), 'yearly');
    await ui.select($.field('Месяц', rp), String(m));
    await ui.select($.field('День', rp), String(d));
    await ui.type($.field('Опережение', rp), '20');
    const staffRole = await ui.evaluate(`[...${$.field('Роль-исполнитель', rp)}.options].find((o) => o.text.startsWith('Сотрудник ИБ'))?.value`);
    await ui.select($.field('Роль-исполнитель', rp), staffRole);
    await ui.waitFor(`[...${$.field('Шаблон', rp)}.options].some((o) => o.value === ${JSON.stringify(ids.template)})`, 'шаблон в списке');
    await ui.select($.field('Шаблон', rp), ids.template);
    await ui.waitFor(`!!${rp}.querySelector('[data-testid=rule-dates] li')`, 'ближайшие даты');
    assert.match(await ui.text(`${rp}.querySelector('[data-testid=rule-dates]')`), new RegExp(String(y)));
    await ui.click($.button('Создать правило', rp));
    await ui.waitFor(toastIs('Правило'), 'правило создано');
    ids.rule = await ui.evaluate(`new URLSearchParams(location.search).get('rule')`);
    await ui.waitFor(`!!${$.button('Проверить сейчас', rp)}`, 'кнопка «Проверить сейчас»');
    await ui.click($.button('Проверить сейчас', rp));
    await ui.waitFor(toastIs('Проверено: создано задач: 1'), 'задача создана');
    await ui.waitFor(`!!${rp}.querySelector('[data-testid=rule-runs] a')`, 'запуск в карточке правила');

    // Задача на доске: общая, взять может сотрудник ИБ (держатель роли).
    await loginAs(users.staff);
    const tasks = (await api('GET', '/api/v1/tasks?archived=false')).items;
    let task = tasks.find((t) => t.title.startsWith(`Рассылка: ${RUN} Ежегодная`));
    assert.ok(task, 'задача «Рассылка: …» на доске');
    ids.tasks.add(task.id);
    assert.equal(task.origin?.kind, 'schedule');
    await ui.goto(`/tasks?task=${task.id}&n=${++navSeq}`);
    const drawer = `document.querySelector('aside.drawer[aria-label="Задача"]')`;
    await ui.waitFor(`!!${drawer}?.querySelector('[data-testid=task-origin]')`, 'блок «Рассылка по расписанию»');
    assert.match(await ui.text(`${drawer}.querySelector('.dp-eyebrow')`), new RegExp(`создана расписанием: ${RUN} Ежегодная`));
    await ui.click($.button('Взять себе', drawer));
    await ui.waitFor(`!${$.button('Взять себе', drawer)}`, 'задача взята');
    task = await api('GET', `/api/v1/tasks/${task.id}`);
    assert.equal(task.assignee?.id, users.staff.id);
    const letterId = task.origin.letter.id;
    ids.letters.add(letterId);

    // Черновик из шаблона: переменные в тексте — на согласование нельзя; заполнить в редакторе.
    await ui.click(`${drawer}.querySelector('[data-testid=task-origin] a')`, 'ссылка на письмо');
    await ui.waitFor(`!!${panel}?.querySelector('.aw-doc')`, 'карточка письма');
    assert.equal(await ui.evaluate(statusChip), 'Черновик');
    await ui.click($.button('На согласование', panel));
    await ui.waitFor(`(document.querySelector('.toast.on')?.textContent ?? '').includes('Заполните переменные')`, 'незаполненные переменные');
    await ui.type(`${panel}.querySelector('.aw-subject input')`, 'Осторожно: звонок «службы безопасности»');
    await retypeEditor('Схема: звонок «службы безопасности» с просьбой назвать код из SMS.');
    await ui.click(`[...${panel}.querySelectorAll('[role=tab]')].find((b) => b.textContent.startsWith('TJ'))`, 'вкладка TJ');
    await ui.type(`${panel}.querySelector('.aw-subject input')`, 'Эҳтиёт: занг аз «хадамоти амният»');
    await retypeEditor('Нақша: занг бо хоҳиши гуфтани рамзи SMS.');
    await ui.click($.button('Сохранить', panel));
    await ui.waitFor(toastIs('Сохранено, версия 2'), 'сохранено');
    await ui.click($.button('На согласование', panel));
    await ui.waitFor(`${statusChip} === 'На согласовании'`, 'на согласовании');
    assert.equal(await ui.evaluate(`!!${$.button('Утвердить', panel)}`), false, 'сотрудник ИБ не утверждает');

    // Начальник ИБ утверждает; письмо он не писал — без пометки «без независимого согласования».
    await loginAs(users.head);
    await openLetter(letterId);
    await ui.click($.button('Утвердить', panel));
    await ui.waitFor(`${statusChip} === 'Утверждено'`, 'утверждено');
    assert.equal(await ui.evaluate(`[...${panel}.querySelectorAll('[data-testid=letter-mark]')].length`), 0);

    // Исполнитель отмечает отправку: дата сегодня, аудитория.
    await loginAs(users.staff);
    await openLetter(letterId);
    await ui.click($.button('Отметить отправленным', panel));
    const dlg = `document.querySelector('[data-testid=send-dialog]')`;
    await ui.waitFor(`!!${dlg}`, 'окно отправки');
    await ui.type($.field('Аудитория', dlg), 'Все сотрудники');
    await ui.click(`${dlg}.querySelector('button[type=submit]')`, 'Отметить');
    await ui.waitFor(`${statusChip} === 'Отправлено'`, 'отправлено');

    // Заморожено: правки нет, редактор только для чтения, «Создать копию» есть.
    assert.equal(await ui.evaluate(`!!${$.button('Сохранить', panel)}`), false);
    assert.equal(await ui.evaluate(`${visibleDoc}.getAttribute('contenteditable')`), 'false');
    assert.match(await ui.text(`${panel}.querySelector('.note.ro')`), /отправлено — его нельзя изменить/);

    // Запись «Рассылок»: «Письмо» ссылкой, «Согласование» — «Согласовано».
    const sent = await api('GET', `/api/v1/awareness/letters/${letterId}`);
    const rec = sent.events.find((e) => e.action === 'sent').record;
    assert.ok(rec, 'запись «Рассылок» в событии отправки');
    ids.records.add(rec.id);
    await ui.goto(`/registers/${rec.registerId}/records?n=${++navSeq}`);
    const row = `[...document.querySelectorAll('tbody tr')].find((tr) => tr.textContent.includes('звонок «службы безопасности»'))`;
    await ui.waitFor(`!!${row}?.querySelector('[data-testid=letter-ref]')`, 'строка «Рассылок» со ссылкой на письмо');
    assert.match(await ui.text(row), /Согласовано/);
    assert.match(await ui.text(`${row}.querySelector('[data-testid=letter-ref]')`), new RegExp(`№ ${sent.number}, версия ${sent.sentVersionNo}`));

    // «Создать копию» — новый черновик с тем же содержимым.
    await openLetter(letterId);
    await ui.click($.button('Создать копию', panel));
    await ui.waitFor(`${statusChip} === 'Черновик' && ${panel}.querySelector('.dr-title').textContent.includes('(копия)')`, 'копия открылась');
    ids.letters.add(await ui.evaluate(`new URLSearchParams(location.search).get('letter')`));
    // Задача рассылки открыта: в её истории — отметка отправки, подсказка завершить.
    const t2 = await api('GET', `/api/v1/tasks/${task.id}`);
    assert.equal(t2.completedAt, null);
    assert.equal(t2.origin.letterSent, true);
  });

  it('экспорт .eml: X-Unsent, тема RU / TJ по RFC 2047, multipart/alternative, текст с подписью', async () => {
    await loginAs(users.staff);
    const letter = (await api('GET', `/api/v1/awareness/letters?scope=all&q=${encodeURIComponent(`${RUN} Ежегодная`)}`)).items.find((l) => l.status === 'sent');
    assert.ok(letter, 'отправленное письмо прогона');
    await openLetter(letter.id);
    await ui.click(`[...${panel}.querySelectorAll('[role=tab]')].find((b) => b.textContent === 'Экспорт')`, 'вкладка «Экспорт»');
    await ui.waitFor(`!!${panel}.querySelector('[data-testid=export-preview]')`, 'предпросмотр');
    await ui.click(`[...${panel}.querySelectorAll('[data-testid=letter-export] .filters button')].find((b) => b.textContent === 'RU + TJ')`, 'RU + TJ');
    await ui.click($.button('Скачать .eml', panel));
    await ui.waitFor(`(document.querySelector('.toast.on')?.textContent ?? '').includes('.eml скачан')`, 'файл скачан');

    // Содержимое — тот же файл, что скачал браузер.
    const eml = await ui.evaluate(`fetch('/api/v1/awareness/letters/${letter.id}/export.eml?lang=both').then(async (r) => ({ type: r.headers.get('content-type'), name: r.headers.get('content-disposition'), body: await r.text() }))`);
    assert.match(eml.type, /message\/rfc822/);
    assert.match(eml.name, /filename\*=UTF-8''/);
    const [head, ...rest] = eml.body.split('\r\n\r\n');
    assert.match(head, /^MIME-Version: 1\.0\r\nX-Unsent: 1\r\nSubject: =\?UTF-8\?B\?/);
    assert.doesNotMatch(head, /^(From|To|Date):/m);
    const subject = [...head.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)].map((m) => Buffer.from(m[1], 'base64').toString('utf8')).join('');
    assert.equal(subject, 'Осторожно: звонок «службы безопасности» / Эҳтиёт: занг аз «хадамоти амният»');
    assert.match(head, /Content-Type: multipart\/alternative; boundary=/);
    const body = rest.join('\r\n\r\n');
    const plain = Buffer.from(body.split('Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n')[1].split('\r\n--')[0].replace(/\r\n/g, ''), 'base64').toString('utf8');
    assert.match(plain, /Схема: звонок «службы безопасности» с просьбой назвать код из SMS\./);
    assert.match(plain, /Нақша: занг/);
    const sig = await api('GET', '/api/v1/awareness/signature');
    const sigText = sig.htmlRu.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (sigText) assert.ok(plain.includes(sigText), `подпись в тексте: ${sigText}`);
    assert.match(body, /Content-Type: multipart\/related/);
  });
});

describe('Учебные письма: права', () => {
  it('«Подпись ИБ» — только при settings.manage и ib.work; без ib.work и служебной учётной записи раздела нет', async () => {
    await loginAs(admin);
    await ui.goto(`/settings/signature?n=${++navSeq}`);
    await ui.waitFor(`!!document.querySelector('[data-testid=signature-settings]')`, 'вкладка «Подпись ИБ» у администратора');

    await loginAs(users.staff);
    await ui.goto(`/settings/catalogs?n=${++navSeq}`);
    await ui.waitFor(`!!document.querySelector('[role=tablist]')`, 'настройки сотрудника');
    assert.equal(await ui.evaluate(`[...document.querySelectorAll('[role=tablist] a, [role=tablist] button')].some((t) => t.textContent === 'Подпись ИБ')`), false, 'у сотрудника нет «Подписи ИБ»');
    assert.equal((await status('PUT', '/api/v1/awareness/signature')).status >= 400, true);

    for (const u of [users.reader, users.service]) {
      await loginAs(u);
      assert.equal(await ui.evaluate(`[...document.querySelectorAll('nav a, aside a')].some((a) => a.textContent.trim() === 'Осведомлённость')`), false, `${u.key}: пункта меню нет`);
      await ui.goto(`/awareness/letters?n=${++navSeq}`);
      await ui.waitFor(`location.pathname !== '/awareness/letters'`, `${u.key}: раздел закрыт`);
      const r = await status('GET', '/api/v1/awareness/letters');
      assert.equal(r.status, 403, `${u.key}: ${r.body}`);
      if (u === users.service) {
        assert.match(r.body, /SERVICE_ACCOUNT/);
        await ui.goto(`/settings/catalogs?n=${++navSeq}`);
        await ui.waitFor(`!!document.querySelector('[role=tablist]')`, 'настройки служебной учётной записи');
        assert.equal(await ui.evaluate(`[...document.querySelectorAll('[role=tablist] a, [role=tablist] button')].some((t) => t.textContent === 'Подпись ИБ')`), false, 'у служебной нет «Подписи ИБ»');
      }
    }
  });
});
