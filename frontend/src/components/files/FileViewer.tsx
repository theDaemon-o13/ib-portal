// Просмотр файла на весь экран (релиз 1.4.0, шаг 8): PDF (pdf.js из сборки), изображения, текст; .docx — сообщение.
// Содержимое — только через backend (filesApi.content: проверка прав, Content-Disposition); прямых ссылок нет.
// Окно появляется, когда файл получен: нет доступа (403/404) — окна нет, сообщение. Пока файл грузится — индикатор.
// PDF: на экране одна страница, рендерится только она (соседняя запрашивается заранее), в пикселях устройства
// (devicePixelRatio) и не больше предела canvas; при смене страницы незавершённый рендер отменяется, при закрытии —
// страница и документ освобождаются, canvas обнуляется. Esc закрывает только просмотрщик; фокус — на кнопку-открывателя.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { ApiError } from '../../api/client';
import { filesApi } from '../../api/files';
import { Overlay } from '../Overlay';
import { useToast } from '../Toast';
import { openPdf } from './pdf';
import { DOCX_MESSAGE, fitWidthScale, nextZoom, renderScale, viewerKey, viewKind } from './viewer';

export interface ViewerFile { id: string; name: string; mime: string }
export interface ViewerOptions {
  /** Ссылка OnlyOffice — только у версии документа; у ответов и переводов .docx — только «Скачать». */
  onlyofficeUrl?: string | null;
}

type Loaded =
  | { kind: 'pdf'; doc: PDFDocumentProxy; close: () => Promise<void> }
  | { kind: 'image'; url: string }
  | { kind: 'text'; text: string }
  | { kind: 'docx' | 'none' };

const MAX_TEXT = 200_000;

/** Открыть просмотр: вернёт окно (или индикатор загрузки) для вставки в разметку и функцию open. */
export function useFileViewer() {
  const toast = useToast();
  const [state, setState] = useState<{ file: ViewerFile; opts: ViewerOptions; loaded: Loaded | null } | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const seq = useRef(0);

  const close = useCallback(() => {
    setState((s) => {
      if (s?.loaded?.kind === 'pdf') void s.loaded.close();
      if (s?.loaded?.kind === 'image') URL.revokeObjectURL(s.loaded.url);
      return null;
    });
    seq.current++;
    // Фокус — туда, откуда открыли (после того как окно ушло из DOM).
    const el = opener.current;
    opener.current = null;
    setTimeout(() => el?.focus(), 0);
  }, []);

  const open = useCallback(async (file: ViewerFile, opts: ViewerOptions = {}) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const my = ++seq.current;
    const kind = viewKind(file.mime, file.name);
    setState({ file, opts, loaded: null });
    try {
      let loaded: Loaded;
      if (kind === 'docx' || kind === 'none') {
        loaded = { kind };
      } else {
        const blob = await filesApi.content(file.id);
        if (kind === 'pdf') {
          const pdf = await openPdf(await blob.arrayBuffer());
          if (my !== seq.current) { void pdf.close(); return; }
          loaded = { kind: 'pdf', doc: pdf.doc, close: pdf.close };
        } else if (kind === 'image') {
          loaded = { kind: 'image', url: URL.createObjectURL(blob) };
        } else {
          loaded = { kind: 'text', text: new TextDecoder().decode(await blob.slice(0, MAX_TEXT).arrayBuffer()) };
        }
      }
      if (my !== seq.current) { if (loaded.kind === 'image') URL.revokeObjectURL(loaded.url); return; }
      setState({ file, opts, loaded });
    } catch (e) {
      if (my !== seq.current) return;
      // Нет доступа или файла (403/404) — окно не открывается.
      setState(null);
      const el = opener.current;
      opener.current = null;
      el?.focus();
      toast(e instanceof ApiError && (e.status === 403 || e.status === 404) ? 'Файл недоступен' : 'Не удалось открыть файл', 'error');
    }
  }, [toast]);

  // Закрытие страницы карточки — освободить документ.
  useEffect(() => () => { seq.current++; }, []);

  const element: ReactNode = state && (
    state.loaded
      ? <FileViewer file={state.file} opts={state.opts} loaded={state.loaded} onClose={close} />
      : (
        <Overlay>
          <div className="viewer-loading" role="status" aria-live="polite" data-testid="viewer-loading">Загрузка файла «{state.file.name}»…</div>
        </Overlay>
      )
  );
  return { open, close, element, isOpen: !!state?.loaded };
}

