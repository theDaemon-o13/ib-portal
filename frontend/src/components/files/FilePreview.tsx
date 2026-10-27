import { useEffect, useRef, useState } from 'react';
import { filesApi, formatSize, previewKind } from '../../api/files';
import { useToast } from '../Toast';
import { openPdf, renderPage } from './pdf';

export interface PreviewFile {
  id: string;
  name: string;
  mime: string;
  size?: number;
}

const MAX_PAGES = 10;
const MAX_TEXT = 200_000;

/** UTF-8 или, если не читается, Windows-1251 — как сохраняет CSV Excel на русской Windows. */
function decode(buf: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1251').decode(buf);
  }
}

/** CSV — таблицей (разделитель «;» или «,»), до 200 строк; остальное — текстом. */
function csvRows(text: string): string[][] | null {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.length > 0).slice(0, 200);
  if (!lines.length) return null;
  const sep = (lines[0]?.split(';').length ?? 0) >= (lines[0]?.split(',').length ?? 0) ? ';' : ',';
  return lines.map((l) => l.split(sep));
}

/**
 * Просмотр файла в карточке: изображения, PDF (pdf.js из сборки), текст и CSV. Остальное — только сохранить.
 * Содержимое берётся через fetch (blob): ответ backend всегда attachment, в окне браузера он не открывается.
 */
export function FilePreview({ file }: { file: PreviewFile }) {
  const box = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const kind = previewKind(file.mime);
  const [state, setState] = useState<{ img?: string; text?: string; csv?: string[][] | null; pages?: number; error?: string; loading: boolean }>({ loading: kind !== 'none' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (kind === 'none') return;
    let alive = true;
    let url: string | null = null;
    setState({ loading: true });
    (async () => {
      const blob = await filesApi.content(file.id);
      if (!alive) return;
      if (kind === 'image') {
        url = URL.createObjectURL(blob);
        setState({ img: url, loading: false });
        return;
      }
      if (kind === 'text') {
        const text = decode(await blob.slice(0, MAX_TEXT).arrayBuffer());
        if (!alive) return;
        setState({ text, csv: file.mime === 'text/csv' ? csvRows(text) : null, loading: false });
        return;
      }
      const { doc, close } = await openPdf(await blob.arrayBuffer());
      const host = box.current;
      if (!alive || !host) {
        void close();
        return;
      }
      host.replaceChildren();
      const width = Math.max(240, host.clientWidth - 2);
      for (let i = 1; i <= Math.min(doc.numPages, MAX_PAGES); i++) {
        const canvas = await renderPage(doc, i, width);
        if (!alive) return;
        host.appendChild(canvas);
      }
      setState({ pages: doc.numPages, loading: false });
      void close();
    })().catch((e: unknown) => {
      if (alive) setState({ loading: false, error: e instanceof Error ? e.message : String(e) });
    });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file.id, file.mime, kind]);

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

  return (
    <div>
      <div className="ev-prev" data-preview={kind} aria-busy={state.loading}>
        {state.loading && kind !== 'pdf' && <div className="hint">Загрузка предпросмотра…</div>}
        {state.error && <div className="hint">Не удалось показать файл ({state.error}). Сохраните его и откройте на компьютере.</div>}
        {kind === 'none' && <div className="hint">Предпросмотр для этого типа файла недоступен. Сохраните файл, чтобы открыть его в программе на компьютере.</div>}
        {state.img && <img src={state.img} alt={file.name} />}
        {state.csv ? (
          <div className="tbl-wrap">
            <table className="csv-tbl">
              <tbody>{state.csv.map((r, i) => <tr key={i}>{r.map((c, j) => (i === 0 ? <th key={j}>{c}</th> : <td key={j}>{c}</td>))}</tr>)}</tbody>
            </table>
          </div>
        ) : state.text !== undefined && <pre>{state.text}</pre>}
        {kind === 'pdf' && state.loading && <div className="hint">Загрузка PDF…</div>}
        {/* Страницы pdf.js добавляет сам: React этот контейнер не наполняет. */}
        {kind === 'pdf' && <div ref={box} className="pdf-pages" />}
        {state.pages !== undefined && state.pages > MAX_PAGES && (
          <div className="hint">Показаны первые {MAX_PAGES} из {state.pages} страниц. Сохраните файл, чтобы открыть весь документ.</div>
        )}
      </div>
      <div className="row mt6">
        <button className="btn sm" type="button" disabled={saving} onClick={() => void save()}>Сохранить файл</button>
        <span className="hint">{file.name}{file.size !== undefined ? ` · ${formatSize(file.size)}` : ''}</span>
      </div>
    </div>
  );
}
