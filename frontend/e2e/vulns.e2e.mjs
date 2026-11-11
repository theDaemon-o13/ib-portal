// Сквозной тест раздела «Уязвимости» (релиз 1.5.0) тем же путём, что и браузер пользователя: Chrome → Vite (прокси /api) →
// backend → PostgreSQL, настоящие щелчки мыши и ввод с клавиатуры. Создать группу с типом → импорт образца → предпросмотр →
// загрузить → передать ИКТ → «Обновить сроки» (было → станет) → отмена → карточка записи → перенос из «Без группы» →
// удаление группы (отказ при открытых записях, удаление пустой) и восстановление из корзины (1.6.1).
//
//   npm run test:e2e   (логин и пароль — из frontend/.env.e2e или E2E_LOGIN / E2E_PASSWORD)
//
// Группы «E2E-…» и их данные после прогона удаляет код тестов прямо в dev-базе (vulns-cleanup.mjs): в продукте удаления
// групп нет (ADR-0029). Права vulns.deadlines и data.delete на время прогона выдаются своей ролью, после прогона роль снимается
// и удаляется.
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { launchBrowser, portalToday, sleep } from './browser.mjs';
import { breakScanImport, cleanE2eGroups } from './vulns-cleanup.mjs';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const LOGIN = process.env.E2E_LOGIN;
const PASSWORD = process.env.E2E_PASSWORD;
const SAMPLE = fileURLToPath(new URL('../../backend/test/fixtures/vuln-windows-2026-10-15.xlsx', import.meta.url));
const GROUP = `E2E-${Date.now().toString(36)}`;
const CVE = 'CVE-2024-21413';

let ui;
let tmp;
let basisFile;
let roleId;
let meId;
let nodeId;
let scanId;
let priorRoleIds = [];

