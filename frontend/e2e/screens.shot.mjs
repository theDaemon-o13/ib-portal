// Скриншоты экранов «Океан» (1.13.0, задание 1.13.0, раздел 7): обе темы и ширина 375 px, для проверки глазами.
// Не тест сравнения и не входит в полный прогон (не *.e2e.mjs). Запуск: npm run test:e2e -- e2e/screens.shot.mjs
// SHOTS=dashboard,tasks — только эти экраны; SHOTS_DIR — каталог (по умолчанию docs/design/ocean/screens).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, it } from 'node:test';
import { launchBrowser, sleep } from './browser.mjs';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5174';
const DIR = process.env.SHOTS_DIR ?? new URL('../../docs/design/ocean/screens/', import.meta.url).pathname;
const ONLY = (process.env.SHOTS ?? '').split(',').filter(Boolean);
const SCREENS = [
  ['dashboard', '/dashboard'],
  ['tasks', '/tasks'],
  ['registers', '/registers'],
  ['vulns', '/vulns'],
  ['assets', '/assets'],
  ['documents', '/documents/work'],
  ['documents-approved', '/documents/approved'],
  ['evidence', '/evidence'],
  ['awareness', '/awareness/letters'],
  ['assessment', '/assessment'],
  ['settings', '/settings/catalogs'],
  ['users', '/settings/users'],
  ['profile', '/profile'],
  ['search', '/search?q=пароль'],
  ['not-found', '/no-such-page'],
].filter(([name]) => !ONLY.length || ONLY.includes(name));

let ui;
before(async () => {
  ui = await launchBrowser({ baseUrl: BASE });
  mkdirSync(DIR, { recursive: true });
});
after(async () => ui?.close());

async function shot(name, theme, width) {
  const height = width < 500 ? 812 : 1000;
  await ui.viewport(width, height);
  // Тема — кнопкой переключателя (как пользователь); без переключателя на странице — атрибутом.
  const title = theme === 'ocean' ? 'Тема «Океан»' : 'Тема «Чёрный океан»';
  await ui.evaluate(`(() => { const b = document.querySelector('.seg-top button[title=${JSON.stringify(title).replace(/"/g, '\\"')}]');
    if (b) b.click(); else { localStorage.setItem('ibportal.theme', ${JSON.stringify(theme)}); document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); } })()`);
  await sleep(1300);
  writeFileSync(join(DIR, `${name}-${theme}-${width}.png`), await ui.screenshot());
}

it('скриншоты экранов в обеих темах и на 375 px', async () => {
  // Вход — сначала скриншот формы.
  await ui.goto('/login');
  await ui.waitFor(`!!document.querySelector('input[name=username]')`, 'форма входа');
  if (!ONLY.length || ONLY.includes('login')) for (const t of ['ocean', 'black']) await shot('login', t, 1440);
  await ui.type(`document.querySelector('input[name=username]')`, process.env.E2E_LOGIN);
  await ui.type(`document.querySelector('input[name=password]')`, process.env.E2E_PASSWORD);
  await ui.click(`document.querySelector('form button[type=submit]')`);
  await ui.waitFor(`location.pathname !== '/login'`, 'вход');
  for (const [name, path] of SCREENS) {
    await ui.viewport(1440, 1000);
    await ui.goto(path);
    await sleep(1500);
    for (const t of ['ocean', 'black']) await shot(name, t, 1440);
    await shot(name, 'ocean', 375);
  }
});
