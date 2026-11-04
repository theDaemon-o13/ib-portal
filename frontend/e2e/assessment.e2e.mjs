// Сквозной тест раздела «Самооценка» (этап Д, ADR-0026): Chrome → Vite (прокси /api) → backend → PostgreSQL.
//
//   npm run test:e2e   (логин и пароль администратора — из frontend/.env.e2e или E2E_LOGIN / E2E_PASSWORD)
//
// Пользователь только с ролью «Самооценка» (без ib.work): пункт меню, новая оценка, ответы с итогом «предварительно»,
// «Зафиксировать» недоступно до 24 из 24, фиксация, только просмотр, возврат в черновик, журнал, архив.
// Задача по разрыву из «Плана улучшений» — на общей доске; в карточке у исполнителя нет следа самооценки.
// Импорт эталона Excel через окно (предпросмотр → применить): 34 балла; выгрузка .xlsx.
// Презентация: 6 слайдов, ← → пробел Esc, подпись «Спроектировано» из настроек и «Подготовил» — ФИО вошедшего;
// администратор меняет подпись в «Настройки → Презентация» — владелец видит новый текст (в конце — прежний текст).
// Сотрудник ИБ без роли: пункта нет, прямой адрес уводит из раздела, API — 403.
// Удаления оценок нет: оценки прогона уходят в архив, задача — в архив, тестовые пользователи отключаются.
// Каждый тест создаёт свою оценку и сам убирает за собой (finally): черновик может быть один, и оставленный упавшим
// тестом черновик не должен ронять следующие.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { $, launchBrowser } from './browser.mjs';

const FIXTURE = fileURLToPath(new URL('../../backend/test/fixtures/cyber-checklist-2025.xlsx', import.meta.url));

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const LOGIN = process.env.E2E_LOGIN;
const PASSWORD = process.env.E2E_PASSWORD;
const RUN = `E2E-${Date.now().toString(36)}`;
const TITLE = `${RUN} самооценка`;
const TITLE2 = `${RUN} оценка с задачей`;
const TITLE3 = `${RUN} импорт`;
const TITLE4 = `${RUN} презентация`;

let ui;
let navSeq = 0;
const users = {};

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
  if (!(await ui.evaluate(`location.origin.startsWith('http')`))) await ui.goto(`/login?n=${++navSeq}`);
  await api('POST', '/api/v1/auth/logout');
  await ui.goto(`/login?n=${++navSeq}`);
  await ui.type(`document.querySelector('input[name=username]')`, login);
  await ui.type(`document.querySelector('input[name=password]')`, password);
  await ui.click(`document.querySelector('form button[type=submit]')`);
  await ui.waitFor(`location.pathname !== '/login'`, `вход ${login}`);
  if (await ui.evaluate(`location.pathname === '/change-password'`)) {
    const next = `Оценка-${RUN.slice(4)}-Zq9!`;
    await ui.type(`document.querySelector('input[autocomplete=current-password]')`, password);
    await ui.type(`document.querySelectorAll('input[autocomplete=new-password]')[0]`, next);
    await ui.type(`document.querySelectorAll('input[autocomplete=new-password]')[1]`, next);
    await ui.click($.button('Сменить пароль'));
    await ui.waitFor(`location.pathname !== '/change-password'`, `смена пароля ${login}`);
    return next;
  }
  return password;
}

async function makeUser(key, roleCode, fullName) {
  const roles = (await ok('GET', '/api/v1/roles')).items;
  const role = roles.find((r) => r.code === roleCode);
  assert.ok(role, `роль ${roleCode}`);
  const created = await ok('POST', '/api/v1/users', { login: `${RUN.toLowerCase()}.${key}`, fullName, roleIds: [role.id] });
  users[key] = { id: created.user.id, login: created.user.login, password: created.temporaryPassword };
}

