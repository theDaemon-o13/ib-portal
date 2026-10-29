// Сессия в браузере (релиз 1.2.0, ADR-0023): что считать действием пользователя и когда предупредить о завершении.
// Backend закрывает сессию после 30 минут без действий; запросы, ушедшие без действия пользователя (опрос по таймеру),
// идут с X-Background: 1 и сессию не продлевают. Остаток до завершения backend сообщает в X-Session-Idle-Ms.

/** Запрос в течение этого времени после щелчка или нажатия клавиши — действие пользователя. */
export const ACTIVE_WINDOW_MS = 5_000;
/** За сколько до завершения показать «Сессия завершится через 2 минуты». */
export const WARN_BEFORE_MS = 2 * 60_000;

/** Загрузка страницы — тоже действие (обновление вкладки, переход по ссылке). */
let lastInputAt = Date.now();
let deadline: number | null = null;
let expired = false;
const listeners = new Set<() => void>();

export function noteUserInput(at = Date.now()): void {
  lastInputAt = at;
}

/** Фоновый ли запрос: давно не было щелчка или клавиши. */
export function isBackground(now = Date.now()): boolean {
  return now - lastInputAt > ACTIVE_WINDOW_MS;
}

/** Ответ backend с остатком до завершения по бездействию (у киоска заголовка нет). */
export function noteIdleRemaining(header: string | null, now = Date.now()): void {
  if (header === null) return;
  const ms = Number(header);
  if (!Number.isFinite(ms)) return;
  deadline = now + ms;
  for (const l of listeners) l();
}

export function sessionDeadline(): number | null {
  return deadline;
}

export function onSessionDeadline(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export type SessionPhase = 'ok' | 'warn' | 'over';

export function sessionPhase(deadlineAt: number | null, now = Date.now()): SessionPhase {
  if (deadlineAt === null) return 'ok';
  const left = deadlineAt - now;
  if (left <= 0) return 'over';
  return left <= WARN_BEFORE_MS ? 'warn' : 'ok';
}

/** Сессия закончилась посреди работы: страница входа объясняет почему и вернёт на ту же страницу. */
export function markExpired(): void {
  expired = true;
  deadline = null;
}

export function wasExpired(): boolean {
  return expired;
}

/** После входа сообщение больше не нужно. */
export function clearExpired(): void {
  expired = false;
}

export function installInputTracking(target: Pick<Window, 'addEventListener'> = window): void {
  const note = () => noteUserInput();
  target.addEventListener('pointerdown', note, { capture: true, passive: true });
  target.addEventListener('keydown', note, { capture: true, passive: true });
}
