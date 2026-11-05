// Сессия в браузере (ADR-0023). С 1.10.0 сессия не завершается по бездействию: окна «Продолжить работу» и
// заголовка X-Session-Idle-Ms больше нет. Остаётся признак фонового запроса (X-Background: 1): опрос по таймеру
// не обновляет «последнюю активность» в «Моих сессиях». Сессию закрыли (срок, «Завершить», смена пароля) —
// любой 401 ведёт на вход с объяснением и возвратом на ту же страницу.

/** Запрос в течение этого времени после щелчка или нажатия клавиши — действие пользователя. */
export const ACTIVE_WINDOW_MS = 5_000;

/** Загрузка страницы — тоже действие (обновление вкладки, переход по ссылке). */
let lastInputAt = Date.now();
let expired = false;

export function noteUserInput(at = Date.now()): void {
  lastInputAt = at;
}

/** Фоновый ли запрос: давно не было щелчка или клавиши. */
export function isBackground(now = Date.now()): boolean {
  return now - lastInputAt > ACTIVE_WINDOW_MS;
}

/** Сессия закончилась посреди работы: страница входа объясняет и вернёт на ту же страницу. */
export function markExpired(): void {
  expired = true;
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
