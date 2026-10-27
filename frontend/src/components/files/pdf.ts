// pdf.js из сборки (без CDN): загружается отдельным чанком только при первом просмотре PDF.
// Без WebAssembly (CSP портала его не разрешает): декодеры изображений — на JS. eval в pdf.js 6 не используется.
import type { PDFDocumentProxy } from 'pdfjs-dist';

let lib: Promise<typeof import('pdfjs-dist')> | null = null;

async function pdfjs() {
  lib ??= (async () => {
    const [m, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
    m.GlobalWorkerOptions.workerSrc = worker.default;
    return m;
  })();
  return lib;
}

/** Открыть PDF; close() освобождает worker и память. */
export async function openPdf(data: ArrayBuffer): Promise<{ doc: PDFDocumentProxy; close: () => Promise<void> }> {
  const m = await pdfjs();
  const task = m.getDocument({
    data: new Uint8Array(data),
    useWasm: false,
    // Ссылки и скрипты внутри PDF не исполняются: показываем только картинку страницы.
    enableXfa: false,
    cMapUrl: '/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/pdfjs/standard_fonts/',
    iccUrl: '/pdfjs/iccs/',
    wasmUrl: '/pdfjs/wasm/',
  });
  return { doc: await task.promise, close: () => task.destroy() };
}

/** Нарисовать страницу в canvas по ширине контейнера. */
export async function renderPage(doc: PDFDocumentProxy, n: number, width: number): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const ratio = window.devicePixelRatio || 1;
  const viewport = page.getViewport({ scale: (width / base.width) * ratio });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.setAttribute('aria-label', `Страница ${n}`);
  await page.render({ canvas, viewport }).promise;
  return canvas;
}
