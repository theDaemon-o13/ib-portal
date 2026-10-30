// Сквозной тест раздела «Уязвимости» (релиз 1.5.0) тем же путём, что и браузер пользователя: Chrome → Vite (прокси /api) →
// backend → PostgreSQL, настоящие щелчки мыши и ввод с клавиатуры. Создать группу с типом → импорт образца → предпросмотр →
// загрузить → передать ИКТ → «Обновить сроки» (было → станет) → отмена → карточка записи → перенос из «Без группы».
//
//   npm run test:e2e   (логин и пароль — из frontend/.env.e2e или E2E_LOGIN / E2E_PASSWORD)
//
// Группы не удаляются (ADR-0029): на каждый прогон в dev-базе остаётся группа «E2E-…». Право vulns.deadlines на время
// прогона выдаётся своей ролью, после прогона роль снимается и удаляется. Записи группы — в архив.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { launchBrowser, portalToday } from './browser.mjs';

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
  const me = await findMe();
  priorRoleIds = me.roles.map((r) => r.id);
  const patched = await send('PATCH', `/api/v1/users/${meId}`, { version: me.version, roleIds: [...priorRoleIds, roleId] });
  assert.ok(patched.id, `роль не назначилась: ${JSON.stringify(patched)}`);
});

after(async () => {
  if (ui) {
    try {
      if (nodeId) {
        const page = await api(`/api/v1/vulns/nodes/${nodeId}/records?state=all&limit=200`);
        for (const r of page.items ?? []) await send('POST', `/api/v1/register-records/${r.id}/archive`, { version: r.version });
      }
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
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('Раздел «Уязвимости»', () => {
  it('создать группу с типом: появляется в дереве, карточка узла открывается', async () => {
    await open('/vulns', `!!${q('.v-tree')}`, 'дерево групп');
    await ui.click(startsWith('+ Группа'));
    await ui.waitFor(`!!${dialog('Создать группу')}`, 'окно группы');
    await ui.type(q('input[aria-label="Название группы"]'), GROUP);
    await ui.waitFor(`[...document.querySelectorAll('[role=dialog] label.check')].some((l) => l.textContent.includes('Рабочие станции'))`, 'типы систем');
    await ui.click(`[...document.querySelectorAll('[role=dialog] label.check')].find((l) => l.textContent.includes('Рабочие станции')).querySelector('input')`);
    await ui.click(button('Создать', dialog('Создать группу')));
    await ui.waitFor(`location.pathname.startsWith('/vulns/group/') && !!${treeBtn(GROUP)}`, 'группа в дереве');
    await ui.click(`[...document.querySelectorAll('.v-tcard')].find((c) => c.textContent.includes('Рабочие станции'))`);
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
    await ui.evaluate(`(() => { const s = ${q('select[aria-label="Статус"]')}; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'all'); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
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

  it('страница «Реестры» у реестра уязвимостей: нет «Новая запись» и нет загрузки отчёта', async () => {
    const regId = (await api('/api/v1/vulns/overview')).registerId;
    await ui.goto(`/registers?run=${Date.now()}#${regId}/records`);
    await ui.waitFor(`!!document.querySelector('.io')`, 'вкладка записей');
    assert.ok(!(await ui.evaluate(`!!${button('Новая запись')}`)));
    assert.match(await ui.evaluate(`document.querySelector('.io').textContent`), /в разделе «Уязвимости»/);
  });
});