const navTitles = () => ui.evaluate(`[...document.querySelectorAll('nav.nav a')].map((a) => a.textContent.trim())`);
const option = (code, level) => `document.getElementById('sec-${code}')?.querySelectorAll('.sa-opt')[${level - 1}]`;
const status = () => ui.evaluate(`document.querySelector('.sa-bar .chip')?.dataset.status`);
const tab = (title) => `[...document.querySelectorAll('.page-tabs a')].find((a) => a.textContent === ${JSON.stringify(title)})`;
const finalizeBtn = `[...document.querySelectorAll('.sa-bar button')].find((b) => b.textContent === 'Зафиксировать')`;

/** Оценки прогона по названию (держатель права видит все оценки). */
async function mine(title = TITLE) {
  return (await ok('GET', '/api/v1/assessments')).items.find((a) => a.title === title);
}

/** Черновик может быть один: тест начинает, только если черновика нет (чужой тест не трогает). */
async function assertNoDraft() {
  const draft = (await ok('GET', '/api/v1/assessments')).items.find((a) => a.status === 'draft');
  assert.ok(!draft, `в базе уже есть черновик «${draft?.title}»: зафиксируйте или отправьте его в архив перед прогоном`);
}

/** Новая оценка через API (вошедший — владелец). */
const createAssessment = (title) => ok('POST', '/api/v1/assessments', { title, assessedOn: '2026-10-30' });

/**
 * Уборка за тестом. Ошибка уборки не заменяет ошибку самого теста — она пишется в вывод,
 * а оставшийся черновик следующий тест назовёт по имени (assertNoDraft).
 */
async function cleanup(what, fn) {
  try {
    await fn();
  } catch (e) {
    process.stderr.write(`уборка «${what}» не удалась: ${e?.message ?? e}\n`);
  }
}

/** Оценки теста — в архив (удаления нет). Делает владелец: у администратора права на раздел нет. */
async function archiveOwn(...titles) {
  users.owner.password = await loginAs(users.owner.login, users.owner.password);
  for (const title of titles) {
    const a = await mine(title);
    if (a && a.status !== 'archived') await ok('POST', `/api/v1/assessments/${a.id}/archive`, { version: a.version });
  }
}

before(async () => {
  assert.ok(LOGIN && PASSWORD, 'Задайте E2E_LOGIN и E2E_PASSWORD (пользователь с ролью «Супер-администратор»)');
  ui = await launchBrowser({ baseUrl: BASE });
  await loginAs(LOGIN, PASSWORD);
  await makeUser('owner', 'assessment', `Владелец самооценки ${RUN}`);
  await makeUser('staff', 'ib_staff', `Сотрудник без самооценки ${RUN}`);
});

after(async () => {
  if (!ui) return;
  // Оценки, задачу и подпись убирает каждый тест сам; здесь — только общие пользователи прогона.
  await loginAs(LOGIN, PASSWORD).catch(() => undefined);
  for (const u of Object.values(users)) {
    const cur = (await api('GET', `/api/v1/users?q=${encodeURIComponent(u.login)}`)).json?.items.find((x) => x.id === u.id);
    if (cur?.isActive) await api('POST', `/api/v1/users/${u.id}/disable`, { version: cur.version });
  }
  await ui.close();
});

