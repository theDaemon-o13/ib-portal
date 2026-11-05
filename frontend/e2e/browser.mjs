// Драйвер Chrome по протоколу отладки (CDP) без сторонних зависимостей: встроенные fetch и WebSocket Node 24.
// Действия выполняются настоящими событиями мыши и клавиатуры (Input.dispatch*), как у пользователя:
// программный element.click() иначе планирует перерисовку React и может скрыть ошибки (см. CHANGELOG, «Исправлено»).
// Против релизных образов (стенд ibportal-releasetest, nginx на https://localhost:8443 с самоподписанным сертификатом):
//   NODE_EXTRA_CA_CERTS=<certs/portal.crt стенда> E2E_BASE_URL=https://localhost:8443 npm run test:e2e
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

/**
 * «Сегодня» портала, YYYY-MM-DD (+ days): в часовом поясе банка, как backend (backend/src/lib/today.ts),
 * а не по часам машины с тестом. Иначе на машине в UTC (WSL) с 19:00 до 24:00 даты расходятся на сутки.
 */
export function portalToday(days = 0) {
  const tz = process.env.E2E_APP_TZ || 'Asia/Dushanbe';
  const iso = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export async function launchBrowser({ baseUrl, port = 9400 + Math.floor(Math.random() * 400) }) {
  const host = new URL(baseUrl).hostname;
  if (!['localhost', '127.0.0.1'].includes(host)) throw new Error(`e2e запускается только против локального dev-окружения, а не ${baseUrl}`);
  const chrome = CHROME_PATHS.find((p) => existsSync(p));
  if (!chrome) throw new Error('Не найден Chrome. Укажите путь в CHROME_PATH');

  const profile = mkdtempSync(join(tmpdir(), 'ibportal-e2e-'));
  // Проверка релиза (ibportal-releasetest): nginx на https://localhost с самоподписанным сертификатом.
  const tls = new URL(baseUrl).protocol === 'https:' ? ['--ignore-certificate-errors'] : [];
  const proc = spawn(chrome, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1440,1000', ...tls, 'about:blank',
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
      const r = { requestId: m.params.requestId, method: m.params.request.method, url: m.params.request.url.slice(baseUrl.length), body: m.params.request.postData ?? null, headers: m.params.request.headers ?? {}, status: null, done: false };
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
      const release = () => send('Fetch.continueRequest', { requestId }).catch(() => undefined);
      // ui.holdResponses: ответ придерживается до ui.releaseResponses — «медленный сервер».
      if (held.some((part) => (typeof part === 'string' ? m.params.request.url.includes(part) : part.test(m.params.request.url)))) heldQueue.push(() => got.finally(release));
      else void got.finally(release);
    }
    if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    // Сообщения браузера: нарушение CSP (source: security), не загрузившийся worker или скрипт.
    // Ответы API с кодом 4xx (source: network) тесты вызывают намеренно — они не ошибка страницы.
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && m.params.entry.source !== 'network') {
      consoleErrors.push(`[${m.params.entry.source}] ${m.params.entry.text}`);
    }
  });
  await send('Network.enable');
  const responsePattern = { urlPattern: `${baseUrl}/api/*`, requestStage: 'Response' };
  const blocked = [];
  const held = [];
  const heldQueue = [];
  await send('Fetch.enable', { patterns: [responsePattern] });
  await send('Runtime.enable');
  await send('Log.enable');
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

    /**
     * Перезагрузить страницу и дождаться новой. Метка на старой странице: иначе ожидание после reload() проверяет
     * условие ещё на старом документе (там всё уже на месте) и проходит до того, как браузер начал грузить новый.
     */
    async reload(what = 'перезагрузка') {
      await evaluate(`window.__e2eOldPage = true; location.reload()`);
      await ui.waitFor(`!window.__e2eOldPage && document.readyState === 'complete' && !!document.querySelector('#root > *')`, what);
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

    /**
     * Настоящий щелчок мышью по центру элемента. Щёлкаем, только когда элемент готов принять щелчок: он на месте
     * (положение не меняется между двумя опросами — прокрутка и перерисовка закончились) и в точке щелчка именно он
     * или его потомок (не перекрыт окном, закрывающимся слоем, другой карточкой). Иначе щелчок ушёл бы мимо.
     */
    async click(expr, what = expr) {
      await ui.waitFor(`!!(${expr})`, what);
      await evaluate(`(() => { const el = ${expr}; const r = el.getBoundingClientRect();
        if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) el.scrollIntoView({ block: 'center' });
        // Элемент внутри прокручиваемого ряда (чипы фильтров, колонка доски, 1.6.5) — докрутить сам ряд, страница не сдвигается.
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        window.__e2eClickRect = null; })()`);
      const box = await ui.waitFor(`(() => { const el = ${expr}; if (!el) return null;
        // Центр видимой части: строка широкой таблицы может выходить за край окна.
        const r = el.getBoundingClientRect();
        const left = Math.max(r.left, 0), right = Math.min(r.right, innerWidth), top = Math.max(r.top, 0), bottom = Math.min(r.bottom, innerHeight);
        const key = [left, right, top, bottom].map(Math.round).join(',');
        const prev = window.__e2eClickRect; window.__e2eClickRect = key;
        if (prev !== key || right <= left || bottom <= top) return null;
        const x = (left + right) / 2, y = (top + bottom) / 2;
        const hit = document.elementFromPoint(x, y);
        // Флажок в подписи: в точке может быть сама подпись — щелчок по ней тоже переключает флажок.
        const ok = hit && (hit === el || el.contains(hit) || (hit.closest('label')?.contains(el) ?? false));
        return ok ? { x, y } : null; })()`, `${what}: элемент на месте и не перекрыт`);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
      }
      await sleep(120);
    },

    /** Перетащить мышью: нажать на from, провести через несколько точек к to, отпустить. */
    async drag(fromExpr, toExpr, what = 'перетаскивание') {
      await ui.waitFor(`!!(${fromExpr}) && !!(${toExpr})`, what);
      // Прокрутка — только если элемента не видно: иначе прокрутка к высокой колонке сдвинет уже найденную карточку.
      const center = (expr) => evaluate(`(() => { const el = ${expr};
        const v = el.getBoundingClientRect();
        if (v.bottom <= 0 || v.top >= innerHeight || v.right <= 0 || v.left >= innerWidth) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
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
      // Печатать — только когда фокус именно в этом поле: форма могла перестроиться между прицелом и щелчком
      // (подгрузились списки фильтров), и щелчок попал бы в соседнее поле. Не в нём — щёлкнуть снова.
      const t0 = Date.now();
      for (;;) {
        await ui.click(expr, what);
        if (await evaluate(`(() => { const el = ${expr}; return !!el && document.activeElement === el; })()`)) break;
        if (Date.now() - t0 > 8000) throw new Error(`не дождались: фокус в поле ${what}`);
      }
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
      // Поле появляется после перерисовки (вкладка, диалог) — ждём его, а не берём сразу.
      await ui.waitFor(`!!document.querySelector(${JSON.stringify(cssSelector)})`, `элемент ${cssSelector}`);
      const { root } = await send('DOM.getDocument', { depth: 0 });
      const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: cssSelector });
      if (!nodeId) throw new Error(`нет элемента ${cssSelector}`);
      await send('DOM.setFileInputFiles', { nodeId, files: paths });
      await sleep(150);
    },

    /** Обрывать запросы к адресам, содержащим urlPart (сервер недоступен), пока не вызван allowRequests(). */
    /**
     * Дождаться, пока запросов к urlPart в пути нет. Новый запрос по событию (фокус вкладки) TanStack Query не отправляет,
     * если прежний ещё идёт, — присоединяется к нему: блокировка адреса в этот момент не сработала бы.
     */
    async settled(urlPart, what = `запросы ${urlPart} завершены`) {
      const t0 = Date.now();
      while (requests.some((r) => r.url.includes(urlPart) && !r.done)) {
        if (Date.now() - t0 > 8000) throw new Error(`не дождались: ${what}`);
        await sleep(50);
      }
    },

    async failRequests(urlPart) {
      blocked.push(urlPart);
      await send('Fetch.enable', { patterns: [responsePattern, { urlPattern: `${baseUrl}/api/*`, requestStage: 'Request' }] });
    },
    async allowRequests() {
      blocked.length = 0;
      await send('Fetch.enable', { patterns: [responsePattern] });
    },

    /** Придержать ответы API, адрес которых содержит urlPart (строка) или подходит под него (RegExp), пока не вызван releaseResponses. */
    holdResponses(urlPart) {
      held.push(urlPart);
    },
    /** Отпустить придержанные ответы и больше не держать. */
    releaseResponses() {
      held.length = 0;
      for (const go of heldQueue.splice(0)) void go();
    },

    /** Нажать и отпустить клавишу (ArrowLeft, ArrowRight, Space, Escape). */
    async press(key) {
      const keys = {
        ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
        ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
        Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
        Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
        Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
        Plus: { key: '+', code: 'Equal', windowsVirtualKeyCode: 187, text: '+' },
        Minus: { key: '-', code: 'Minus', windowsVirtualKeyCode: 189, text: '-' },
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
