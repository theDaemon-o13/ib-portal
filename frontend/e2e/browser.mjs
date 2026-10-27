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
  const bodies = new Map();
  const consoleErrors = [];
  listeners.add((m) => {
    if (m.method === 'Network.requestWillBeSent' && m.params.request.url.startsWith(`${baseUrl}/api/`)) {
      const r = { requestId: m.params.requestId, method: m.params.request.method, url: m.params.request.url.slice(baseUrl.length), body: m.params.request.postData ?? null, status: null, done: false };
      requests.push(r);
      byId.set(m.params.requestId, r);
    }
    if (m.method === 'Network.responseReceived' && byId.has(m.params.requestId)) byId.get(m.params.requestId).status = m.params.response.status;
    if ((m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') && byId.has(m.params.requestId)) {
      const r = byId.get(m.params.requestId);
      r.done = true;
    }
    // Тело ответа API забирается на перехвате (Fetch): из буфера Network Chrome теряет ответы
    // на запросы, у которых тело — файл (предпросмотр импорта), с ошибкой «evicted from inspector cache».
    if (m.method === 'Fetch.requestPaused' && m.params.responseStatusCode === undefined && m.params.responseErrorReason === undefined) {
      // Этап запроса: перехватывается, только пока включён обрыв (ui.failRequests) — «сервер недоступен».
      const { requestId, request } = m.params;
      const fail = blocked.some((part) => request.url.includes(part));
      void (fail ? send('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' }) : send('Fetch.continueRequest', { requestId })).catch(() => undefined);
      return;
    }
    if (m.method === 'Fetch.requestPaused') {
      const { requestId, networkId } = m.params;
      const got = send('Fetch.getResponseBody', { requestId }).catch((e) => ({ error: e.message }));
      bodies.set(networkId, got);
      void got.finally(() => send('Fetch.continueRequest', { requestId }).catch(() => undefined));
    }
    if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  });
  await send('Network.enable');
  const responsePattern = { urlPattern: `${baseUrl}/api/*`, requestStage: 'Response' };
  const blocked = [];
  await send('Fetch.enable', { patterns: [responsePattern] });
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
        // Центр видимой части: строка широкой таблицы может выходить за край окна.
        const r = el.getBoundingClientRect();
        const left = Math.max(r.left, 0), right = Math.min(r.right, innerWidth), top = Math.max(r.top, 0), bottom = Math.min(r.bottom, innerHeight);
        return { x: (left + right) / 2, y: (top + bottom) / 2 }; })()`);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
      }
      await sleep(120);
    },

    /** Перетащить мышью: нажать на from, провести через несколько точек к to, отпустить. */
    async drag(fromExpr, toExpr, what = 'перетаскивание') {
      await ui.waitFor(`!!(${fromExpr}) && !!(${toExpr})`, what);
      const center = (expr) => evaluate(`(() => { const el = ${expr}; el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const r = el.getBoundingClientRect();
        const left = Math.max(r.left, 0), right = Math.min(r.right, innerWidth), top = Math.max(r.top, 0), bottom = Math.min(r.bottom, innerHeight);
        return { x: (left + right) / 2, y: (top + bottom) / 2 }; })()`);
      const a = await center(fromExpr);
      const b = await center(toExpr);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', buttons: 1, clickCount: 1 });
      for (let i = 1; i <= 8; i++) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x + ((b.x - a.x) * i) / 8, y: a.y + ((b.y - a.y) * i) / 8, button: 'left', buttons: 1 });
        await sleep(30);
      }
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(150);
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

    /** Ждать запрос method url* после пометки и ответ на него; json — тело запроса, ответ — ui.response(req). */
    async request(mark, method, urlPart, what = `${method} ${urlPart}`) {
      const t0 = Date.now();
      for (;;) {
        const r = requests.slice(mark).find((x) => x.method === method && x.url.includes(urlPart) && x.status !== null);
        if (r) return { ...r, json: r.body ? JSON.parse(r.body) : null };
        if (Date.now() - t0 > 8000) throw new Error(`не дождались запроса ${what}; были: ${JSON.stringify(requests.slice(mark))}`);
        await sleep(50);
      }
    },

    /** Тело ответа на запрос из журнала (JSON или null для пустого ответа). */
    async response(req) {
      for (let i = 0; i < 100 && !bodies.has(req.requestId); i++) await sleep(50);
      const got = await bodies.get(req.requestId);
      if (!got || got.error) throw new Error(`нет тела ответа ${req.method} ${req.url}: ${got?.error ?? 'запрос не завершился'}`);
      const { body, base64Encoded } = got;
      const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
      return text ? JSON.parse(text) : null;
    },

    /** Выбрать файл в <input type=file> (как пользователь в диалоге выбора файла). */
    async setFiles(cssSelector, paths) {
      const { root } = await send('DOM.getDocument', { depth: 0 });
      const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: cssSelector });
      if (!nodeId) throw new Error(`нет элемента ${cssSelector}`);
      await send('DOM.setFileInputFiles', { nodeId, files: paths });
      await sleep(150);
    },

    /** Обрывать запросы к адресам, содержащим urlPart (сервер недоступен), пока не вызван allowRequests(). */
    async failRequests(urlPart) {
      blocked.push(urlPart);
      await send('Fetch.enable', { patterns: [responsePattern, { urlPattern: `${baseUrl}/api/*`, requestStage: 'Request' }] });
    },
    async allowRequests() {
      blocked.length = 0;
      await send('Fetch.enable', { patterns: [responsePattern] });
    },

    /** Нажать и отпустить клавишу (ArrowLeft, ArrowRight, Space, Escape). */
    async press(key) {
      const keys = {
        ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
        ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
        Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
        Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
        Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
      };
      const k = keys[key];
      if (!k) throw new Error(`нет клавиши ${key}`);
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...k });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...k, text: undefined });
      await sleep(120);
    },

    /** Подвинуть мышь (панель управления мониторингом появляется при движении). */
    async moveMouse(x, y) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await sleep(80);
    },

    /** Размер окна (CSS-пиксели). */
    async viewport(width, height) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await sleep(200);
    },

    /** Снимок видимой части страницы в PNG. */
    async screenshot() {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      return Buffer.from(data, 'base64');
    },

    /** Открыть произвольный адрес (например, file:// прототипа). */
    async open(url) {
      await send('Page.navigate', { url });
      await sleep(800);
    },

    text: (expr) => evaluate(`(() => { const el = ${expr}; return el ? el.textContent.trim() : null; })()`),
    toast: () => evaluate(`document.querySelector('.toast.on')?.textContent ?? null`),

    close() {
      try { ws.close(); } catch { /* уже закрыт */ }
      // Профиль удаляется, когда Chrome завершился: дочерний процесс держит цикл событий, поэтому удаление
      // успевает до выхода node (таймер с unref() не срабатывал — профили по 30–40 МБ копились в $TMPDIR).
      // Вспомогательные процессы Chrome (GPU, crashpad) дописывают профиль и после выхода главного — ENOTEMPTY:
      // повторяем, а неудачу не превращаем в падение теста (это лишь временный каталог).
      proc.once('exit', () => {
        try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* останется в $TMPDIR */ }
      });
      proc.kill('SIGKILL');
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
