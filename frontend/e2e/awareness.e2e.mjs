// Сквозной тест «Осведомлённости» (релиз 1.8.0, docs/specs/awareness.md): Chrome → Vite (прокси /api) → backend → PostgreSQL.
//
//   npm run test:e2e   (логин и пароль администратора — из frontend/.env.e2e или E2E_LOGIN / E2E_PASSWORD)
//
// Загрузить сотрудников из выгрузки HR обычным импортом; импорт отчёта INDIGO с ручным выбором однофамильца;
// виджет «На пересдачу» — список по ссылке без уволенных, то же число; «Обновить по сотрудникам» со снятой строкой;
// пользователь без «Записи реестров: правка» импорта не видит. Люди и подразделения вымышленные, с меткой прогона.
// В конце: записи прогона — в архив, тестовый пользователь отключается, роль прогона удаляется.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { $, launchBrowser } from './browser.mjs';

// exceljs — из backend: тесту нужно собрать файлы, во frontend зависимость не добавляется.
const ExcelJS = createRequire(new URL('../../backend/package.json', import.meta.url))('exceljs');

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const LOGIN = process.env.E2E_LOGIN;
const PASSWORD = process.env.E2E_PASSWORD;
const RUN = `E2E-${Date.now().toString(36)}`;
// Метка прогона внутри фамилий: ФИО прогона не совпадают с прошлыми прогонами на dev.
const TAG = RUN.slice(4);
const TEST = `Тест осведомлённости ${RUN} | Awareness test`;
const tmp = mkdtempSync(join(tmpdir(), 'ibportal-awareness-'));

const P = {
  exact: `Точнов${TAG} Иван Иванович`,
  twin: `Двойнов${TAG} Пётр Петрович`,
  fired: `Уволин${TAG} Сергей Сергеевич`,
  late: `Поздний${TAG} Кирилл Тестович`,
  nobody: `Неизвестнов${TAG} Олег`,
};

let ui;
let navSeq = 0;
let regs;
let role;
let viewer;
/** Время последнего изменения результатов прогона: виджеты дашборда кэшируются на сервере на минуту. */
let changedAt = 0;

async function api(method, path, body) {
  const res = await ui.evaluate(`fetch(${JSON.stringify(path)}, ${JSON.stringify(body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })})
    .then(async (r) => ({ status: r.status, text: await r.text() }))`);
  return { status: res.status, json: res.text ? JSON.parse(res.text) : null };
}

