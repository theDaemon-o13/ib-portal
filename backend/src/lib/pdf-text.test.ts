import { describe, expect, it } from 'vitest';
import { scanPdf, textPdf, tinyPdf } from '../test/files-fixture.js';
import { cleanText, extractPdfText, hasTextLayer, MIN_TEXT_CHARS, PDF_TEXT_LIMITS } from './pdf-text.js';

describe('текст PDF (этап 8б)', () => {
  it('PDF с текстовым слоем: кириллица через ToUnicode, строки сохраняются', async () => {
    const r = await extractPdfText(textPdf(['Разрешение № 12/45-р на Telegram', 'Устройство WS-BUH-014, до 31.12.2026']));
    expect(r.status).toBe('text');
    if (r.status !== 'text') return;
    expect(r.pages).toBe(1);
    expect(r.text).toContain('Разрешение № 12/45-р на Telegram');
    expect(r.text).toContain('WS-BUH-014');
  });

  it('скан без текстового слоя — no_text (поиск только по полям), не ошибка', async () => {
    expect(await extractPdfText(scanPdf())).toEqual({ status: 'no_text', pages: 1 });
  });

  it('почти пустой текст (меньше порога) — тоже no_text', async () => {
    expect((await extractPdfText(tinyPdf('1'))).status).toBe('no_text');
    expect(hasTextLayer('a'.repeat(MIN_TEXT_CHARS - 1))).toBe(false);
    expect(hasTextLayer(' a'.repeat(MIN_TEXT_CHARS))).toBe(true);
  });

  it('битый файл — failed с причиной, backend не падает', async () => {
    const r = await extractPdfText(Buffer.from('%PDF-1.4\nэто не pdf'));
    expect(r.status).toBe('failed');
  });

  it('разбор дольше лимита прерывается', async () => {
    const r = await extractPdfText(textPdf(['Документ-основание для проверки лимита времени']), { ...PDF_TEXT_LIMITS, timeoutMs: 1 });
    expect(r).toEqual({ status: 'failed', error: 'разбор дольше 0 с' });
  });

  it('cleanText: без NUL и повторных пробелов', () => {
    expect(cleanText('a\u0000b   c\n\n\n d')).toBe('ab c\nd');
  });
});
