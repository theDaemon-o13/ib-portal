// Страница печати учебного письма (1.9.0; docs/specs/awareness.md, раздел 16): без оболочки портала, со входом.
// PDF — через печать браузера («Сохранить как PDF»). Каждое открытие — экспорт «печать» в журнале (решение 12.0, п. 2).
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { awarenessApi, type ExportLang } from '../../api/awareness';

const LANGS: readonly ExportLang[] = ['ru', 'tj', 'both'];

export function LetterPrintPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const lang = (LANGS as readonly string[]).includes(params.get('lang') ?? '') ? (params.get('lang') as ExportLang) : 'ru';
  const version = Number(params.get('version')) || undefined;
  const q = useQuery({ queryKey: ['awareness', 'print', id, lang, version], queryFn: () => awarenessApi.exportPrint(id, lang, version), retry: false, staleTime: Infinity });

  useEffect(() => {
    document.documentElement.classList.add('aw-print-root');
    return () => document.documentElement.classList.remove('aw-print-root');
  }, []);
  useEffect(() => {
    if (!q.data) return;
    document.title = `Письмо № ${q.data.number} — ${q.data.title}`;
    // Дать картинкам загрузиться (они data:, но декодируются асинхронно), затем диалог печати.
    const t = setTimeout(() => window.print(), 400);
    return () => clearTimeout(t);
  }, [q.data]);

  if (q.isError) return <main className="aw-print"><p className="form-error">{q.error.message}</p></main>;
  if (!q.data) return <main className="aw-print"><p className="hint">Готовим письмо к печати…</p></main>;
  return (
    <main className="aw-print" data-testid="letter-print">
      <div className="aw-print-bar no-print">
        <button className="btn primary" type="button" onClick={() => window.print()}>Печать / сохранить в PDF</button>
        <button className="btn" type="button" onClick={() => window.close()}>Закрыть</button>
      </div>
      {q.data.parts.map((p, i) => (
        <article key={p.lang} className="aw-print-part">
          {i > 0 && <hr className="aw-print-sep" />}
          <h1 className="aw-print-subject">{p.subject}</h1>
          {/* HTML прошёл санитайзер на backend, подпись подставлена; CSP запрещает скрипты. */}
          <div className="aw-print-body" dangerouslySetInnerHTML={{ __html: p.html }} />
        </article>
      ))}
    </main>
  );
}
