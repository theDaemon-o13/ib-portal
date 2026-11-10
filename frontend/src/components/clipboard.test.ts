import { describe, expect, it } from 'vitest';
import { copyLines, copyText, CopyFailed, type ClipboardEnv } from './clipboard';

function env(over: Partial<ClipboardEnv> = {}) {
  const written: string[] = [];
  const fallback: string[] = [];
  const e: ClipboardEnv = {
    secure: true,
    clipboard: { writeText: async (t) => { written.push(t); } },
    execCopy: (t) => { fallback.push(t); return true; },
    ...over,
  };
  return { e, written, fallback };
}

describe('копирование в буфер (1.13.6)', () => {
  it('кладёт ровно значение: без пробелов по краям, чистым текстом', async () => {
    const { e, written, fallback } = env();
    expect(await copyText('  Иванов И.И.\t ', e)).toBe('clipboard');
    expect(await copyText('ivanov@example.com', e)).toBe('clipboard');
    expect(written).toEqual(['Иванов И.И.', 'ivanov@example.com']);
    expect(fallback).toEqual([]);
  });

  it('нет защищённого контекста или браузер отказал — запасной путь (временное поле и execCommand)', async () => {
    const insecure = env({ secure: false });
    expect(await copyText(' Технический директор ', insecure.e)).toBe('fallback');
    expect([insecure.written, insecure.fallback]).toEqual([[], ['Технический директор']]);

    const denied = env({ clipboard: { writeText: async () => { throw new Error('NotAllowedError'); } } });
    expect(await copyText('ivanov@example.com', denied.e)).toBe('fallback');
    expect(denied.fallback).toEqual(['ivanov@example.com']);

    const none = env({ clipboard: null });
    expect(await copyText('Иванов И.И.', none.e)).toBe('fallback');
  });

  it('не вышло ни то, ни другое — ошибка с понятным текстом', async () => {
    const { e } = env({ secure: false, execCopy: () => false });
    await expect(copyText('Иванов И.И.', e)).rejects.toBeInstanceOf(CopyFailed);
    await expect(copyText('Иванов И.И.', e)).rejects.toThrow(/выделите текст и скопируйте вручную/);
  });

  it('«Копировать все…» — по строке на значение в том же порядке, пустые пропущены, края обрезаны', () => {
    expect(copyLines(['Иванов И.И.', ' Петрова П.П. ', 'Сидоров С.С.'])).toEqual({ text: 'Иванов И.И.\nПетрова П.П.\nСидоров С.С.', count: 3 });
    expect(copyLines(['ivanov@example.com', '', null, '  ', 'sidorov@example.com'])).toEqual({ text: 'ivanov@example.com\nsidorov@example.com', count: 2 });
    expect(copyLines(['', undefined])).toEqual({ text: '', count: 0 });
  });
});
