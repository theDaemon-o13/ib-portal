// «Предпросмотр как в почте» (1.12.0; docs/specs/awareness.md, раздел 23): iframe с sandbox без скриптов — ровно тот
// HTML, что уйдёт в .eml (изображения data: вместо cid:). Ширина «Компьютер 600 / Телефон 375», языки.
// Документ отдаёт backend со своим CSP (стили письма inline, без скриптов): srcdoc и blob: унаследовали бы CSP
// страницы портала (style-src 'self'), и письмо показалось бы без оформления.
import { useEffect, useState } from 'react';
import type { ExportLang } from '../../api/awareness';

const LANG_NAME: Record<ExportLang, string> = { both: 'RU + TJ', ru: 'RU', tj: 'TJ' };
const WIDTHS = [
  { key: 'desktop', label: 'Компьютер', px: 680 },
  { key: 'phone', label: 'Телефон', px: 375 },
] as const;

export interface MailPreviewProps {
  langs: readonly ExportLang[];
  /** Тема и адрес документа предпросмотра для языка (запрос к backend). */
  load: (lang: ExportLang) => Promise<{ subject: string; src: string; warnings?: string[] }>;
  /** Смена ключа — перезагрузить (сохранили письмо, сменили версию, изменили текст). */
  reloadKey?: string;
}

export function MailPreview({ langs, load, reloadKey }: MailPreviewProps) {
  const [lang, setLang] = useState<ExportLang>(langs.includes('both') ? 'both' : langs[0] ?? 'ru');
  const [width, setWidth] = useState<(typeof WIDTHS)[number]['key']>('desktop');
  const [state, setState] = useState<{ subject: string; src: string; warnings?: string[] } | { error: string } | null>(null);

  useEffect(() => {
    if (!langs.includes(lang)) setLang(langs.includes('both') ? 'both' : langs[0] ?? 'ru');
  }, [langs, lang]);

  useEffect(() => {
    if (!langs.includes(lang)) return undefined;
    let alive = true;
    setState(null);
    load(lang).then(
      (r) => { if (alive) setState(r); },
      (err: unknown) => { if (alive) setState({ error: err instanceof Error ? err.message : 'Не удалось построить предпросмотр' }); },
    );
    return () => { alive = false; };
    // load меняется на каждом рендере родителя — перезапрос по языку и ключу.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, reloadKey]);

  if (!langs.length) return <div className="hint">Письмо пустое — показывать нечего. Заполните тему и текст.</div>;
  const px = WIDTHS.find((w) => w.key === width)?.px ?? 680;
  return (
    <div className="aw-mail-preview" data-testid="mail-preview">
      <div className="row aw-export-opts">
        <div className="filters" role="group" aria-label="Языки предпросмотра">
          {langs.map((l) => <button key={l} type="button" aria-pressed={lang === l} onClick={() => setLang(l)}>{LANG_NAME[l]}</button>)}
        </div>
        <div className="filters" role="group" aria-label="Ширина предпросмотра">
          {WIDTHS.map((w) => <button key={w.key} type="button" aria-pressed={width === w.key} onClick={() => setWidth(w.key)}>{w.label}</button>)}
        </div>
      </div>
      {state === null && <div className="hint" role="status">Строим предпросмотр…</div>}
      {state && 'error' in state && <div className="note conflict" role="alert">{state.error}</div>}
      {state && 'src' in state && (
        <>
          {state.warnings?.map((w) => <div key={w} className="note aw-warn" role="status">{w}</div>)}
          <div className="w600 aw-mail-subject" data-testid="mail-preview-subject">Тема: {state.subject || <span className="muted">без темы</span>}</div>
          <div className="aw-mail-frame-wrap">
            <iframe title="Предпросмотр письма как в почте" className="aw-mail-frame" sandbox="" src={state.src} style={{ width: px }} />
          </div>
        </>
      )}
    </div>
  );
}
