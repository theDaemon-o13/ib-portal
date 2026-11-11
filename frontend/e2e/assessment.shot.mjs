// Скриншоты раздела «Самооценка» с доменом 11 «Контроль ИИ» (1.13.10, задание п. 6): обзор и чек-лист домена 11,
// обе темы, 1440 и 375 px. Не тест сравнения и не входит в полный прогон (не *.e2e.mjs).
// Запуск на одноразовой базе: npm run test:e2e -- e2e/assessment.shot.mjs (SHOTS_DIR — каталог, по умолчанию
// docs/design/ocean/screens). Данные — вымышленные: владелец «Владелец самооценки», ответы по эталону, 11.x — 3/2/1/2.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, it } from 'node:test';
import { $, launchBrowser, sleep } from './browser.mjs';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5174';
const DIR = process.env.SHOTS_DIR ?? new URL('../../docs/design/ocean/screens/', import.meta.url).pathname;
const LOGIN = process.env.E2E_LOGIN;
const PASSWORD = process.env.E2E_PASSWORD;
const RUN = `SHOT-${Date.now().toString(36)}`;
/** Эталон 07.07.2025 по разделам 1–10 (34 из 96) и вымышленные ответы домена 11. */
const ETALON = [2, 1, 2, 1, 2, 1, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 3, 1, 1, 1, 2, 2, 2, 1];
const AI = [3, 2, 1, 2];

let ui;
let owner;
let assessmentId;

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

async function loginAs(login, password) {
  if (!(await ui.evaluate(`location.origin.startsWith('http')`))) await ui.goto('/login');
  await api('POST', '/api/v1/auth/logout');
  await ui.goto(`/login?n=${Date.now()}`);
  await ui.type(`document.querySelector('input[name=username]')`, login);
  await ui.type(`document.querySelector('input[name=password]')`, password);
  await ui.click(`document.querySelector('form button[type=submit]')`);
  await ui.waitFor(`location.pathname !== '/login'`, `вход ${login}`);
  if (await ui.evaluate(`location.pathname === '/change-password'`)) {
    const next = `Оценка-${RUN.slice(5)}-Zq9!`;
    await ui.type(`document.querySelector('input[autocomplete=current-password]')`, password);
    await ui.type(`document.querySelectorAll('input[autocomplete=new-password]')[0]`, next);
    await ui.type(`document.querySelectorAll('input[autocomplete=new-password]')[1]`, next);
    await ui.click($.button('Сменить пароль'));
    await ui.waitFor(`location.pathname !== '/change-password'`, 'смена пароля');
    return next;
  }
  return password;
}

/** focus — на узком экране прокрутить к блоку домена 11 (карточка «Контроль ИИ» или заголовок домена в чек-листе). */
async function shot(name, theme, width, focus = null) {
  const height = width < 500 ? 812 : 1000;
  await ui.viewport(width, height);
  const title = theme === 'ocean' ? 'Тема «Океан»' : 'Тема «Чёрный океан»';
  await ui.evaluate(`(() => { const b = document.querySelector('.seg-top button[title=${JSON.stringify(title).replace(/"/g, '\\"')}]');
    if (b) b.click(); else { localStorage.setItem('ibportal.theme', ${JSON.stringify(theme)}); document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); } })()`);
  if (focus) await ui.evaluate(`document.querySelector(${JSON.stringify(focus)})?.scrollIntoView({ block: 'start' })`);
  else await ui.evaluate('window.scrollTo(0, 0)');
  await sleep(1200);
  writeFileSync(join(DIR, `${name}-${theme}-${width}.jpg`), await ui.screenshot('jpeg', 82));
}

before(async () => {
  assert.ok(LOGIN && PASSWORD, 'Задайте E2E_LOGIN и E2E_PASSWORD');
  ui = await launchBrowser({ baseUrl: BASE });
  mkdirSync(DIR, { recursive: true });
  await loginAs(LOGIN, PASSWORD);
  const role = (await ok('GET', '/api/v1/roles')).items.find((r) => r.code === 'assessment');
  const created = await ok('POST', '/api/v1/users', { login: `${RUN.toLowerCase()}.owner`, fullName: 'Владелец самооценки', roleIds: [role.id] });
  owner = { id: created.user.id, login: created.user.login, password: created.temporaryPassword };
  owner.password = await loginAs(owner.login, owner.password);
  const draft = (await ok('GET', '/api/v1/assessments')).items.find((a) => a.status === 'draft');
  assert.ok(!draft, 'в базе уже есть черновик');
  const a = await ok('POST', '/api/v1/assessments', { title: 'Экспресс-оценка 2026', assessedOn: '2026-11-11' });
  assessmentId = a.id;
  const codes = a.methodology.domains.flatMap((d) => d.sections.map((s) => s.code));
  for (const [i, code] of codes.entries()) {
    const ans = (await ok('GET', `/api/v1/assessments/${a.id}`)).answers.find((x) => x.code === code);
    const level = i < 24 ? ETALON[i] : AI[i - 24];
    const target = code === '1.1' || code === '11.3' ? 3 : undefined;
    await ok('PUT', `/api/v1/assessments/${a.id}/answers/${code}`, { version: ans.version, level, ...(target ? { targetLevel: target } : {}) });
  }
  await ok('PATCH', `/api/v1/assessments/${a.id}`, { version: (await ok('GET', `/api/v1/assessments/${a.id}`)).version, profile: { organization: 'Вымышленный банк', respondent: 'Иванов И.И.' } });
});

after(async () => {
  if (!ui) return;
  try {
    if (assessmentId) {
      const cur = await ok('GET', `/api/v1/assessments/${assessmentId}`);
      if (cur.status !== 'archived') await ok('POST', `/api/v1/assessments/${assessmentId}/archive`, { version: cur.version });
    }
    await loginAs(LOGIN, PASSWORD);
    if (owner) {
      const cur = (await api('GET', `/api/v1/users?q=${encodeURIComponent(owner.login)}`)).json?.items.find((x) => x.id === owner.id);
      if (cur?.isActive) await api('POST', `/api/v1/users/${owner.id}/disable`, { version: cur.version });
    }
  } finally {
    await ui.close();
  }
});

it('скриншоты обзора и чек-листа с доменом 11 в обеих темах, 1440 и 375 px', async () => {
  for (const [name, path, focus] of [['assessment-ai-overview', `/assessment/overview?id=${assessmentId}`, '[data-testid=sa-extra]'], ['assessment-ai-checklist', `/assessment/checklist?id=${assessmentId}&dom=11`, '.sa-dom-h']]) {
    await ui.viewport(1440, 1000);
    await ui.goto(path);
    await ui.waitFor(`!!document.querySelector('[data-testid=sa-extra], .sa-dom-h')`, `страница ${name}`);
    await sleep(1200);
    for (const theme of ['ocean', 'black']) {
      await shot(name, theme, 1440);
      await shot(name, theme, 375, focus);
    }
  }
});
