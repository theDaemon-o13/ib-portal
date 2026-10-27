// Текстовый слой PDF для полнотекстового поиска (этап 8б, ADR-0013). pdf.js (legacy-сборка для Node) работает
// в отдельном потоке: файл присылает пользователь, поэтому разбор ограничен по времени, памяти, страницам и объёму
// текста и не может уронить или подвесить backend. eval в pdf.js выключен; холст (@napi-rs/canvas) не нужен и
// в образ не входит — pdf.js при загрузке пишет об этом предупреждение, поток его отбрасывает.
// OCR сканов не делается: PDF без текстового слоя получает статус no_text (отдельный шаг позже).
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

export interface PdfTextLimits {
  timeoutMs: number;
  maxPages: number;
  /** Символов текста на файл (остальное не индексируется). */
  maxChars: number;
  memoryMb: number;
}

export const PDF_TEXT_LIMITS: PdfTextLimits = { timeoutMs: 30_000, maxPages: 300, maxChars: 1_000_000, memoryMb: 256 };

/** Меньше этого числа непробельных символов — текстового слоя нет (скан, сохранённый как PDF). */
export const MIN_TEXT_CHARS = 20;

export type PdfTextResult =
  | { status: 'text'; text: string; pages: number }
  | { status: 'no_text'; pages: number }
  | { status: 'failed'; error: string };

const require = createRequire(import.meta.url);
const pdfjsDir = dirname(require.resolve('pdfjs-dist/package.json'));

/** Код потока: CommonJS из строки — одинаково работает в dev (tsx), тестах и в собранном dist. */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const warn = console.warn;
  console.warn = (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('Warning: Cannot ')) return; warn(...a); };
  const pdfjs = await import(workerData.pdfjsUrl);
  const task = pdfjs.getDocument({
    data: workerData.data, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, useWorkerFetch: false,
    verbosity: 0, cMapUrl: workerData.cMapUrl, cMapPacked: true, standardFontDataUrl: workerData.fontsUrl,
  });
  const doc = await task.promise;
  let text = '';
  const last = Math.min(doc.numPages, workerData.maxPages);
  for (let i = 1; i <= last && text.length < workerData.maxChars; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((it) => (it.str || '') + (it.hasEOL ? '\\n' : ' ')).join('') + '\\n';
    page.cleanup();
  }
  const pages = doc.numPages;
  await task.destroy();
  parentPort.postMessage({ ok: true, pages, text: text.slice(0, workerData.maxChars) });
})().catch((e) => parentPort.postMessage({ ok: false, error: String((e && e.name) || 'Error') + ': ' + String((e && e.message) || e).slice(0, 300) }));
`;

/** Нормализация: без NUL (PostgreSQL не хранит его в text), без повторных пробелов. */
export function cleanText(s: string): string {
  return s.replaceAll(String.fromCharCode(0), '').replace(/[ \t\f\v\r]+/g, ' ').replace(/ ?\n\s*/g, '\n').trim();
}

export function hasTextLayer(text: string): boolean {
  return text.replace(/\s+/g, '').length >= MIN_TEXT_CHARS;
}

export function extractPdfText(data: Buffer, limits: PdfTextLimits = PDF_TEXT_LIMITS): Promise<PdfTextResult> {
  return new Promise((resolve) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        data: new Uint8Array(data),
        pdfjsUrl: pathToFileURL(join(pdfjsDir, 'legacy', 'build', 'pdf.mjs')).href,
        cMapUrl: `${join(pdfjsDir, 'cmaps')}/`,
        fontsUrl: `${join(pdfjsDir, 'standard_fonts')}/`,
        maxPages: limits.maxPages,
        maxChars: limits.maxChars,
      },
      resourceLimits: { maxOldGenerationSizeMb: limits.memoryMb },
    });
    let done = false;
    const finish = (r: PdfTextResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ status: 'failed', error: `разбор дольше ${Math.round(limits.timeoutMs / 1000)} с` }), limits.timeoutMs);
    worker.on('message', (m: { ok: true; pages: number; text: string } | { ok: false; error: string }) => {
      if (!m.ok) return finish({ status: 'failed', error: m.error });
      const text = cleanText(m.text);
      finish(hasTextLayer(text) ? { status: 'text', text, pages: m.pages } : { status: 'no_text', pages: m.pages });
    });
    worker.on('error', (err) => finish({ status: 'failed', error: err.message.slice(0, 300) }));
    worker.on('exit', (code) => finish({ status: 'failed', error: `поток разбора завершился (код ${code})` }));
  });
}
