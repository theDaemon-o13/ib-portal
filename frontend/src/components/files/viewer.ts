// Просмотрщик файлов (релиз 1.4.0, шаг 8): чистые функции без React и pdf.js — проверяются юнит-тестами.

/** Шаг увеличения: «+» и «−» меняют масштаб на 25 % от «по ширине». */
export const ZOOM_STEP = 0.25;
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;
/**
 * Предел canvas в пикселях устройства. Больше — Chrome не создаёт canvas (пустая страница) или вкладка тяжелеет;
 * ~16 Мп хватает на A4 при увеличении 400 % на обычном экране и при 200 % на Retina.
 */
export const CANVAS_MAX_PIXELS = 16_777_216;

/** Масштаб «по ширине»: страница шириной pageWidth (pt при scale 1) во всю ширину области просмотра. */
export function fitWidthScale(pageWidth: number, viewportWidth: number): number {
  if (pageWidth <= 0 || viewportWidth <= 0) return 1;
  return viewportWidth / pageWidth;
}

/** Следующий уровень увеличения (относительно «по ширине» = 1). */
export function nextZoom(zoom: number, dir: 1 | -1): number {
  const z = Math.round((zoom + dir * ZOOM_STEP) * 100) / 100;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

/**
 * Масштаб рендера страницы в пикселях устройства с учётом devicePixelRatio и предела canvas.
 * clamped — упёрлись в предел: показываем «максимальное увеличение».
 */
export function renderScale(page: { width: number; height: number }, cssScale: number, dpr: number): { scale: number; clamped: boolean } {
  const want = cssScale * (dpr > 0 ? dpr : 1);
  const pixels = page.width * page.height * want * want;
  if (pixels <= CANVAS_MAX_PIXELS) return { scale: want, clamped: false };
  return { scale: Math.sqrt(CANVAS_MAX_PIXELS / (page.width * page.height)), clamped: true };
}

export type ViewerKey = 'prev' | 'next' | 'zoomIn' | 'zoomOut' | 'first' | 'last' | 'close';

/** Клавиши окна: ← →, + − (и = без Shift), Home/End, Esc. */
export function viewerKey(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): ViewerKey | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  switch (e.key) {
    case 'ArrowLeft': case 'PageUp': return 'prev';
    case 'ArrowRight': case 'PageDown': return 'next';
    case '+': case '=': return 'zoomIn';
    case '-': case '_': return 'zoomOut';
    case 'Home': return 'first';
    case 'End': return 'last';
    case 'Escape': return 'close';
    default: return null;
  }
}

/** Что показывать: PDF, изображение, текст, .docx (сообщение и кнопки) или «нет просмотра». */
export type ViewKind = 'pdf' | 'image' | 'text' | 'docx' | 'none';

export function viewKind(mime: string, name = ''): ViewKind {
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'image/png' || mime === 'image/jpeg') return 'image';
  if (mime === 'text/plain' || mime === 'text/csv') return 'text';
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || /\.docx$/i.test(name)) return 'docx';
  return 'none';
}

export const DOCX_MESSAGE = 'Для просмотра в портале приложите PDF; .docx открывается в OnlyOffice';
