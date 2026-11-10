// Кнопка «Копировать» у поля (1.13.6): значок, видна всегда (и на сенсорном экране), с клавиатуры — Tab и Enter.
// Подпись для экранного диктора — «Копировать ФИО Иванов И.И.». После копирования — «Скопировано» (уведомление внизу
// и отметка на кнопке), ошибка — уведомлением. Копирует только значение, чистым текстом (clipboard.ts).
import { useEffect, useState } from 'react';
import { copyLines, copyText } from './clipboard';
import { useToast } from './Toast';

/** Скопировать и сообщить: одно значение — «Скопировано», несколько — «Скопировано: N». */
export function useCopy() {
  const toast = useToast();
  return async (values: string | readonly (string | null | undefined)[], what = ''): Promise<boolean> => {
    const { text, count } = typeof values === 'string' ? copyLines([values]) : copyLines(values);
    if (!count) {
      toast(`Нечего копировать${what ? `: ${what}` : ''}`, 'warn');
      return false;
    }
    try {
      await copyText(text);
      toast(typeof values === 'string' ? 'Скопировано' : `Скопировано: ${count}`);
      return true;
    } catch (err) {
      toast((err as Error).message, 'error');
      return false;
    }
  };
}

const CopyIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="9" width="11" height="11" rx="2.5" /><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15" />
  </svg>
);
const DoneIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
);

/** Значок «Копировать» рядом со значением. what — что копируется («ФИО»), value — значение. */
export function CopyButton({ what, value, testId }: { what: string; value: string; testId?: string }) {
  const copy = useCopy();
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return undefined;
    const t = window.setTimeout(() => setDone(false), 1600);
    return () => window.clearTimeout(t);
  }, [done]);
  if (!value.trim()) return null;
  const label = `Копировать ${what} ${value.trim()}`;
  return (
    <button type="button" className={`copy-btn${done ? ' done' : ''}`} aria-label={label} title={done ? 'Скопировано' : `Копировать ${what}`} data-testid={testId} data-copy={what}
      onClick={async () => { if (await copy(value)) setDone(true); }}>
      {done ? <DoneIcon /> : <CopyIcon />}
    </button>
  );
}
