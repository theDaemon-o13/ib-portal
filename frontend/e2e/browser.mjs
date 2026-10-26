// Драйвер Chrome по протоколу отладки (CDP) без сторонних зависимостей: встроенные fetch и WebSocket Node 24.
// Действия выполняются настоящими событиями мыши и клавиатуры (Input.dispatch*), как у пользователя:
// программный element.click() иначе планирует перерисовку React и может скрыть ошибки (см. CHANGELOG, «Исправлено»).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launchBrowser({ baseUrl, port = 9400 + Math.floor(Math.random() * 400) }) {
  const host = new URL(baseUrl).hostname;
  if (!['localhost', '127.0.0.1'].includes(host)) throw new Error(`e2e запускается только против локального dev-окружения, а не ${baseUrl}`);
  const chrome = CHROME_PATHS.find((p) => existsSync(p));
  if (!chrome) throw new Error('Не найден Chrome. Укажите путь в CHROME_PATH');

  const profile = mkdtempSync(join(tmpdir(), 'ibportal-e2e-'));
  const proc = spawn(chrome, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1440,1000', 'about:blank',
  ], { stdio: 'ignore' });

  let targets = [];
  for (let i = 0; i < 100 && !targets.length; i++) {
    try { targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter((t) => t.type === 'page'); } catch { /* ещё стартует */ }
    if (!targets.length) await sleep(100);
  }
  if (!targets.length) throw new Error('Chrome не запустился');
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));

  let seq = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method) for (const l of listeners) l(msg);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });

  // Журнал запросов к API: метод, адрес, тело, статус.
  const requests = [];
  const byId = new Map();
  const consoleErrors = [];
  listeners.add((m) => {
    if (m.method === 'Network.requestWillBeSent' && m.params.request.url.startsWith(`${baseUrl}/api/`)) {
      const r = { method: m.params.request.method, url: m.params.request.url.slice(baseUrl.length), body: m.params.request.postData ?? null, status: null };
      requests.push(r);
      byId.set(m.params.requestId, r);
    }
    if (m.method === 'Network.responseReceived' && byId.has(m.params.requestId)) byId.get(m.params.requestId).status = m.params.response.status;
    if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  });
  await send('Network.enable');
  await send('Runtime.enable');
  await send('Page.enable');

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };

  const ui = {
    requests,
    consoleErrors,
    evaluate,
    /** Пометка в журнале запросов: requestsSince(mark) — всё, что ушло после неё. */
    mark: () => requests.length,
    requestsSince: (mark) => requests.slice(mark),

    async goto(path) {
      await send('Page.navigate', { url: `${baseUrl}${path}` });
      await ui.waitFor(`document.readyState === 'complete' && !!document.querySelector('#root > *')`, `страница ${path}`);
      await sleep(300);
    },

    /** Ждать, пока выражение в странице станет истинным. */
    async waitFor(expr, what, timeout = 8000) {
      const t0 = Date.now();
      for (;;) {
        const v = await evaluate(`(() => { try { return ${expr}; } catch { return null; } })()`);
        if (v) return v;
        if (Date.now() - t0 > timeout) throw new Error(`не дождались: ${what}`);
        await sleep(60);
      }
    },

    /** Настоящий щелчок мышью по центру элемента. */
    async click(expr, what = expr) {
      await ui.waitFor(`!!(${expr})`, what);
      const box = await evaluate(`(() => { const el = ${expr}; el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
      }
      await sleep(120);
    },

    /** Очистить поле и ввести текст с клавиатуры. */
    async type(expr, text, what = expr) {
      await ui.click(expr, what);
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', commands: ['selectAll'] });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' });
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      if (text) await send('Input.insertText', { text });
      await sleep(80);
    },

    /**
     * Выбор в <select>. Выпадающий список в headless Chrome мышью не открывается, поэтому значение
     * ставится нативным setter'ом с событием change — тем же, что вызывает выбор пользователя.
     */
    async select(expr, value, what = expr) {
      await ui.waitFor(`!!(${expr})`, what);
      await evaluate(`(() => { const el = ${expr};
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await sleep(80);
    },

    /** Ждать запрос method url* после пометки и ответ на него. */
    async request(mark, method, urlPart, what = `${method} ${urlPart}`) {
      const t0 = Date.now();
      for (;;) {
        const r = requests.slice(mark).find((x) => x.method === method && x.url.includes(urlPart) && x.status !== null);
        if (r) return { ...r, json: r.body ? JSON.parse(r.body) : null };
        if (Date.now() - t0 > 8000) throw new Error(`не дождались запроса ${what}; были: ${JSON.stringify(requests.slice(mark))}`);
        await sleep(50);
      }
    },

    /** Выбрать файл в <input type=file> (как пользователь в диалоге выбора файла). */
    async setFiles(cssSelector, paths) {
      const { root } = await send('DOM.getDocument', { depth: 0 });
      const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: cssSelector });
      if (!nodeId) throw new Error(`нет элемента ${cssSelector}`);
      await send('DOM.setFileInputFiles', { nodeId, files: paths });
      await sleep(150);
    },

    text: (expr) => evaluate(`(() => { const el = ${expr}; return el ? el.textContent.trim() : null; })()`),
    toast: () => evaluate(`document.querySelector('.toast.on')?.textContent ?? null`),

    close() {
      try { ws.close(); } catch { /* уже закрыт */ }
      proc.kill('SIGKILL');
      setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500).unref();
    },
  };
  return ui;
}

/** Выражения для поиска элементов на странице (строки JS, выполняются в браузере). */
export const $ = {
  row: (text) => `[...document.querySelectorAll('tbody tr')].find((tr) => tr.textContent.includes(${JSON.stringify(text)}))`,
  button: (label, within = 'document') =>
    `[...(${within}).querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)} && !b.disabled)`,
  editing: `document.querySelector('tr.editing')`,
  input: (aria, within = `document.querySelector('tr.editing')`) => `(${within})?.querySelector('[aria-label=${JSON.stringify(aria)}]')`,
  field: (label, within = 'document') =>
    `[...(${within}).querySelectorAll('label')].find((l) => l.textContent.trim().startsWith(${JSON.stringify(label)}))?.querySelector('input, select')`,
};