function FileViewer({ file, opts, loaded, onClose }: { file: ViewerFile; opts: ViewerOptions; loaded: Loaded; onClose: () => void }) {
  const toast = useToast();
  const box = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(0);
  const [rendering, setRendering] = useState(loaded.kind === 'pdf');
  const [clamped, setClamped] = useState(false);
  const [saving, setSaving] = useState(false);
  const pages = loaded.kind === 'pdf' ? loaded.doc.numPages : 1;

  // Клавиши — в фазе перехвата на window: Esc и стрелки не доходят до окон под просмотрщиком.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = viewerKey(e);
      if (!k) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (k === 'close') onClose();
      else if (k === 'prev') setPage((p) => Math.max(1, p - 1));
      else if (k === 'next') setPage((p) => Math.min(pages, p + 1));
      else if (k === 'first') setPage(1);
      else if (k === 'last') setPage(pages);
      else if (k === 'zoomIn') setZoom((z) => nextZoom(z, 1));
      else setZoom((z) => nextZoom(z, -1));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, pages]);

  useEffect(() => { dialog.current?.focus(); }, []);
  // Страница под просмотрщиком не прокручивается, место под её полосу (scrollbar-gutter в base.css) не резервируется:
  // иначе на компьютере с постоянными полосами прокрутки справа остаётся пустая полоса и просмотрщик не на весь экран.
  useLayoutEffect(() => {
    const { style } = document.documentElement;
    const was = [style.overflow, style.scrollbarGutter] as const;
    style.overflow = 'hidden';
    style.scrollbarGutter = 'auto';
    return () => { [style.overflow, style.scrollbarGutter] = was; };
  }, []);

  // Ширина области просмотра — для «по ширине».
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(0, el.clientWidth - 32)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // PDF: рендер только текущей страницы; соседняя запрашивается заранее; незавершённый рендер отменяется.
  useEffect(() => {
    if (loaded.kind !== 'pdf' || !width || !box.current) return;
    let alive = true;
    let task: RenderTask | null = null;
    const canvas = box.current.querySelector('canvas');
    setRendering(true);
    void (async () => {
      const p = await loaded.doc.getPage(page);
      if (!alive || !canvas) { p.cleanup(); return; }
      const base = p.getViewport({ scale: 1 });
      const dpr = window.devicePixelRatio || 1;
      const css = fitWidthScale(base.width, width) * zoom;
      const r = renderScale(base, css, dpr);
      const vp = p.getViewport({ scale: r.scale });
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      canvas.style.width = `${Math.floor(vp.width / dpr)}px`;
      canvas.style.height = `${Math.floor(vp.height / dpr)}px`;
      task = p.render({ canvas, viewport: vp });
      try {
        await task.promise;
      } catch {
        // Отменён сменой страницы или масштаба — это нормально.
      }
      p.cleanup();
      if (!alive) return;
      setClamped(r.clamped);
      setRendering(false);
      if (page < pages) void loaded.doc.getPage(page + 1).catch(() => undefined);
    })().catch(() => {
      if (alive) { setRendering(false); toast('Не удалось показать страницу PDF', 'error'); }
    });
    return () => {
      alive = false;
      task?.cancel();
    };
  }, [loaded, page, zoom, width, pages, toast]);

  // Закрытие: canvas обнуляется (память видеокарты), документ освобождает onClose.
  useEffect(() => () => {
    const c = box.current?.querySelector('canvas');
    if (c) { c.width = 0; c.height = 0; }
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await filesApi.save(file.id, file.name);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Не удалось сохранить файл', 'error');
    } finally {
      setSaving(false);
    }
  };

  const isPdf = loaded.kind === 'pdf';
  const zoomable = isPdf || loaded.kind === 'image';
  return (
    <Overlay>
      <div className="viewer" role="dialog" aria-modal="true" aria-label={`Просмотр: ${file.name}`} tabIndex={-1} ref={dialog} data-testid="file-viewer">
        <div className="viewer-bar">
          <b className="viewer-name" title={file.name}>{file.name}</b>
          {isPdf && (
            <span className="row nowrap">
              <button type="button" className="btn ghost sm" aria-label="Предыдущая страница" disabled={page <= 1} onClick={() => setPage(page - 1)}>←</button>
              <span className="mono" data-testid="viewer-page">{page} / {pages}</span>
              <button type="button" className="btn ghost sm" aria-label="Следующая страница" disabled={page >= pages} onClick={() => setPage(page + 1)}>→</button>
            </span>
          )}
          {zoomable && (
            <span className="row nowrap">
              <button type="button" className="btn ghost sm" aria-label="Уменьшить" onClick={() => setZoom(nextZoom(zoom, -1))}>−</button>
              <button type="button" className="btn ghost sm" onClick={() => setZoom(1)} title="Подогнать по ширине" data-testid="viewer-zoom">{Math.round(zoom * 100)} %</button>
              <button type="button" className="btn ghost sm" aria-label="Увеличить" disabled={clamped} onClick={() => setZoom(nextZoom(zoom, 1))}>+</button>
            </span>
          )}
          <span className="grow" />
          <button type="button" className="btn sm" disabled={saving} onClick={() => void save()}>Скачать</button>
          {loaded.kind === 'docx' && opts.onlyofficeUrl && <a className="btn sm" href={opts.onlyofficeUrl} target="_blank" rel="noopener noreferrer">Открыть в OnlyOffice</a>}
          <button type="button" className="btn sm" onClick={onClose}>Закрыть</button>
        </div>
        <div className="viewer-body" ref={box}>
          {isPdf && (
            <>
              {rendering && <div className="viewer-wait hint" role="status">Загрузка страницы…</div>}
              <canvas aria-label={`Страница ${page} из ${pages}`} className={rendering ? 'is-rendering' : undefined} />
              {clamped && <div className="hint viewer-note">Максимальное увеличение для этой страницы</div>}
            </>
          )}
          {loaded.kind === 'image' && <img src={loaded.url} alt={file.name} style={width ? { width: `${Math.round(width * zoom)}px` } : undefined} />}
          {loaded.kind === 'text' && <pre className="viewer-text">{loaded.text}</pre>}
          {loaded.kind === 'docx' && (
            <div className="viewer-msg" data-testid="viewer-docx">
              <p>{DOCX_MESSAGE}</p>
              <div className="row">
                <button type="button" className="btn primary" disabled={saving} onClick={() => void save()}>Скачать</button>
                {opts.onlyofficeUrl && <a className="btn" href={opts.onlyofficeUrl} target="_blank" rel="noopener noreferrer">Открыть в OnlyOffice</a>}
              </div>
            </div>
          )}
          {loaded.kind === 'none' && <div className="viewer-msg"><p>Просмотр этого типа файла в портале недоступен. Скачайте файл.</p></div>}
        </div>
      </div>
    </Overlay>
  );
}
