import { describe, expect, it } from 'vitest';
import { CANVAS_MAX_PIXELS, fitWidthScale, nextZoom, renderScale, viewerKey, viewKind, ZOOM_MAX, ZOOM_MIN } from './viewer';

describe('просмотрщик: масштаб', () => {
  it('«по ширине» — во всю ширину области; шаги «+ −» по 25 % в пределах', () => {
    expect(fitWidthScale(612, 1224)).toBe(2);
    expect(fitWidthScale(0, 1000)).toBe(1);
    expect([nextZoom(1, 1), nextZoom(1, -1), nextZoom(ZOOM_MAX, 1), nextZoom(ZOOM_MIN, -1)]).toEqual([1.25, 0.75, ZOOM_MAX, ZOOM_MIN]);
  });

  it('рендер — в пикселях устройства (devicePixelRatio); canvas не больше предела, упор — clamped', () => {
    const a4 = { width: 595, height: 842 };
    expect(renderScale(a4, 1.5, 2)).toEqual({ scale: 3, clamped: false });
    const big = renderScale(a4, 4, 3);
    expect(big.clamped).toBe(true);
    expect(a4.width * a4.height * big.scale * big.scale).toBeLessThanOrEqual(CANVAS_MAX_PIXELS + 1);
    expect(renderScale(a4, 1, 0).scale).toBe(1); // нет devicePixelRatio — как 1
  });
});

describe('просмотрщик: клавиши и виды файлов', () => {
  it('← → + − Home End Esc; с Ctrl/Cmd — не наши (масштаб браузера)', () => {
    expect(['ArrowLeft', 'ArrowRight', '+', '=', '-', 'Home', 'End', 'Escape', 'a'].map((key) => viewerKey({ key })))
      .toEqual(['prev', 'next', 'zoomIn', 'zoomIn', 'zoomOut', 'first', 'last', 'close', null]);
    expect(viewerKey({ key: '+', ctrlKey: true })).toBeNull();
  });

  it('PDF, изображения, текст, .docx', () => {
    expect([
      viewKind('application/pdf'), viewKind('image/png'), viewKind('image/jpeg'), viewKind('text/csv'),
      viewKind('application/vnd.openxmlformats-officedocument.wordprocessingml.document'), viewKind('application/octet-stream', 'Перевод.DOCX'),
      viewKind('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
    ]).toEqual(['pdf', 'image', 'image', 'text', 'docx', 'docx', 'none']);
  });
});