const api = (path, init) => ui.evaluate(`fetch(${JSON.stringify(path)}, ${JSON.stringify(init ?? {})}).then((r) => r.status === 204 ? null : r.json())`);
const send = (method, path, body) => api(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const q = (s) => `document.querySelector(${JSON.stringify(s)})`;
const button = (text, within = 'document') => `[...(${within}).querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)})`;
const startsWith = (text, within = 'document') => `[...(${within}).querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(text)}))`;
const dialog = (title) => q(`[role=dialog][aria-label="${title}"]`);
const treeBtn = (text) => `[...document.querySelectorAll('.v-tree button')].find((b) => b.textContent.includes(${JSON.stringify(text)}))`;

async function open(path, ready, what) {
  await ui.goto(`${path}${path.includes('?') ? '&' : '?'}run=${Date.now()}`);
  await ui.waitFor(ready, what);
}

/** Свои роли прогона — и оставшиеся от оборвавшихся прогонов. */
async function dropRoles() {
  const roles = await api('/api/v1/roles');
  for (const r of (roles.items ?? roles).filter((x) => x.name.startsWith('E2E-сроки-'))) await send('POST', `/api/v1/roles/${r.id}/delete`, { version: r.version });
}

/** Выйти и войти через форму; при первом входе — смена временного пароля. */
async function relogin(login, password) {
  await send('POST', '/api/v1/auth/logout');
  await ui.goto(`/login?run=${Date.now()}`);
  await ui.type(q('input[name=username]'), login);
  await ui.type(q('input[name=password]'), password);
  await ui.click(q('form button[type=submit]'));
  await ui.waitFor(`location.pathname !== '/login'`, `вход ${login}`);
  if (await ui.evaluate(`location.pathname === '/change-password'`)) {
    const next = `Скан-${GROUP.slice(4)}-Zq9!`;
    await ui.type(q('input[autocomplete=current-password]'), password);
    await ui.type(`document.querySelectorAll('input[autocomplete=new-password]')[0]`, next);
    await ui.type(`document.querySelectorAll('input[autocomplete=new-password]')[1]`, next);
    await ui.click(button('Сменить пароль'));
    await ui.waitFor(`location.pathname !== '/change-password'`, `смена пароля ${login}`);
  }
}

async function findMe() {
  const users = await api(`/api/v1/users?q=${encodeURIComponent(LOGIN)}&limit=50`);
  return users.items.find((u) => u.id === meId);
}

before(async () => {
  assert.ok(LOGIN && PASSWORD, 'Задайте E2E_LOGIN и E2E_PASSWORD (пользователь с ролью «Супер-администратор»)');
  tmp = mkdtempSync(join(tmpdir(), 'ibportal-e2e-vulns-'));
  basisFile = join(tmp, 'обращение-ОИКТ.txt');
  writeFileSync(basisFile, 'Обоснование ОИКТ для сквозного теста');
  ui = await launchBrowser({ baseUrl: BASE });
  await ui.goto('/login');
  await ui.type(q('input[name=username]'), LOGIN);
  await ui.type(q('input[name=password]'), PASSWORD);
  await ui.click(q('form button[type=submit]'));
  await ui.waitFor(`location.pathname !== '/login'`, 'вход');
  meId = (await api('/api/v1/auth/me')).user.id;
  await dropRoles();
  // Право «Уязвимости: изменение сроков» не входит ни в одну системную роль: выдаём на время прогона.
  const role = await send('POST', '/api/v1/roles', { name: `E2E-сроки-${GROUP}`, description: 'Сквозной тест' });
  roleId = role.id;
  await send('PUT', `/api/v1/roles/${roleId}/permissions/vulns.deadlines`, { granted: true });
  // «Удаление данных» (1.6.1) тоже никому не выдаётся автоматически.
  await send('PUT', `/api/v1/roles/${roleId}/permissions/data.delete`, { granted: true });
  const me = await findMe();
  priorRoleIds = me.roles.map((r) => r.id);
  const patched = await send('PATCH', `/api/v1/users/${meId}`, { version: me.version, roleIds: [...priorRoleIds, roleId] });
  assert.ok(patched.id, `роль не назначилась: ${JSON.stringify(patched)}`);
});

after(async () => {
  if (ui) {
    try {
      if (roleId && priorRoleIds.length) {
        const me = await findMe();
        await send('PATCH', `/api/v1/users/${meId}`, { version: me.version, roleIds: priorRoleIds });
        await dropRoles();
      }
    } finally {
      assert.deepEqual(ui.consoleErrors, [], 'ошибки JavaScript в странице');
      ui.close();
    }
  }
  await cleanE2eGroups();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('Раздел «Уязвимости»', () => {
  it('создать группу с типом: появляется в дереве, карточка узла открывается', async () => {
    await open('/vulns', `!!${q('.v-tree')}`, 'дерево групп');
    await ui.click(startsWith('+ Группа'));
    await ui.waitFor(`!!${dialog('Создать группу')}`, 'окно группы');
    await ui.type(q('input[aria-label="Название группы"]'), GROUP);
    await ui.waitFor(`[...document.querySelectorAll('[role=dialog] label.check')].some((l) => l.textContent.includes('Windows'))`, 'типы систем');
    await ui.click(`[...document.querySelectorAll('[role=dialog] label.check')].find((l) => l.textContent.includes('Windows')).querySelector('input')`);
    await ui.click(button('Создать', dialog('Создать группу')));
    await ui.waitFor(`location.pathname.startsWith('/vulns/group/') && !!${treeBtn(GROUP)}`, 'группа в дереве');
    await ui.click(`[...document.querySelectorAll('.v-tcard')].find((c) => c.textContent.includes('Windows'))`);
    await ui.waitFor(`location.pathname.startsWith('/vulns/node/')`, 'экран узла');
    nodeId = await ui.evaluate(`location.pathname.split('/').pop()`);
    await ui.waitFor(`!!${button('Импорт скана')}`, 'кнопка импорта');
  });

  it('импорт скана: предпросмотр — 90 новых, охват 12 хостов; ничего не меняет; загрузка ведёт на экран скана, срока нет', async () => {
    await open(`/vulns/node/${nodeId}`, `!!${button('Импорт скана')}`, 'экран узла');
    await ui.click(button('Импорт скана'));
    await ui.waitFor(`!!${dialog('Импорт скана')}`, 'окно импорта');
    await ui.setFiles('[role=dialog] input[type=file]', [SAMPLE]);
    await ui.waitFor(`!!document.querySelector('[role=dialog] .v-dcards')`, 'предпросмотр', 20_000);
    const text = await ui.evaluate(`document.querySelector('[role=dialog]').textContent`);
    assert.match(text, /Отдел платёжных карт/);
    assert.equal(await ui.evaluate(`document.querySelector('[role=dialog] input[aria-label="Дата скана"]').value`), '2026-10-15');
    assert.equal(await ui.evaluate(`document.querySelector('[role=dialog] .v-dcard.k-new b').textContent`), '90 / 90');
    assert.equal(await ui.evaluate(`document.querySelector('[role=dialog] .v-dcard.k-gone b').textContent`), '0 / 0');
    assert.equal((await api(`/api/v1/vulns/nodes/${nodeId}/records?state=all`)).total, 0, 'предпросмотр ничего не записал');
    // Снять одну строку — кнопка считает выбранное.
    await ui.click(`[...document.querySelectorAll('[role=dialog] .v-list tbody tr')].find((tr) => tr.textContent.includes('BDU:2025-01793')).querySelector('input')`);
    await ui.waitFor(`!!${startsWith('Загрузить: новых 89', "document.querySelector('[role=dialog]')")}`, 'счётчик выбранного');
    await ui.click(startsWith('Загрузить: новых 89', "document.querySelector('[role=dialog]')"));
    await ui.waitFor(`location.pathname.startsWith('/vulns/scan/')`, 'экран скана', 30_000);
    scanId = await ui.evaluate(`location.pathname.split('/').pop()`);
    await ui.waitFor(`!!${button('Передать ИКТ')}`, 'блок передачи ИКТ');
    const page = await api(`/api/v1/vulns/nodes/${nodeId}/records?state=all`);
    assert.equal(page.total, 89);
    assert.equal(page.stateCounts.not_handed, 89, 'срока нет до передачи');
    await ui.waitFor(`!!${treeBtn('Скан 15.10.2026')}`, 'скан в дереве');
    // Вкладки скана: находки — снимок файла с Оценкой портала, охват — 12 хостов.
    await ui.click(startsWith('Находки'));
    await ui.waitFor(`document.querySelectorAll('.v-recs tbody tr').length === 90`, 'снимок находок');
    await ui.click(startsWith('Охват'));
    await ui.waitFor(`document.querySelectorAll('.v-main table tbody tr').length === 12`, 'хосты скана');
  });

  it('передать ИКТ: срок начинается, строка в таблице узла со сроком, просроченные — сверху', async () => {
    await open(`/vulns/scan/${scanId}`, `!!${button('Передать ИКТ')}`, 'экран скана');
    await ui.click(button('Передать ИКТ'));
    await ui.waitFor(`!!${dialog('Передать ИКТ')}`, 'окно передачи');
    const date = q('[role=dialog] input[aria-label="Дата передачи"]');
    await ui.evaluate(`(() => { const i = ${date}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '2026-10-15'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await ui.click(button('Передать ИКТ', dialog('Передать ИКТ')));
    await ui.waitFor(`!${q('[role=dialog]')} && document.querySelector('.note.v-ok')?.textContent.includes('15.10.2026')`, 'передано');
    assert.ok(!(await ui.evaluate(`!!${button('Передать ИКТ')}`)), 'второй передачи нет');
    await open(`/vulns/node/${nodeId}`, `document.querySelectorAll('.v-recs tbody tr').length > 0`, 'реестр узла');
    assert.match(await ui.evaluate(`document.querySelector('.v-recs tbody tr').textContent`), /Просрочена/);
    const row = `[...document.querySelectorAll('.v-recs tbody tr')].find((tr) => tr.textContent.includes(${JSON.stringify(CVE)}))`;
    await ui.waitFor(`!!${row}`, 'запись в таблице');
    assert.match(await ui.evaluate(`${row}.textContent`), /29\.10\.2026/);
  });

  it('обновить сроки: Важная +30, обоснование с файлом, было → станет; отмена возвращает; карточка показывает всё', async () => {
    await open(`/vulns/node/${nodeId}`, `!!${button('Обновить сроки')}`, 'экран узла');
    await ui.click(button('Обновить сроки'));
    await ui.waitFor(`!!${dialog('Обновить сроки')}`, 'окно продления');
    await ui.waitFor(`!!${q('input[aria-label="Дни: Важная"]')}`, 'уровень «Важная»');
    await ui.type(q('input[aria-label="Дни: Важная"]'), '30');
    await ui.waitFor(`/Продлится: [1-9]/.test(${q('[data-testid=extension-summary]')}?.textContent ?? '')`, 'кандидаты');
    assert.ok(await ui.evaluate(`${button('Предпросмотр')}.disabled`), 'без обоснования нельзя');
    await ui.type(q('input[aria-label="Номер обращения"]'), '42/ОИКТ');
    await ui.evaluate(`(() => { const i = ${q('input[aria-label="Дата обращения"]')}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(portalToday())}); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await ui.setFiles('[role=dialog] input[type=file]', [basisFile]);
    await ui.waitFor(`!${button('Предпросмотр')}.disabled`, 'обоснование заполнено');
    await ui.click(button('Предпросмотр'));
    await ui.waitFor(`!!${dialog('Подтвердите продление')}`, 'было → станет');
    assert.match(await ui.evaluate(`[...document.querySelectorAll('[role=dialog] tbody tr')].find((tr) => tr.textContent.includes(${JSON.stringify(CVE)})).textContent`), /29\.10\.2026.*30\.11\.2026/);
    await ui.click(startsWith('Продлить: записей'));
    await ui.waitFor(`!${q('[role=dialog]')}`, 'окно закрылось', 20_000);

    const row = `[...document.querySelectorAll('.v-recs tbody tr')].find((tr) => tr.textContent.includes(${JSON.stringify(CVE)}))`;
    await ui.waitFor(`${row}?.textContent.includes('30.11.2026')`, 'новый срок в таблице');
    await ui.click(row);
    await ui.waitFor(`!!${q('[data-testid=vuln-block]')}?.textContent.includes('42/ОИКТ')`, 'блок срока в карточке');
    const block = await ui.evaluate(`${q('[data-testid=vuln-block]')}.textContent`);
    assert.match(block, /29\.10\.2026/);
    assert.match(block, /30\.11\.2026/);
    assert.match(block, /Скан 15\.10\.2026/);
    await ui.click(button('Закрыть', `document.querySelector('aside.drawer[aria-label="Запись реестра"]')`));

    await ui.click(startsWith('Продления сроков'));
    await ui.waitFor(`!!${button('Отменить', "document.querySelector('.v-shift')")}`, 'продление в списке');
    await ui.click(button('Отменить', "document.querySelector('.v-shift')"));
    await ui.click(button('Отменить продление'));
    await ui.waitFor(`document.querySelector('.v-shift.cancel')?.textContent.includes('Отменено')`, 'отметка «Отменено»', 20_000);
    await ui.click(startsWith('Реестр'));
    await ui.waitFor(`${row}?.textContent.includes('29.10.2026')`, 'срок вернулся');
  });

  it('перенос из «Без группы» — если в dev-базе есть такие записи: запись уходит в узел', async () => {
    const groups = await api('/api/v1/vulns/groups');
    const legacy = groups.items.find((g) => g.system)?.nodes[0];
    assert.ok(legacy, 'нет узла «Из прежнего реестра»');
    const page = await api(`/api/v1/vulns/nodes/${legacy.id}/records?state=all&limit=200`);
    // Ключ должен быть цел: без пакета или с ключом, который в узле уже есть, перенос справедливо отказывает.
    const { fields } = await api(`/api/v1/registers/${(await api('/api/v1/vulns/overview')).registerId}`);
    const pkgField = fields.find((f) => f.systemKey === 'pkg');
    const cveField = fields.find((f) => f.systemKey === 'cve');
    const inNode = await api(`/api/v1/vulns/nodes/${nodeId}/records?state=all&limit=200`);
    const keyOf = (r) => `${r.display[pkgField.id]}|${r.display[cveField.id]}`.toLowerCase();
    const taken = new Set(inNode.items.map(keyOf));
    const withKey = page.items.filter((r) => r.values[pkgField.id] && r.values[cveField.id]);
    const candidate = withKey.find((r) => !taken.has(keyOf(r))) ?? withKey[0];
    if (!candidate) return; // пустая dev-база: сценарий покрыт тестами backend (legacy.db.test.ts)
    const refused = taken.has(keyOf(candidate)); // такой ключ в узле уже есть — проверяем отказ по строке
    await open(`/vulns/node/${legacy.id}?state=all`, `document.querySelectorAll('.v-recs tbody tr').length > 0`, 'узел «Из прежнего реестра»');
    assert.ok(!(await ui.evaluate(`!!${button('Импорт скана')}`)), 'в «Без группы» импорта нет');
    await ui.select(q('select[aria-label="Статус"]'), 'all', 'фильтр «Статус»');
    const row = `[...document.querySelectorAll('.v-recs tbody tr')].find((tr) => tr.textContent.includes(${JSON.stringify(`#${candidate.number}`)}))`;
    await ui.waitFor(`!!${row}`, 'запись в таблице', 15_000);
    await ui.click(button('Перенести', row));
    await ui.waitFor(`!!${dialog('Перенести запись')}`, 'окно переноса');
    await ui.select(q('[role=dialog] select[aria-label="Узел"]'), nodeId, 'узел');
    await ui.click(button('Перенести', dialog('Перенести запись')));
    if (refused) {
      await ui.waitFor(`document.querySelector('[role=dialog]')?.textContent.includes('В узле уже есть')`, 'отказ по ключу', 15_000);
      await ui.click(button('Закрыть', dialog('Перенести запись')));
      return;
    }
    await ui.waitFor(`!${row}`, 'запись ушла из «Без группы»', 15_000);
    const moved = await api(`/api/v1/vulns/records/${candidate.id}`);
    assert.equal(moved.node.id, nodeId);
  });

  it('импорт с группы: типа нет — «Добавить тип и импортировать», общий предпросмотр; несовпадение профиля — только с галочкой', async () => {
    const linuxFile = join(tmp, 'Scan_Linux_2026-10-20.xlsx');
    copyFileSync(SAMPLE, linuxFile);
    const types = (await api('/api/v1/catalogs/system_types/items')).items;
    const windows = types.find((t) => t.value === 'Windows');
    assert.ok(windows && types.some((t) => t.value === 'Linux'), 'профили в справочнике');
    const group = await send('POST', '/api/v1/vulns/groups', { name: `${GROUP}-профили`, kind: 'service', systemTypeIds: [windows.id] });
    assert.ok(group.id, JSON.stringify(group));

    await open(`/vulns/group/${group.id}`, `!!${button('Импорт скана')}`, 'страница группы');
    await ui.waitFor(`[...document.querySelectorAll('.v-tcard')].some((c) => c.textContent.includes('Сканов нет'))`, 'возраст скана на карточке');
    await ui.click(button('Импорт скана'));
    await ui.waitFor(`!!${dialog('Импорт скана')}`, 'окно импорта');
    await ui.setFiles('[role=dialog] input[type=file]', [linuxFile]);
    await ui.waitFor(`!!${button('Добавить тип Linux в группу и импортировать')}`, 'предложение добавить тип');
    assert.equal(await ui.evaluate(`document.querySelector('[role=dialog] select[aria-label="Узел"]').value`), '', 'узел не угадывается');
    await ui.click(button('Добавить тип Linux в группу и импортировать'));
    await ui.waitFor(`!!document.querySelector('[role=dialog] .v-dcards')`, 'предпросмотр нового узла', 20_000);
    assert.equal(await ui.evaluate(`document.querySelector('[role=dialog] .v-dcard.k-new b').textContent`), '90 / 90', 'сравнение с пустым реестром');
    assert.equal(await ui.evaluate(`document.querySelector('[role=dialog] .v-dcard.k-gone b').textContent`), '0 / 0');
    const nodesNow = async () => (await api('/api/v1/vulns/groups')).items.find((g) => g.id === group.id).nodes.length;
    assert.equal(await nodesNow(), 1, 'до подтверждения узла нет');
    // Отмена ничего не оставляет; второй заход — до конца.
    await ui.click(button('Отмена', "document.querySelector('[role=dialog]')"));
    await ui.waitFor(`!document.querySelector('[role=dialog]')`, 'окно закрыто');
    assert.equal(await nodesNow(), 1, 'после отмены узла нет');
    await ui.click(button('Импорт скана'));
    await ui.waitFor(`!!${dialog('Импорт скана')}`, 'окно импорта');
    await ui.setFiles('[role=dialog] input[type=file]', [linuxFile]);
    await ui.waitFor(`!!${button('Добавить тип Linux в группу и импортировать')}`, 'предложение добавить тип');
    await ui.click(button('Добавить тип Linux в группу и импортировать'));
    await ui.waitFor(`!!document.querySelector('[role=dialog] .v-dcards')`, 'предпросмотр нового узла', 20_000);
    assert.ok(!(await ui.evaluate(`!!document.querySelector('[data-testid=profile-mismatch]')`)), 'профиль совпал: предупреждения нет');
    await ui.click(startsWith('Загрузить: новых 90', "document.querySelector('[role=dialog]')"));
    await ui.waitFor(`location.pathname.startsWith('/vulns/scan/')`, 'экран скана', 30_000);
    const after = (await api('/api/v1/vulns/groups')).items.find((g) => g.id === group.id);
    assert.deepEqual(after.nodes.map((n) => n.label).sort(), ['Linux', 'Windows']);

    // Файл Linux в узел Windows: предупреждение, кнопка закрыта до галочки, факт виден в скане.
    const win = after.nodes.find((n) => n.label === 'Windows');
    await open(`/vulns/node/${win.id}`, `!!${button('Импорт скана')}`, 'экран узла Windows');
    await ui.click(button('Импорт скана'));
    await ui.waitFor(`!!${dialog('Импорт скана')}`, 'окно импорта');
    await ui.setFiles('[role=dialog] input[type=file]', [linuxFile]);
    await ui.waitFor(`document.querySelector('[data-testid=profile-mismatch]')?.textContent.includes('Файл похож на скан профиля Linux, а узел — Windows')`, 'предупреждение', 20_000);
    const load = startsWith('Загрузить', "document.querySelector('[role=dialog]')");
    assert.equal(await ui.evaluate(`${load}.disabled`), true, 'без галочки загрузить нельзя');
    await ui.click(`document.querySelector('[data-testid=profile-mismatch] input[type=checkbox]')`);
    await ui.waitFor(`!${load}.disabled`, 'кнопка открылась');
    await ui.click(load);
    await ui.waitFor(`document.querySelector('[data-testid=scan-profile-mismatch]')?.textContent.includes('подтвердил')`, 'подтверждение в скане', 30_000);

    // «Сменить тип»: реестр и сканы остаются у узла, смена — в истории узла.
    const dockerFile = join(tmp, 'Scan_Docker_2026-10-21.xlsx');
    copyFileSync(SAMPLE, dockerFile);
    await open(`/vulns/node/${win.id}`, `!!${button('Сменить тип')}`, 'экран узла');
    const recordsBefore = (await api(`/api/v1/vulns/nodes/${win.id}/records?state=all`)).total;
    await ui.click(button('Сменить тип'));
    await ui.waitFor(`[...document.querySelectorAll('[role=dialog] select option')].some((o) => o.textContent === 'Docker')`, 'типы в окне');
    assert.ok(!(await ui.evaluate(`[...document.querySelectorAll('[role=dialog] select option')].some((o) => o.textContent === 'Linux')`)), 'тип, который уже есть в группе, не предлагается');
    await ui.select(q('[role=dialog] select[aria-label="Новый тип"]'), await ui.evaluate(`[...document.querySelectorAll('[role=dialog] select option')].find((o) => o.textContent === 'Docker').value`));
    await ui.click(button('Сменить тип', "document.querySelector('[role=dialog]')"));
    await ui.waitFor(`!document.querySelector('[role=dialog]') && document.querySelector('.v-main h1')?.textContent === 'Docker'`, 'тип узла изменён');
    assert.equal((await api(`/api/v1/vulns/nodes/${win.id}/records?state=all`)).total, recordsBefore, 'реестр остался у узла');
    await ui.click(startsWith('История'));
    await ui.waitFor(`document.querySelector('[data-testid=node-history]')?.textContent.includes('«Windows» заменён на «Docker»')`, 'смена типа в истории');

    // Сотрудник без registers.manage: типа нет в группе — сообщение и выбор существующего узла, кнопки нет.
    const roles = (await api('/api/v1/roles')).items;
    const staffRole = roles.find((r) => r.code === 'ib_staff');
    const staff = await send('POST', '/api/v1/users', { login: `${GROUP.toLowerCase()}.staff`, fullName: `Сотрудник ${GROUP}`, roleIds: [staffRole.id] });
    assert.ok(staff.user?.id, JSON.stringify(staff));
    const websiteFile = join(tmp, 'Scan_Website_2026-10-22.xlsx');
    copyFileSync(SAMPLE, websiteFile);
    try {
      await relogin(staff.user.login, staff.temporaryPassword);
      await open(`/vulns/group/${group.id}`, `!!${button('Импорт скана')}`, 'страница группы у сотрудника');
      await ui.click(button('Импорт скана'));
      await ui.waitFor(`!!${dialog('Импорт скана')}`, 'окно импорта');
      await ui.setFiles('[role=dialog] input[type=file]', [websiteFile]);
      await ui.waitFor(`document.querySelector('[role=dialog] .note[role=alert]')?.textContent.includes('Добавить тип Website в группу может сотрудник с правом «Конструктор реестров»')`, 'сообщение без права');
      assert.ok(!(await ui.evaluate(`!!${startsWith('Добавить тип', "document.querySelector('[role=dialog]')")}`)), 'без права кнопки нет');
      assert.equal(await ui.evaluate(`${button('Продолжить', "document.querySelector('[role=dialog]')")}.disabled`), true, 'узел не выбран');
      await ui.select(q('[role=dialog] select[aria-label="Узел"]'), win.id);
      await ui.click(button('Продолжить', "document.querySelector('[role=dialog]')"));
      await ui.waitFor(`document.querySelector('[data-testid=profile-mismatch]')?.textContent.includes('Website')`, 'общий предпросмотр с предупреждением', 20_000);
      await ui.click(button('Отмена', "document.querySelector('[role=dialog]')"));
      assert.equal(await nodesNow(), 2, 'сотрудник узел не создал');
    } finally {
      await relogin(LOGIN, PASSWORD);
      const cur = (await api(`/api/v1/users?q=${encodeURIComponent(staff.user.login)}`)).items.find((u) => u.id === staff.user.id);
      if (cur?.isActive) await send('POST', `/api/v1/users/${staff.user.id}/disable`, { version: cur.version });
    }

    await open('/vulns', `!!document.querySelector('[data-testid=stale-nodes]')`, 'все группы');
    assert.match(await ui.evaluate(`document.querySelector('[data-testid=stale-nodes]').textContent`), /Узлов без скана дольше порога/);
    await ui.waitFor(`!!${treeBtn('Windows')} && [...document.querySelectorAll('.v-tree .v-age')].length > 0`, 'возраст скана в дереве');
  });

  it('удаление группы (1.6.1): с открытыми записями — отказ со списком; пустая — удаляется и восстанавливается из корзины', async () => {
    const modal = `document.querySelector('[role=dialog]')`;
    // Группа прогона: 90 открытых записей — удалить нельзя, окно объясняет почему.
    const main = (await api('/api/v1/vulns/groups')).items.find((g) => g.name === GROUP);
    await open(`/vulns/group/${main.id}`, `!!${button('Удалить группу')}`, 'экран группы');
    await ui.click(button('Удалить группу'));
    await ui.waitFor(`document.querySelector('[data-testid=delete-blocked]')?.textContent.includes('открытые записи')`, 'отказ при открытых записях');
    assert.match(await ui.evaluate(`document.querySelector('[data-testid=delete-blocked]').textContent`), /«Windows» — \d+/);
    assert.ok(!(await ui.evaluate(`!!${button('Удалить', modal)}`)), 'кнопки удаления нет');
    await ui.click(button('Закрыть', modal));

    // Пустая группа: удаляется с причиной и вводом названия, исчезает из дерева, появляется в корзине.
    const name = `${GROUP}-удаление`;
    const types = await api('/api/v1/catalogs/system_types/items');
    const linux = (types.items ?? types).find((t) => t.value === 'Linux');
    const created = await send('POST', '/api/v1/vulns/groups', { name, kind: 'service', systemTypeIds: [linux.id] });
    assert.ok(created.id, `группа не создана: ${JSON.stringify(created)}`);
    await open(`/vulns/group/${created.id}`, `!!${button('Удалить группу')}`, 'экран пустой группы');
    await ui.click(button('Удалить группу'));
    await ui.waitFor(`!!document.querySelector('[data-testid=delete-preview]')`, 'последствия удаления');
    assert.match(await ui.evaluate(`document.querySelector('[data-testid=delete-preview]').textContent`), /Группа .* и её 1 тип систем пропадут/);
    assert.equal(await ui.evaluate(`${button('Удалить', modal)}.disabled`), true, 'без причины и названия — нельзя');
    await ui.type(q('[role=dialog] textarea[aria-label="Причина удаления"]'), 'Создана сквозным тестом');
    await ui.type(q('[role=dialog] input[aria-label="Название для подтверждения"]'), name);
    await ui.click(button('Удалить', modal));
    await ui.waitFor(`location.pathname === '/vulns' && !!${q('.v-tree')} && !${treeBtn(name)}`, 'группы нет в дереве');

    await open('/settings/trash?scope=vulns', `[...document.querySelectorAll('[data-testid=trash-row]')].some((r) => r.textContent.includes(${JSON.stringify(name)}))`, 'событие в корзине');
    const row = `[...document.querySelectorAll('[data-testid=trash-row]')].find((r) => r.textContent.includes(${JSON.stringify(name)}))`;
    assert.match(await ui.evaluate(`${row}.textContent`), /Причина: Создана сквозным тестом/);
    await ui.click(button('Восстановить', row));
    await ui.waitFor(`![...document.querySelectorAll('[data-testid=trash-row]')].some((r) => r.textContent.includes(${JSON.stringify(name)}))`, 'событие восстановлено');
    await open('/vulns', `!!${treeBtn(name)}`, 'группа снова в дереве');
  });

  it('импорт (1.13.9): сбой применения — номер запроса, ничего не записано; «Загружается…», второе нажатие запрос не шлёт', async () => {
    const types = (await api('/api/v1/catalogs/system_types/items')).items ?? [];
    const windows = types.find((t) => t.value === 'Windows');
    assert.ok(windows, `нет типа Windows: ${JSON.stringify(types)}`);
    const group = await send('POST', '/api/v1/vulns/groups', { name: `${GROUP}-импорт`, kind: 'department', systemTypeIds: [windows.id] });
    const node = group.nodes?.[0];
    assert.ok(node?.id, `узел не создан: ${JSON.stringify(group)}`);
    const file = join(tmp, 'vuln-import-2026-10-23.xlsx');
    copyFileSync(SAMPLE, file);
    const preview = async () => {
      await open(`/vulns/node/${node.id}`, `!!${button('Импорт скана')}`, 'экран узла');
      await ui.click(button('Импорт скана'));
      await ui.waitFor(`!!${dialog('Импорт скана')}`, 'окно импорта');
      const mark = ui.mark();
      await ui.setFiles('[role=dialog] input[type=file]', [file]);
      await ui.waitFor(`!!document.querySelector('[role=dialog] .v-dcards')`, 'предпросмотр', 20_000);
      return (await ui.response(await ui.request(mark, 'POST', '/scan-imports'))).id;
    };
    const primary = `document.querySelector('[role=dialog] .btn.primary')`;

    // Сбой внутри применения: не «Попробуйте ещё раз», а номер запроса; в узле ничего нет.
    await breakScanImport(await preview());
    await ui.click(primary, 'Загрузить');
    await ui.waitFor(`document.querySelector('[role=dialog] .form-error')?.textContent.startsWith('Импорт не завершён, ничего не записано')`, 'сообщение о сбое', 20_000);
    assert.match(await ui.evaluate(`document.querySelector('[role=dialog] .form-error').textContent`), /^Импорт не завершён, ничего не записано\. Сообщите администратору номер запроса [0-9a-f]{8}$/);
    assert.equal((await api(`/api/v1/vulns/nodes/${node.id}/records?state=all`)).total, 0, 'ничего не записано');
    await ui.click(button('Отмена', "document.querySelector('[role=dialog]')"));

    // Медленный ответ: кнопка «Загружается…» и неактивна; второе нажатие второй запрос не отправляет.
    await preview();
    ui.holdResponses('/apply');
    const mark = ui.mark();
    try {
      await ui.click(primary, 'Загрузить');
      await ui.waitFor(`${primary}?.textContent === 'Загружается…' && ${primary}.disabled`, '«Загружается…»');
      await ui.click(primary, 'Загружается…');
      await sleep(400);
      assert.equal(ui.requestsSince(mark).filter((r) => r.method === 'POST' && r.url.includes('/apply')).length, 1, 'один запрос применения');
    } finally {
      ui.releaseResponses();
    }
    await ui.waitFor(`location.pathname.startsWith('/vulns/scan/')`, 'экран скана', 30_000);
    assert.equal((await api(`/api/v1/vulns/nodes/${node.id}/records?state=all`)).total, 90);
  });

  it('страница «Реестры» у реестра уязвимостей: нет «Новая запись» и нет загрузки отчёта', async () => {
    const regId = (await api('/api/v1/vulns/overview')).registerId;
    await ui.goto(`/registers?run=${Date.now()}#${regId}/records`);
    await ui.waitFor(`!!document.querySelector('.io')`, 'вкладка записей');
    assert.ok(!(await ui.evaluate(`!!${button('Новая запись')}`)));
    assert.match(await ui.evaluate(`document.querySelector('.io').textContent`), /в разделе «Уязвимости»/);
  });
});