async function ok(method, path, body) {
  const r = await api(method, path, body);
  assert.ok(r.status >= 200 && r.status < 300, `${method} ${path} → ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

/** Выйти и войти через форму; при первом входе — смена временного пароля. */
async function loginAs(login, password) {
  await api('POST', '/api/v1/auth/logout').catch(() => undefined);
  await ui.goto(`/login?n=${++navSeq}`);
  await ui.type(`document.querySelector('input[name=username]')`, login);
  await ui.type(`document.querySelector('input[name=password]')`, password);
  await ui.click(`document.querySelector('form button[type=submit]')`);
  await ui.waitFor(`location.pathname !== '/login'`, `вход ${login}`);
  if (await ui.evaluate(`location.pathname === '/change-password'`)) {
    const next = `Осв-${TAG}-Zq9!xw`;
    await ui.type(`document.querySelector('input[autocomplete=current-password]')`, password);
    await ui.type(`document.querySelectorAll('input[autocomplete=new-password]')[0]`, next);
    await ui.type(`document.querySelectorAll('input[autocomplete=new-password]')[1]`, next);
    await ui.click($.button('Сменить пароль'));
    await ui.waitFor(`location.pathname !== '/change-password'`, `смена пароля ${login}`);
    return next;
  }
  return password;
}

const openRecords = (id) => ui.goto(`/registers?run=${++navSeq}#${id}/records`);
const runRecords = async (id) => (await ok('GET', `/api/v1/registers/${id}/records?q=${encodeURIComponent(TAG.toLowerCase())}&limit=100`)).items;
const dialog = `document.querySelector('[role=dialog]')`;
const applyBtn = `[...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.startsWith('Применить'))`;

async function save(name, wb) {
  const path = join(tmp, name);
  writeFileSync(path, Buffer.from(await wb.xlsx.writeBuffer()));
  return path;
}

/** Выгрузка HR: колонки по названиям полей «Сотрудников»; ФИО одной колонкой делится портал. */
function hrFile() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('HR');
  ws.addRow(['Табельный номер', 'ФИО', 'Подразделение', 'Статус']);
  ws.addRow([`${TAG}-1`, P.exact, 'Отдел тестирования', 'Работает']);
  ws.addRow([`${TAG}-2`, P.twin, 'Отдел А', 'Работает']);
  ws.addRow([`${TAG}-3`, P.twin, 'Отдел Б', 'Работает']);
  ws.addRow([`${TAG}-4`, P.fired, 'Отдел В', 'Уволен']);
  return save(`hr ${RUN}.xlsx`, wb);
}

/** Отчёт INDIGO «Статистика по баллам», как после пересохранения в .xlsx: название теста, сводка, заголовки, тройки «Б М %». */
function indigoFile(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Статистика по баллам');
  ws.addRow([TEST]);
  ws.addRow([null, null, null, null, null, null, null, null, 'Обычные вопросы', null, null, null, 'Мультивыбор вопросы', null, null, 'Итого']);
  const n = rows.length;
  const sum = (lbl, a, b, c) => ws.addRow([null, lbl, null, null, null, null, null, null, a, null, null, null, b, null, null, c]);
  const avg = Math.round((rows.reduce((s, r) => s + r[3], 0) / n) * 10) / 10;
  sum('Всего:', n * 6, n * 4, n * 10); sum('Верно', 1, 1, 2); sum('Частично', 0, 0, 0); sum('Неверно', 1, 1, 2);
  sum('Пропущено', 0, 0, 0); sum('СреднийБалл', 5, 3, 8); sum('МаксБалл', 6, 4, 10); sum('Процент', avg, avg, avg);
  ws.addRow(['№', 'Фамилия', 'Имя', 'Отчество', 'Группа', 'Дата', 'Затрачено', null, 'Б', 'М', null, '%', 'Б', 'М', '%', 'Б', 'М', '%']);
  rows.forEach(([last, first, middle, pct], i) => ws.addRow([
    i + 1, last, first, middle, 'Группа INDIGO', '01.10.2026', '00:12:34', null,
    Math.round(pct * 0.06), 6, null, pct, Math.round(pct * 0.04), 4, pct, Math.round(pct / 10), 10, pct,
  ]));
  return save(`indigo ${RUN}.xlsx`, wb);
}
/** Строка отчёта: фамилия, имя, отчество (null — нет) и «Результат, %». */
const row = (fio, pct) => {
  const [last, first, middle = null] = fio.split(' ');
  return [last, first, middle, pct];
};

before(async () => {
  assert.ok(LOGIN && PASSWORD, 'Задайте E2E_LOGIN и E2E_PASSWORD (пользователь с ролью «Супер-администратор»)');
  ui = await launchBrowser({ baseUrl: BASE });
  await loginAs(LOGIN, PASSWORD);
  // В списке реестров ключа нет — только признак «системный»; ключ — в карточке реестра.
  const system = (await ok('GET', '/api/v1/registers')).items.filter((r) => r.system);
  const details = await Promise.all(system.map((r) => ok('GET', `/api/v1/registers/${r.id}`)));
  regs = {
    emp: details.find((r) => r.systemKey === 'awareness_employees'),
    res: details.find((r) => r.systemKey === 'awareness_results'),
  };
  assert.ok(regs.emp && regs.res, 'реестры «Сотрудники» и «Результаты INDIGO» — выполните migrate (seed awareness.v1)');
  // Роль прогона: только «Работа в разделах ИБ» — реестры видны, правки записей нет.
  role = await ok('POST', '/api/v1/roles', { name: `${RUN} просмотр` });
  role = await ok('PUT', `/api/v1/roles/${role.id}/permissions/ib.work`, { granted: true });
  const created = await ok('POST', '/api/v1/users', { login: `${RUN.toLowerCase()}.view`, fullName: `Просмотров ${TAG}`, roleIds: [role.id] });
  viewer = { id: created.user.id, login: created.user.login, password: created.temporaryPassword };
});

after(async () => {
  if (!ui) return;
  await loginAs(LOGIN, PASSWORD).catch(() => undefined);
  for (const id of [regs?.res?.id, regs?.emp?.id]) {
    if (!id) continue;
    for (const r of await runRecords(id).catch(() => [])) await api('POST', `/api/v1/register-records/${r.id}/archive`, { version: r.version });
  }
  if (viewer) {
    const u = (await api('GET', `/api/v1/users?q=${encodeURIComponent(viewer.login)}`)).json?.items.find((x) => x.id === viewer.id);
    if (u) {
      const cleared = (await api('PATCH', `/api/v1/users/${u.id}`, { version: u.version, roleIds: [] })).json ?? u;
      if (cleared.isActive) await api('POST', `/api/v1/users/${u.id}/disable`, { version: cleared.version });
    }
  }
  if (role) {
    const cur = (await api('GET', '/api/v1/roles')).json?.items.find((r) => r.id === role.id);
    if (cur) await api('POST', `/api/v1/roles/${role.id}/delete`, { version: cur.version });
  }
  await ui.close();
});

describe('Осведомлённость', () => {
  it('сотрудники из выгрузки HR: ФИО разделено, статус из файла', async () => {
    await openRecords(regs.emp.id);
    await ui.waitFor(`!!${$.button('Импорт из Excel')}`, 'экран записей «Сотрудников»');
    let m = ui.mark();
    await ui.setFiles('input[aria-label="Файл импорта"]', [await hrFile()]);
    assert.equal((await ui.request(m, 'POST', `/registers/${regs.emp.id}/file-imports`)).status, 201);
    await ui.waitFor(`!!document.querySelector('[role=dialog] .imp-kpis')`, 'предпросмотр HR');
    assert.equal(await ui.evaluate(`document.querySelector('.imp-kpis > div').textContent`), '4добавится');
    m = ui.mark();
    await ui.click(applyBtn, '«Применить»');
    assert.equal((await ui.request(m, 'POST', '/apply')).status, 200);
    await ui.waitFor(`!${dialog}`, 'окно закрыто');
    const recs = await runRecords(regs.emp.id);
    assert.equal(recs.length, 4);
    const fields = (await ok('GET', `/api/v1/registers/${regs.emp.id}`)).fields;
    const last = fields.find((f) => f.systemKey === 'lastName').id;
    assert.ok(recs.every((r) => r.display[last]?.includes(TAG)), 'фамилия выделена из ФИО');
  });

  it('импорт отчёта INDIGO: однофамилец — ручной выбор, «Точно» — сам; результат уволенного — с меткой «(уволен)»', async () => {
    const twins = (await runRecords(regs.emp.id)).filter((r) => Object.values(r.display).includes(P.twin));
    assert.equal(twins.length, 2);
    const twinB = twins.find((r) => Object.values(r.display).includes('Отдел Б'));
    const file = await indigoFile([row(P.exact, 95), row(P.twin, 40), row(P.fired, 20), row(P.nobody, 30)]);
    await openRecords(regs.res.id);
    await ui.waitFor(`!!${$.button('Импорт отчёта INDIGO')}`, 'кнопка импорта INDIGO');
    let m = ui.mark();
    await ui.setFiles('input[aria-label="Файл отчёта INDIGO"]', [file]);
    assert.equal((await ui.request(m, 'POST', `/registers/${regs.res.id}/imports?adapter=indigo`)).status, 201);
    await ui.waitFor(`!!document.querySelector('[data-testid=import-choices]')`, 'блок ручного сопоставления');
    assert.match(await ui.text(`document.querySelector('[role=dialog] .imp-kind')`), /Отчёт INDIGO/);
    const choiceRow = `[...document.querySelectorAll('[data-testid=import-choices] tr[data-row]')].find((tr) => tr.textContent.includes(${JSON.stringify(P.twin)}))`;
    await ui.waitFor(`!!(${choiceRow})`, 'строка однофамильца');
    assert.match(await ui.text(choiceRow), /однофамильцы: 2/);
    await ui.select(`${choiceRow}.querySelector('select')`, twinB.id);
    m = ui.mark();
    await ui.click(applyBtn, '«Применить»');
    const applied = await ui.request(m, 'POST', '/apply');
    assert.equal(applied.status, 200);
    // В запросе применения — выбор только по этой строке.
    assert.deepEqual(Object.values(applied.json.choices), [twinB.id]);
    await ui.waitFor(`!${dialog}`, 'окно закрыто');

    const res = await runRecords(regs.res.id);
    const fields = (await ok('GET', `/api/v1/registers/${regs.res.id}`)).fields;
    const F = (k) => fields.find((f) => f.systemKey === k).id;
    const byFio = (fio) => res.find((r) => r.display[F('fullName')] === fio);
    assert.equal(byFio(P.exact).display[F('match')], 'Точно');
    assert.equal(byFio(P.exact).display[F('dept')], 'Отдел тестирования');
    assert.equal(byFio(P.twin).display[F('match')], 'Вручную');
    assert.equal(byFio(P.twin).display[F('dept')], 'Отдел Б');
    assert.equal(byFio(P.fired).display[F('match')], 'Не сопоставлен');
    assert.equal(byFio(P.nobody).display[F('retake')], 'Да');
    // Связь на уволенного — с меткой: ручной выбор уволенного недоступен, поэтому проверяем на однофамильце после увольнения.
    const emp = (await runRecords(regs.emp.id)).find((r) => r.id === twinB.id);
    const empFields = (await ok('GET', `/api/v1/registers/${regs.emp.id}`)).fields;
    const status = empFields.find((f) => f.systemKey === 'status');
    await ok('PATCH', `/api/v1/register-records/${emp.id}`, { version: emp.version, values: { [status.id]: status.options.find((o) => o.label === 'Уволен').id } });
    changedAt = Date.now();
    const twinRes = byFio(P.twin);
    await ui.goto(`/registers?record=${twinRes.id}&run=${++navSeq}#${regs.res.id}/records`);
    await ui.waitFor(`document.querySelector('aside.drawer')?.textContent.includes(${JSON.stringify(`${P.twin} (уволен)`)})`, 'метка «(уволен)» в карточке');
  });

  it('«На пересдачу»: ссылка виджета — список без уволенных, то же число', async () => {
    // Кэш виджетов — минута (так задумано): ждём, пока сервер посчитает виджет после изменений прогона.
    const t0 = Date.now();
    while (Date.parse((await ok('GET', '/api/v1/dashboard/widgets/awareness.retake')).computedAt) < changedAt) {
      assert.ok(Date.now() - t0 < 65_000, 'виджет не пересчитался за 65 с');
      await new Promise((r) => setTimeout(r, 5000));
    }
    await ui.goto(`/dashboard?run=${++navSeq}`);
    const panel = `document.querySelector('[data-widget="awareness.retake"]')`;
    await ui.waitFor(`!!${panel}?.querySelector('.stat-link')`, 'виджет «На пересдачу»');
    const n = Number(await ui.evaluate(`${panel}.querySelector('.big-n').textContent`));
    assert.ok(n >= 1, 'на пересдачу есть');
    await ui.click(`${panel}.querySelector('.stat-link')`, 'число виджета');
    await ui.waitFor(`location.pathname === '/registers' && location.search.includes('lopen=')`, 'список по ссылке');
    await ui.waitFor(`[...document.querySelectorAll('.hint.mono')].some((e) => / из ${n}$/.test(e.textContent))`, `в списке ${n} записей`);
    await ui.type(`document.querySelector('input[aria-label="Поиск по реестру"]')`, TAG.toLowerCase());
    await ui.waitFor(`document.querySelector('table')?.textContent.includes(${JSON.stringify(P.nobody)})`, 'несопоставленный — в списке');
    assert.equal(await ui.evaluate(`document.querySelector('table').textContent.includes(${JSON.stringify(P.fired)})`), true, 'не сопоставленный уволенный — неизвестно, что уволен');
    assert.equal(await ui.evaluate(`document.querySelector('table').textContent.includes(${JSON.stringify(P.twin)})`), false, 'связанный с уволенным — не в списке');
  });

  it('«Обновить по сотрудникам»: снятая строка не меняется', async () => {
    // Отчёт по сотруднику, которого ещё нет; затем сотрудник появляется — запись можно сопоставить.
    const file = await indigoFile([row(P.late, 70)]);
    await openRecords(regs.res.id);
    await ui.waitFor(`!!${$.button('Импорт отчёта INDIGO')}`, 'кнопка импорта INDIGO');
    let m = ui.mark();
    await ui.setFiles('input[aria-label="Файл отчёта INDIGO"]', [file]);
    assert.equal((await ui.request(m, 'POST', '/imports?adapter=indigo')).status, 201);
    await ui.waitFor(`!!${dialog}?.querySelector('.imp-kpis')`, 'предпросмотр');
    m = ui.mark();
    await ui.click(applyBtn, '«Применить»');
    assert.equal((await ui.request(m, 'POST', '/apply')).status, 200);
    await ui.waitFor(`!${dialog}`, 'окно закрыто');
    const empFields = (await ok('GET', `/api/v1/registers/${regs.emp.id}`)).fields;
    const E = (k) => empFields.find((f) => f.systemKey === k).id;
    const working = empFields.find((f) => f.systemKey === 'status').options.find((o) => o.label === 'Работает').id;
    await ok('POST', `/api/v1/registers/${regs.emp.id}/records`, { values: { [E('tabNo')]: `${TAG}-5`, [E('fullName')]: P.late, [E('dept')]: 'Отдел поздних', [E('status')]: working } });
    await ok('POST', `/api/v1/registers/${regs.emp.id}/records`, { values: { [E('tabNo')]: `${TAG}-6`, [E('fullName')]: P.nobody, [E('status')]: working } });

    await openRecords(regs.res.id);
    await ui.click($.button('Обновить по сотрудникам…'), '«Обновить по сотрудникам…»');
    const box = `document.querySelector('[data-testid=awareness-refresh]')`;
    await ui.waitFor(`${box}?.textContent.includes(${JSON.stringify(P.late)})`, 'строки предпросмотра');
    // «Неизвестнов» без отчества в отчёте — автоматически не сопоставляется и тут не предлагается.
    assert.equal(await ui.evaluate(`${box}.textContent.includes(${JSON.stringify(P.nobody)})`), false);
    await ui.waitFor(`${box}.textContent.includes('Отдел поздних')`, 'подразделение «было → станет»');
    // Снять строку позднего сотрудника — применять нечего.
    await ui.click(`${box}.querySelector('input[aria-label=${JSON.stringify(`Обновить ${P.late}`)}]')`, 'снять строку');
    assert.equal(await ui.evaluate(`[...${box}.querySelectorAll('button')].find((b) => b.classList.contains('primary')).disabled`), true);
    await ui.click(`${box}.querySelector('input[aria-label=${JSON.stringify(`Обновить ${P.late}`)}]')`, 'вернуть строку');
    m = ui.mark();
    await ui.click(`[...${box}.querySelectorAll('button')].find((b) => b.textContent.startsWith('Сопоставить'))`, '«Сопоставить»');
    const r = await ui.request(m, 'POST', '/awareness/refresh/apply');
    assert.equal(r.status, 200);
    await ui.waitFor(`!${box}`, 'окно закрыто');
    const fields = (await ok('GET', `/api/v1/registers/${regs.res.id}`)).fields;
    const F = (k) => fields.find((f) => f.systemKey === k).id;
    const late = (await runRecords(regs.res.id)).find((x) => x.display[F('fullName')] === P.late);
    assert.equal(late.display[F('match')], 'Точно');
    assert.equal(late.display[F('dept')], 'Отдел поздних');
  });

  it('без «Записи реестров: правка» — импорта и «Обновить по сотрудникам» нет', async () => {
    viewer.password = await loginAs(viewer.login, viewer.password);
    await openRecords(regs.res.id);
    await ui.waitFor(`!!${$.button('Экспорт в Excel')}`, 'экран записей');
    assert.equal(await ui.evaluate(`!!${$.button('Импорт отчёта INDIGO')}`), false);
    assert.equal(await ui.evaluate(`!!${$.button('Обновить по сотрудникам…')}`), false);
    assert.equal((await api('POST', `/api/v1/registers/${regs.res.id}/awareness/refresh/preview`)).status, 403);
    await loginAs(LOGIN, PASSWORD);
  });
});
