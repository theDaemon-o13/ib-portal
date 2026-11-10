// Копирование в буфер обмена (1.13.6): значение полей ответственных лиц для титульного листа в OnlyOffice и Word.
// Только чистый текст (без HTML) и без пробелов по краям — при вставке не тянутся стили.
//
// navigator.clipboard есть только в защищённом контексте (HTTPS или localhost). Прод открывается только по HTTPS
// (nginx слушает 8443 ssl, compose публикует 443), но браузер может отказать в доступе к буферу — тогда запасной путь:
// временное поле и document.execCommand('copy'). Не вышло ни то, ни другое — ошибка CopyFailed.

export class CopyFailed extends Error {
  constructor() {
    super('Не удалось скопировать — выделите текст и скопируйте вручную');
    this.name = 'CopyFailed';
  }
}

/** Что нужно копированию от окружения — подменяется в unit-тестах. */
export interface ClipboardEnv {
  clipboard?: { writeText: (text: string) => Promise<void> } | null;
  secure: boolean;
  /** Запасной путь: true — скопировано. */
  execCopy: (text: string) => boolean;
}

/** Запасной путь: временное поле вне экрана, выделить, execCommand('copy'), убрать; фокус — обратно. */
function execCopyInDom(text: string): boolean {
  const prev = document.activeElement as HTMLElement | null;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.setAttribute('aria-hidden', 'true');
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    // Устаревший, но единственный путь без navigator.clipboard.
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    ta.remove();
    prev?.focus?.();
  }
  return ok;
}

function browserEnv(): ClipboardEnv {
  return {
    clipboard: typeof navigator !== 'undefined' ? navigator.clipboard : null,
    secure: typeof window !== 'undefined' && window.isSecureContext,
    execCopy: execCopyInDom,
  };
}

/** Значение для буфера: пробелы по краям обрезаны. */
export const clean = (v: string) => v.trim();

/** Несколько значений — по одному на строку, пустые пропущены. */
export function copyLines(values: readonly (string | null | undefined)[]): { text: string; count: number } {
  const lines = values.map((v) => clean(v ?? '')).filter(Boolean);
  return { text: lines.join('\n'), count: lines.length };
}

/** Положить текст в буфер. Возвращает способ; не вышло — CopyFailed. */
export async function copyText(text: string, env: ClipboardEnv = browserEnv()): Promise<'clipboard' | 'fallback'> {
  const value = clean(text);
  if (env.secure && env.clipboard) {
    try {
      await env.clipboard.writeText(value);
      return 'clipboard';
    } catch {
      // Браузер отказал (нет разрешения, вкладка не в фокусе) — запасной путь.
    }
  }
  if (env.execCopy(value)) return 'fallback';
  throw new CopyFailed();
}
