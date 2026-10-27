import { useQuery } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import type { Me } from '../../api/client';
import { docsApi, dkeys, type DocItem, type DocQuery, type DocStatus } from '../../api/documents';
import { formatDate } from '../registers/logic';
import { DocumentPanel } from './DocumentPanel';
import { reviewLabel, STATUS_TONE, stageHint, versionLabel } from './logic';
import { NewDocumentDrawer } from './NewDocumentDrawer';

const STATUS_FILTERS: { key: DocStatus; title: string }[] = [
  { key: 'draft', title: 'Черновики' },
  { key: 'in_approval', title: 'На согласовании' },
  { key: 'approved', title: 'Утверждены' },
  { key: 'in_review', title: 'На пересмотре' },
  { key: 'review_overdue', title: 'Пересмотр просрочен' },
];

/** Точки маршрута в строке реестра: пройденные этапы — зелёные, текущий — синий. */
function RouteDots({ d }: { d: DocItem }) {
  if (d.stage === null) return null;
  const stage = d.stage;
  return (
    <span className="route" aria-label={`Этап ${stage + 1} из 4`}>
      {[0, 1, 2, 3].map((i) => (
        <span key={i} className="route-i">
          {i > 0 && <span className={`link${i <= stage ? ' done' : ''}`} />}
          <span className={`step${i < stage ? ' done' : i === stage ? ' cur' : ''}`} />
        </span>
      ))}
    </span>
  );
}

export function DocumentsPage() {
  const me = useOutletContext<Me>();
  const [params, setParams] = useSearchParams();
  const ibWork = me.permissions.includes('ib.work');
  const canManage = me.permissions.includes('docs.manage');
  const filter = params.get('filter') ?? '';
  const archived = filter === 'archive';
  const [search, setSearch] = useState('');
  const [newOpen, setNewOpen] = useState(false);

  const query: DocQuery = {
    archived,
    waiting: filter === 'waiting',
    review: filter === 'review',
    status: STATUS_FILTERS.some((s) => s.key === filter) ? (filter as DocStatus) : undefined,
    q: search,
  };
  const docs = useQuery({ queryKey: dkeys.list(query), queryFn: () => docsApi.list(query) });
  const summary = useQuery({ queryKey: dkeys.summary, queryFn: docsApi.summary });
  const items = docs.data?.items ?? [];
  const selected = params.get('doc') ?? items[0]?.id ?? null;

  const setParam = useCallback((patch: Record<string, string | null>) => {
    setParams((p) => {
      const n = new URLSearchParams(p);
      for (const [k, v] of Object.entries(patch)) if (v === null) n.delete(k); else n.set(k, v);
      return n;
    }, { replace: true });
  }, [setParams]);
  const select = (id: string | null) => setParam({ doc: id });

  return (
    <>
      <div className="head">
        <div>
          <h1>Внутренние документы ИБ</h1>
          <p>
            {ibWork
              ? 'Реестр нормативных документов отдела. Файлы остаются в OnlyOffice, здесь ведутся маршрут согласования и контроль сроков пересмотра. Каждый этап согласует пользователь с правом этого этапа.'
              : 'Документы, которые ждут вашего согласования, и утверждённые документы отдела ИБ. Файлы открываются в OnlyOffice.'}
          </p>
        </div>
        {canManage && (
          <div className="row">
            <button className="btn primary" type="button" onClick={() => setNewOpen(true)}>Новый документ</button>
          </div>
        )}
      </div>

      <div className="row docs-bar">
        <div className="filters" role="group" aria-label="Фильтр документов">
          <button type="button" aria-pressed={!filter} onClick={() => setParam({ filter: null, doc: null })}>Все</button>
          <button type="button" aria-pressed={filter === 'waiting'} onClick={() => setParam({ filter: 'waiting', doc: null })}>
            Ждут вас <span className="mono">{summary.data?.waitingForMe ?? 0}</span>
          </button>
          {ibWork && (
            <button type="button" aria-pressed={filter === 'review'} title="Пересмотр просрочен или идёт, либо дата пересмотра в ближайшие 30 дней" onClick={() => setParam({ filter: 'review', doc: null })}>
              К пересмотру
            </button>
          )}
          {ibWork && STATUS_FILTERS.map((s) => (
            <button key={s.key} type="button" aria-pressed={filter === s.key} onClick={() => setParam({ filter: s.key, doc: null })}>
              {s.title}{s.key === 'review_overdue' && <> <span className="mono">{summary.data?.reviewOverdue ?? 0}</span></>}
            </button>
          ))}
          {ibWork && (
            <button type="button" className="arch-btn" aria-pressed={archived} onClick={() => setParam({ filter: archived ? null : 'archive', doc: null })}>
              Архив <span className="mono">{docs.data?.archivedTotal ?? 0}</span>
            </button>
          )}
        </div>
        <input className="inp docs-search" type="search" placeholder="Поиск по названию" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Поиск по названию" />
      </div>

      {docs.isError && <div className="form-error">{docs.error.message}</div>}
      <div className="dash">
        <section className="panel w8">
          <div className="tbl-wrap">
            <table className="docs-tbl">
              <thead>
                <tr><th>Документ</th><th>Владелец</th><th>Версия</th><th>Утверждён</th><th>Пересмотр до</th><th>Согласование</th><th>Статус</th></tr>
              </thead>
              <tbody>
                {items.map((d) => (
                  <tr key={d.id} data-doc={d.id} className={d.id === selected ? 'sel' : undefined} tabIndex={0} aria-selected={d.id === selected}
                    onClick={() => select(d.id)} onKeyDown={(e) => { if (e.key === 'Enter') select(d.id); }}>
                    <td><div className="w500">{d.title}</div><div className="hint">{d.type.value}</div></td>
                    <td>{d.owner.fullName}</td>
                    <td className="mono">{versionLabel({ no: d.versionNo, edition: d.edition })}</td>
                    <td className="mono">{d.approvedAt ? formatDate(d.approvedAt.slice(0, 10)) : '—'}</td>
                    <td className={`mono${d.status === 'review_overdue' ? ' late-t' : ''}`}>{reviewLabel(d)}</td>
                    <td>
                      <RouteDots d={d} />
                      {stageHint(d) && <div className={`hint${d.waitingForMe ? ' tone-accent w600' : ''}`}>{stageHint(d)}</div>}
                    </td>
                    <td><span className={`chip ${STATUS_TONE[d.status]}`}>{d.statusName}</span></td>
                  </tr>
                ))}
                {docs.isSuccess && items.length === 0 && (
                  <tr><td colSpan={7} className="hint">
                    {filter === 'waiting' ? 'Сейчас ничего не ждёт вашего согласования' : search ? 'Ничего не найдено' : 'Документов пока нет'}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
        <section className="panel w4">
          {selected
            ? <DocumentPanel key={selected} id={selected} onGone={() => select(null)} />
            : <div className="panel-b hint">Выберите документ в реестре</div>}
        </section>
      </div>
      {newOpen && <NewDocumentDrawer meId={me.id} onClose={() => setNewOpen(false)} onCreated={(id) => { setNewOpen(false); setParam({ filter: null, doc: id }); }} />}
    </>
  );
}
