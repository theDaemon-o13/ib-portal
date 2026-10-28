// «Запомнить логин»: в localStorage кладётся только логин. Пароль сохраняет лишь
// менеджер паролей браузера (autocomplete), портал его нигде не хранит.

const STORAGE_KEY = 'ibportal.login';

export interface LoginStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function loadRememberedLogin(store: LoginStore | undefined): string {
  try {
    return store?.getItem(STORAGE_KEY)?.trim().slice(0, 100) ?? '';
  } catch {
    return '';
  }
}

/** После успешного входа: запомнить логин или забыть ранее запомненный. */
export function saveRememberedLogin(store: LoginStore | undefined, login: string, remember: boolean): void {
  try {
    if (remember && login.trim()) store?.setItem(STORAGE_KEY, login.trim());
    else store?.removeItem(STORAGE_KEY);
  } catch {
    // хранилище недоступно — логин просто не запомнится
  }
}