describe('Самооценка', () => {
  it('владелец без ib.work: новая оценка, ответы, «предварительно», фиксация при 24/24, возврат в черновик, журнал, архив', async (t) => {
    users.owner.password = await loginAs(users.owner.login, users.owner.password);
    await assertNoDraft();
    // Уборка — и при падении: оценка теста в архив, иначе её черновик уронит следующие тесты.
    t.after(() => cleanup(TITLE, () => archiveOwn(TITLE)));

    await ui.goto('/documents');
    await ui.waitFor(`document.querySelectorAll('nav.nav a').length > 0`, 'меню');
    assert.deepEqual(await navTitles(), ['Документы', 'Самооценка'], 'меню владельца: «Документы» и «Самооценка»');
    await ui.click(`[...document.querySelectorAll('nav.nav a')].find((a) => a.textContent.trim() === 'Самооценка')`, 'пункт «Самооценка»');
    await ui.waitFor(`location.pathname.startsWith('/assessment')`, 'раздел «Самооценка»');

    // Новая оценка — с пустого чек-листа.
    await ui.click($.button('Новая оценка'), '«Новая оценка»');
    await ui.waitFor(`!!document.querySelector('form.modal')`, 'окно новой оценки');
    await ui.type($.field('Название', `document.querySelector('form.modal')`), TITLE);
    await ui.select($.field('Начать с', `document.querySelector('form.modal')`), '');
    let m = ui.mark();
    await ui.click($.button('Создать', `document.querySelector('form.modal')`));
    const created = await ui.request(m, 'POST', '/api/v1/assessments');
    assert.equal(created.status, 201);
    await ui.waitFor(`!document.querySelector('form.modal') && document.querySelector('[data-testid=sa-total]')?.textContent === '0'`, 'обзор новой оценки');
    assert.equal(await status(), 'draft');
    assert.match(await ui.evaluate(`document.querySelector('.sa-lvl .hint').textContent`), /предварительно/);
    assert.ok(await ui.evaluate(`${finalizeBtn}.disabled`), '«Зафиксировать» недоступно при 0 из 24');

    // Чек-лист: ответ щелчком сохраняется сразу, итог пересчитывает backend.
    await ui.click(tab('Чек-лист'), 'вкладка «Чек-лист»');
    m = ui.mark();
    await ui.click(option('1.1', 3), 'раздел 1.1, уровень 3');
    const put = await ui.request(m, 'PUT', '/answers/1.1');
    assert.equal(put.status, 200);
    assert.deepEqual(put.json.level, 3);
    await ui.waitFor(`${option('1.1', 3)}?.getAttribute('aria-pressed') === 'true'`, 'выбранный вариант 1.1');
    await ui.waitFor(`document.querySelector('.toast.on')?.textContent === 'Сохранено. Итог 3 из 96'`, 'уведомление с итогом');

    // Остальные разделы, кроме 10.1, — через API (уровень 2); последний — снова в интерфейсе.
    const a = (await mine());
    const detail = await ok('GET', `/api/v1/assessments/${a.id}`);
    for (const ans of detail.answers) {
      if (ans.code === '1.1' || ans.code === '10.1') continue;
      await ok('PUT', `/api/v1/assessments/${a.id}/answers/${ans.code}`, { version: ans.version, level: 2 });
    }
    await ui.goto(`/assessment/checklist?id=${a.id}&dom=10`);
    await ui.waitFor(`!!${option('10.1', 1)}`, 'домен 10');
    assert.ok(await ui.evaluate(`${finalizeBtn}.disabled`), '«Зафиксировать» недоступно при 23 из 24');
    await ui.click(option('10.1', 1), 'раздел 10.1, уровень 1');
    // 3 + 22 × 2 + 1 = 48 — «Классическая ИБ».
    await ui.waitFor(`document.querySelector('.toast.on')?.textContent === 'Сохранено. Итог 48 из 96'`, 'итог 48');
    await ui.waitFor(`${finalizeBtn} && !${finalizeBtn}.disabled`, '«Зафиксировать» доступно при 24 из 24');

    // Фиксация: статус, итог заморожен, ответы — только просмотр.
    m = ui.mark();
    await ui.click(finalizeBtn, '«Зафиксировать»');
    assert.equal((await ui.request(m, 'POST', '/finalize')).status, 200);
    await ui.waitFor(`document.querySelector('.sa-bar .chip')?.dataset.status === 'final'`, 'статус «Зафиксирована»');
    await ui.waitFor(`document.querySelector('.toast.on')?.textContent.includes('Оценка зафиксирована: 48 из 96, «Классическая ИБ»')`, 'уведомление о фиксации');
    await ui.waitFor(`document.querySelector('.note.ro')?.textContent.includes('верните её в черновик')`, 'пояснение «только просмотр»');
    assert.ok(await ui.evaluate(`${option('10.1', 2)}.disabled`), 'варианты недоступны');
    await ui.click(tab('Обзор'), 'вкладка «Обзор»');
    await ui.waitFor(`document.querySelector('[data-testid=sa-level]')?.textContent === 'Классическая ИБ'`, 'уровень на обзоре');
    assert.doesNotMatch(await ui.evaluate(`document.querySelector('.sa-lvl .hint').textContent`), /предварительно/);

    // Возврат в черновик с комментарием.
    await ui.click($.button('Вернуть в черновик'), '«Вернуть в черновик»');
    await ui.type(`document.querySelector('form.modal textarea')`, 'Уточнить 10.1');
    m = ui.mark();
    await ui.click($.button('Вернуть в черновик', `document.querySelector('form.modal')`));
    assert.equal((await ui.request(m, 'POST', '/reopen')).status, 200);
    // Окно закрыто и статус сменился — только тогда страница принимает щелчки.
    await ui.waitFor(`!document.querySelector('form.modal') && document.querySelector('.sa-bar .chip')?.dataset.status === 'draft'`, 'снова черновик, окно закрыто');

    // История: журнал оценки без текста комментария к ответу; архив. Ждём строки на странице, а не сетевой запрос:
    // журнал может прийти из кэша без нового запроса (так тест падал в 1.7.0). Журнал пишется в той же транзакции,
    // что и действие, поэтому строка о возврате появляется после обновления данных.
    await ui.click(tab('История'), 'вкладка «История»');
    await ui.waitFor(`document.querySelector('[data-testid=sa-journal]')?.textContent.includes('Возвращена в черновик с комментарием')`, 'журнал оценки');
    const journal = await ui.evaluate(`document.querySelector('[data-testid=sa-journal]').textContent`);
    assert.match(journal, /Зафиксирована: 48 из 96/);
    assert.match(journal, /1\.1 .*балл — → 3/);
    assert.doesNotMatch(journal, new RegExp(`Самооценка «${TITLE}»`), 'название оценки в её журнале не повторяется');
    await ui.click(`[...document.querySelectorAll('.sa-list tr')].find((tr) => tr.textContent.includes(${JSON.stringify(TITLE)}))?.querySelector('button.ghost')`, '«В архив»');
    m = ui.mark();
    await ui.click($.button('В архив', `document.querySelector('form.modal')`));
    assert.equal((await ui.request(m, 'POST', '/archive')).status, 200);
    await ui.waitFor(`!document.querySelector('form.modal') && document.querySelector('.sa-bar .chip')?.dataset.status === 'archived'`, 'оценка в архиве, окно закрыто');
    assert.ok(!(await ui.evaluate(`!!${finalizeBtn}`)), 'у архивной оценки нет «Зафиксировать»');

    // Ссылка из раздела «Активы» без id оценки: нужный домен и раздел в оценке по умолчанию.
    await ui.goto('/assessment/checklist?dom=2&sec=2.2');
    await ui.waitFor(`document.getElementById('sec-2.2')?.classList.contains('flash')`, 'раздел 2.2 в чек-листе');
  });

  it('задача по разрыву из «Плана»: на доске у исполнителя, без следа самооценки в карточке', async (t) => {
    let gapTask;
    // Уборка: задача — в архив (администратор), оценка — в архив (владелец).
    t.after(() => cleanup(TITLE2, async () => {
      if (gapTask) {
        await loginAs(LOGIN, PASSWORD);
        const cur = await ok('GET', `/api/v1/tasks/${gapTask.id}`);
        if (!cur.archived) await ok('POST', `/api/v1/tasks/${gapTask.id}/archive`, { version: cur.version });
      }
      await archiveOwn(TITLE2);
    }));
    users.owner.password = await loginAs(users.owner.login, users.owner.password);
    await assertNoDraft();
    const created = await createAssessment(TITLE2);
    const ans = created.answers.find((x) => x.code === '5.3');
    await ok('PUT', `/api/v1/assessments/${created.id}/answers/5.3`, { version: ans.version, level: 1, targetLevel: 3, comment: `${RUN} подробность` });

    await ui.goto(`/assessment/plan?id=${created.id}`);
    const row = `document.querySelector('.sa-plan tr[data-code="5.3"]')`;
    await ui.waitFor(`!!${row}`, 'разрыв 5.3 в плане');
    assert.equal(await ui.evaluate(`document.querySelector('.kpis .kpi .v').textContent`), '1', 'один раздел с разрывом');
    await ui.click($.button('Создать задачу', row), '«Создать задачу»');
    const form = `document.querySelector('form.modal')`;
    await ui.waitFor(`!!${form}`, 'окно задачи');
    assert.match(await ui.evaluate(`${form}.textContent`), /Задача будет видна всем на доске «Задачи»/);
    assert.equal(await ui.evaluate(`${$.field('Название', form)}.value`), 'Контроль устранения уязвимостей: усилить');
    await ui.waitFor(`${$.field('Категория', form)}.options.length > 1 && ${$.field('Исполнитель', form)}.options.length > 1`, 'списки формы');
    await ui.select($.field('Категория', form), await ui.evaluate(`${$.field('Категория', form)}.options[1].value`));
    await ui.select($.field('Исполнитель', form), users.staff.id);
    const m = ui.mark();
    await ui.click($.button('Поставить задачу', form));
    const req = await ui.request(m, 'POST', '/answers/5.3/tasks');
    assert.equal(req.status, 201);
    const task = await ui.response(req);
    gapTask = task;
    await ui.waitFor(`${row}?.textContent.includes('#${task.number}') && !document.querySelector('form.modal')`, 'задача в плане');
    await ui.waitFor(`document.querySelector('.toast.on')?.textContent.includes('Задача #${task.number} поставлена на доску')`, 'уведомление о задаче');

    // Исполнитель видит обычную ручную задачу: ни раздела, ни баллов, ни названия оценки.
    users.staff.password = await loginAs(users.staff.login, users.staff.password);
    await ui.goto(`/tasks?task=${task.id}`);
    await ui.waitFor(`document.querySelector('aside.drawer .dr-title')?.textContent === 'Контроль устранения уязвимостей: усилить'`, 'карточка задачи');
    await ui.waitFor(`[...document.querySelectorAll('aside.drawer .eyebrow')].some((e) => e.textContent.startsWith('Комментарии'))`, 'карточка загружена');
    const card = await ui.evaluate(`document.querySelector('aside.drawer').textContent`);
    for (const trace of ['5.3', 'Самооценк', TITLE2, 'подробность']) assert.ok(!card.includes(trace), `в карточке нет «${trace}»`);
    const dto = JSON.stringify(await ok('GET', `/api/v1/tasks/${task.id}`));
    assert.ok(!dto.includes('assessment') && !dto.includes(created.id), 'в API задачи нет ссылки на самооценку');
    assert.match(dto, /"source":"manual"/);
  });

  it('импорт эталона Excel: предпросмотр, применение, итог 34 из 96; выгрузка .xlsx', async (t) => {
    t.after(() => cleanup(TITLE3, () => archiveOwn(TITLE3)));
    users.owner.password = await loginAs(users.owner.login, users.owner.password);
    await assertNoDraft();
    // Своя пустая оценка: тест не зависит от данных предыдущего.
    const a = await createAssessment(TITLE3);
    await ui.goto(`/assessment/overview?id=${a.id}`);
    await ui.click($.button('Импорт Excel'), '«Импорт Excel»');
    let m = ui.mark();
    await ui.setFiles('[role=dialog] input[type=file]', [FIXTURE]);
    const dry = await ui.request(m, 'POST', `/assessments/${a.id}/import?dryRun=true`);
    assert.equal(dry.status, 200);
    await ui.waitFor(`document.querySelector('[data-testid=sa-import-preview]')?.textContent.includes('Найдено разделов: 24 из 24')`, 'предпросмотр импорта');
    const text = await ui.evaluate(`document.querySelector('[data-testid=sa-import-preview]').textContent`);
    assert.match(text, /итог — 34 из 96, «Цифровая гигиена»/);
    assert.match(text, /Скрытые строки пропущены/);
    assert.equal((await mine(TITLE3)).total, 0, 'предпросмотр ничего не записал');
    m = ui.mark();
    await ui.click($.button('Применить', `document.querySelector('[role=dialog]')`));
    const applied = await ui.request(m, 'POST', `/assessments/${a.id}/import?version=`);
    assert.equal(applied.status, 200);
    await ui.waitFor(`!document.querySelector('[role=dialog]') && document.querySelector('[data-testid=sa-total]')?.textContent === '34'`, 'итог 34 после импорта');
    await ui.waitFor(`/Импорт применён: разделов изменено \\d+\\. Итог 34 из 96/.test(document.querySelector('.toast.on')?.textContent ?? '')`, 'уведомление об импорте');
    assert.equal((await ok('GET', `/api/v1/assessments/${a.id}`)).profile.organization, 'ЗАО МДО "Хумо"');

    m = ui.mark();
    await ui.click($.button('Выгрузить .xlsx'), '«Выгрузить .xlsx»');
    const exp = await ui.request(m, 'GET', '/api/v1/assessments/export.xlsx');
    assert.equal(exp.status, 200);
    await ui.waitFor(`document.querySelector('.toast.on')?.textContent.startsWith('Выгружено: Самооценка_КБ_')`, 'уведомление о выгрузке');
  });

  it('презентация: 6 слайдов, клавиши, подпись с ФИО вошедшего; новый текст подписи из настроек', async (t) => {
    // Номер слайда меняется после перерисовки — ждём его, а не читаем сразу после клавиши.
    const slideIs = (n, what = `слайд ${n + 1}`) => ui.waitFor(`Number(document.querySelector('.sa-pres')?.dataset.slide ?? -1) === ${n}`, what);
    const sign = () => ui.evaluate(`document.querySelector('[data-testid=sa-signature]')?.innerText ?? ''`);
    let signature;
    // Уборка: оценка — в архив (владелец), подпись — прежний текст (администратор).
    t.after(() => cleanup(TITLE4, async () => {
      await archiveOwn(TITLE4);
      if (signature === undefined) return;
      await loginAs(LOGIN, PASSWORD);
      const cur = await ok('GET', '/api/v1/settings/presentation');
      if (cur.signature !== signature) await ok('PUT', '/api/v1/settings/presentation', { signature, version: cur.version });
    }));
    const openPresentation = async () => {
      const a = await mine(TITLE4);
      await ui.goto(`/assessment/overview?id=${a.id}`);
      await ui.click($.button('Презентация'), '«Презентация»');
      await ui.waitFor(`!!document.querySelector('.sa-pres') && document.querySelector('[data-testid=sa-signature]')?.innerText.includes('Спроектировано: ') && document.querySelector('[data-testid=sa-signature]').innerText.split('\\n')[0].length > 'Спроектировано: '.length`, 'презентация с подписью');
    };

    await loginAs(LOGIN, PASSWORD);
    signature = (await ok('GET', '/api/v1/settings/presentation')).signature;
    users.owner.password = await loginAs(users.owner.login, users.owner.password);
    await assertNoDraft();
    await createAssessment(TITLE4);
    await openPresentation();
    await slideIs(0);
    assert.match(await ui.evaluate(`document.querySelector('.sa-pres').textContent`), /предварительно/, 'черновик — «предварительно» на первом слайде');
    assert.equal(await sign(), `Спроектировано: ${signature}\nПодготовил: Владелец самооценки ${RUN}`);
    // Клавиша за клавишей: каждое нажатие — следующий слайд, иначе быстрые нажатия могли бы слиться.
    let n = 0;
    for (const key of ['ArrowRight', 'Space', 'ArrowRight', 'ArrowRight', 'ArrowRight']) {
      await ui.press(key);
      await slideIs(++n, `слайд ${n + 1} после ${key}`);
    }
    await ui.waitFor(`/План улучшений/.test(document.querySelector('.sa-ps-slide h2')?.textContent ?? '')`, 'шестой слайд — «План улучшений»');
    assert.match(await ui.evaluate(`document.querySelector('.sa-ps-pg').textContent`), /^6 \/ 6/);
    await ui.press('ArrowRight');
    // «Дальше последнего не листается»: отсутствие перехода ждать нечем — проверяем после паузы перерисовки.
    await new Promise((r) => setTimeout(r, 300));
    await slideIs(5, 'дальше последнего не листается');
    await ui.press('ArrowLeft');
    await slideIs(4, 'назад — пятый слайд');
    assert.ok(await ui.evaluate(`document.querySelector('[data-testid=sa-signature]').querySelectorAll('button').length === 0`), 'у подписи нет кнопок');
    await ui.press('Escape');
    await ui.waitFor(`!document.querySelector('.sa-pres')`, 'Esc закрывает презентацию');
    assert.equal((await api('PUT', '/api/v1/settings/presentation', { signature: 'Чужая подпись', version: 1 })).status, 403, 'владелец подпись не меняет');

    // Администратор меняет подпись в «Настройки → Презентация».
    const next = `Отдел ИБ ${RUN}`;
    await loginAs(LOGIN, PASSWORD);
    await ui.goto('/settings/presentation');
    await ui.type($.field('Спроектировано'), next);
    const m = ui.mark();
    await ui.click($.button('Сохранить'));
    assert.equal((await ui.request(m, 'PUT', '/api/v1/settings/presentation')).status, 200);
    await ui.waitFor(`document.querySelector('.toast.on')?.textContent === 'Подпись сохранена'`, 'подпись сохранена');

    users.owner.password = await loginAs(users.owner.login, users.owner.password);
    await openPresentation();
    assert.equal(await sign(), `Спроектировано: ${next}\nПодготовил: Владелец самооценки ${RUN}`);
    await ui.click(`document.querySelector('.sa-ps-ctl button.x')`, 'кнопка «Закрыть»');
    await ui.waitFor(`!document.querySelector('.sa-pres')`, 'презентация закрыта');
  });

  it('без роли «Самооценка»: пункта нет, прямой адрес уводит из раздела, API — 403', async () => {
    users.staff.password = await loginAs(users.staff.login, users.staff.password);
    await ui.goto('/dashboard');
    await ui.waitFor(`document.querySelectorAll('nav.nav a').length > 0`, 'меню');
    assert.ok(!(await navTitles()).includes('Самооценка'), 'пункта «Самооценка» нет');
    await ui.goto('/assessment/overview');
    await ui.waitFor(`!location.pathname.startsWith('/assessment')`, 'прямой адрес уводит из раздела');
    assert.equal((await api('GET', '/api/v1/assessments')).status, 403);
    // Администратор тоже не видит раздела: право не входит в «Супер-администратора».
    await loginAs(LOGIN, PASSWORD);
    await ui.goto('/dashboard');
    await ui.waitFor(`document.querySelectorAll('nav.nav a').length > 0`, 'меню администратора');
    assert.ok(!(await navTitles()).includes('Самооценка'), 'у администратора пункта нет');
    assert.equal((await api('GET', '/api/v1/assessments')).status, 403);
  });
});
