import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { searchApi, snippetParts, type SearchHit, type SearchKind } from '../../api/search';

const SECTIONS: { kind: SearchKind; title: string }[] = [
  { kind: 'records', title: 'Записи реестров' },
  { kind: 'files', title: 'Файлы' },
  { kind: 'evidence', title: 'Доказательства' },
  { kind: 'chains', title: 'Цепочки задач' },
];

function Snippet({ s }: { s: string }) {
  if (!s) return null;
  return <div className="m snippet">{snippetParts(s).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}</div>;
}

function Hit({ h }: { h: SearchHit }) {
  return (
    <Link className="hist-item search-hit" to={h.link}>
      <div className="row nowrap"><b className="ellipsis">{h.title}</b>{h.archived && <span className="chip">В архиве</span>}</div>
      <div className="hint">{h.context}</div>
      <Snippet s={h.snippet} />
    </Link>
  );
}

/**
 * Глобальный поиск: ФИО, имя хоста, № документа, сервис, подписант, имя файла и текст PDF (русская морфология).
 * Без раздела — первые результаты каждого; «Показать все» — один раздел с подгрузкой.
 */
export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const kind = (params.get('kind') as SearchKind | null) ?? undefined;
  const [input, setInput] = useState(q);
  useEffect(() => setInput(q), [q]);
  const query = useInfiniteQuery({
    queryKey: ['search', q, kind ?? ''],
    queryFn: ({ pageParam }) => searchApi.search(q, kind, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (kind ? last[kind].nextCursor ?? undefined : undefined),
    enabled: q.trim().length >= 2,
  });
  const first = query.data?.pages[0];
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = input.trim();
    if (v.length >= 2) setParams({ q: v });
  };
  const sections = kind ? SECTIONS.filter((s) => s.kind === kind) : SECTIONS;
  const total = first ? first.records.total + first.files.total + first.evidence.total + first.chains.total : 0;

  return (
    <>
      <div className="head">
        <div>
          <h1>Поиск</h1>
          <p>По записям всех реестров, доказательствам и файлам — ФИО, имя хоста, № документа, сервис, подписант, имя файла и текст внутри PDF.</p>
        </div>
      </div>
      <form className="panel panel-b row" onSubmit={submit} role="search">
        <input className="inp grow" type="search" autoFocus minLength={2} value={input} onChange={(e) => setInput(e.target.value)} placeholder="Например: WS-BUH-014, Telegram, 12/45-р" aria-label="Что найти" />
        <button className="btn primary" type="submit">Найти</button>
      </form>
      {q.length > 0 && q.length < 2 && <div className="panel panel-b hint">Введите хотя бы 2 символа</div>}
      {query.isPending && q.length >= 2 && <div className="panel panel-b hint">Ищем…</div>}
      {query.isError && <div className="panel panel-b form-error">{query.error.message}</div>}
      {first && (
        <>
          {(first.noTextFiles > 0 || first.pendingFiles > 0) && (
            <div className="panel panel-b note" data-testid="no-text-files">
              {first.noTextFiles > 0 && <>Файлов без текстового слоя (сканы): <b>{first.noTextFiles}</b> — по ним поиск только по полям записи и имени файла. </>}
              {first.pendingFiles > 0 && <>Текст ещё извлекается: {first.pendingFiles}.</>}
            </div>
          )}
          {!kind && total === 0 && <div className="panel panel-b hint">Ничего не найдено</div>}
          {kind && <div className="panel-b"><button className="btn sm" type="button" onClick={() => setParams({ q })}>← Все разделы</button></div>}
          {sections.map((s) => {
            const items = query.data?.pages.flatMap((p) => p[s.kind].items) ?? [];
            const n = first[s.kind].total;
            if (!n) return kind ? <div key={s.kind} className="panel panel-b hint">Ничего не найдено</div> : null;
            return (
              <section key={s.kind} className="panel" aria-label={s.title}>
                <div className="panel-h">
                  <h3>{s.title}</h3>
                  <span className="sub mono">{n}</span>
                </div>
                <div className="panel-b hist">
                  {items.map((h) => <Hit key={`${h.kind}:${h.id}`} h={h} />)}
                  {!kind && n > items.length && <button className="btn sm" type="button" onClick={() => setParams({ q, kind: s.kind })}>Показать все ({n})</button>}
                  {kind && query.hasNextPage && <button className="btn sm" type="button" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>Показать ещё</button>}
                </div>
              </section>
            );
          })}
        </>
      )}
    </>
  );
}
