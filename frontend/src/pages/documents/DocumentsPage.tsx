import { useQuery } from '@tanstack/react-query';
import { Fragment, useCallback, useState } from 'react';
import { NavLink, useOutletContext, useParams, useSearchParams } from 'react-router-dom';
import type { Me } from '../../api/client';
import { docsApi, dkeys, type DocItem, type DocQuery, type DocSort, type DocStatus, type DocView } from '../../api/documents';
import { useToast } from '../../components/Toast';
import { ChipScroller } from '../../components/ChipScroller';
import { DETAIL_NARROW_QUERY, DetailPanel, useMediaQuery } from '../../components/DetailPanel';
import { formatDate } from '../registers/logic';
import { todayLocal } from '../tasks/logic';
import { DocumentPanel } from './DocumentPanel';
import { HoldersLine } from './Holders';
import { DUE_FILTERS, groupByType, isDocDue, parseSort, reviewLabel, SORTS, STATUS_TONE, stageHint, versionLabel } from './logic';
import { NewDocumentDrawer } from './NewDocumentDrawer';

const STATUS_FILTERS: { key: DocStatus; title: string }[] = [
  { key: 'draft', title: 'Черновики' },
  { key: 'in_approval', title: 'На согласовании' },
  { key: 'approved', title: 'Утверждены' },
  { key: 'in_review', title: 'На пересмотре' },
  { key: 'review_overdue', title: 'Пересмотр просрочен' },
];

/** Выбранный порядок реестра запоминается в браузере. */
const SORT_KEY = 'docs.sort';
function loadSort(): DocSort {
  try {
    return parseSort(window.localStorage.getItem(SORT_KEY));
  } catch {
    return 'type';
  }
}
function saveSort(sort: DocSort) {
  try {
    window.localStorage.setItem(SORT_KEY, sort);
  } catch {
    // хранилище недоступно — выбор просто не запомнится
  }
}

/** Этапы маршрута 1.11.0 (ADR-0042): 21 «Драфт» … 24 «Утверждение». */
const ROUTE_STAGES = [21, 22, 23, 24];
const STAGE_FILTERS: { stage: number; title: string }[] = [
  { stage: 21, title: 'Драфт' }, { stage: 22, title: 'Согласование' }, { stage: 23, title: 'Перевод' }, { stage: 24, title: 'Утверждение' },
];
/** Подменю раздела (1.11.0): все документы, «В работе», «Утверждённые». */
const VIEWS: { key: DocView | null; path: string; title: string }[] = [
  { key: null, path: '/documents', title: 'Все документы' },
  { key: 'work', path: '/documents/work', title: 'В работе' },
  { key: 'approved', path: '/documents/approved', title: 'Утверждённые' },
];
const daysTo = (iso: string, today: string) => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);

/** Точки маршрута в строке реестра: пройденные этапы — зелёные, текущий — синий. */
function RouteDots({ d }: { d: DocItem }) {
  if (d.stage === null || !ROUTE_STAGES.includes(d.stage)) return null;
  const stage = d.stage;
  return (
    <span className="route" aria-label={`Этап ${ROUTE_STAGES.indexOf(stage) + 1} из ${ROUTE_STAGES.length}: ${d.stageName ?? ''}`}>
      {ROUTE_STAGES.map((s, i) => (
        <span key={s} className="route-i">
          {i > 0 && <span className={`link${s <= stage ? ' done' : ''}`} />}
          <span className={`step${s < stage ? ' done' : s === stage ? ' cur' : ''}`} />
        </span>
      ))}
    </span>
  );
}

export function DocumentsPage() {
  const me = useOutletContext<Me>();
  const [params, setParams] = useSearchParams();
  const { view: viewParam } = useParams();
  const view: DocView | null = viewParam === 'work' || viewParam === 'approved' ? viewParam : null;
  const toast = useToast();
  const [exporting, setExporting] = useState(false);
  const ibWork = me.permissions.includes('ib.work');
  const canManage = me.permissions.includes('docs.manage');
  const filter = params.get('filter') ?? '';
  const archived = filter === 'archive';
  const [search, setSearch] = useState('');
  const [newOpen, setNewOpen] = useState(false);
  const [sort, setSortState] = useState<DocSort>(loadSort);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const typeId = params.get('type') ?? undefined;
  const ownerId = params.get('owner') ?? undefined;
  const dueParam = params.get('due');
  const due = isDocDue(dueParam) ? dueParam : undefined;
  const dueTo = /^\d{4}-\d{2}-\d{2}$/.test(params.get('dueTo') ?? '') ? (params.get('dueTo') ?? undefined) : undefined;
  // «До даты» выбран, но дата ещё не введена — поле видно, фильтр не действует.
  const dueMode = due ?? (dueParam === 'to' || dueTo ? 'to' : '');
  const narrowed = !!(typeId || ownerId || due || dueTo);

  const stageParam = Number(params.get('stage'));
  const stage = view === 'work' && STAGE_FILTERS.some((f) => f.stage === stageParam) ? stageParam : undefined;
  const query: DocQuery = {
    archived: archived && !view,
    waiting: filter === 'waiting',
    review: filter === 'review' && !view,
    status: STATUS_FILTERS.some((s) => s.key === filter) ? (filter as DocStatus) : undefined,
    view: view ?? undefined,
    stage,
    onReview: view === 'approved' && filter === 'on_review',
    q: search,
    typeId,
    ownerId,
    due,
    dueTo: dueMode === 'to' ? dueTo : undefined,
    sort,
  };
  const docs = useQuery({ queryKey: dkeys.list(query), queryFn: () => docsApi.list(query) });
  const summary = useQuery({ queryKey: dkeys.summary, queryFn: docsApi.summary });
  const items = docs.data?.items ?? [];
  const facets = docs.data?.facets ?? { owners: [], types: [] };
  // На широком окне карточка всегда рядом (по умолчанию — первый документ); на узком выезжает только по выбору.
  const narrow = useMediaQuery(DETAIL_NARROW_QUERY);
  const picked = params.get('doc');
  const selected = picked ?? (narrow ? null : items[0]?.id ?? null);

  const setParam = useCallback((patch: Record<string, string | null>) => {
    setParams((p) => {
      const n = new URLSearchParams(p);
      for (const [k, v] of Object.entries(patch)) if (v === null) n.delete(k); else n.set(k, v);
      return n;
    }, { replace: true });
  }, [setParams]);
  // Выбор документа — шаг истории: «Назад» возвращает к прежнему. Страница и реестр при этом не прокручиваются.
  const select = useCallback((id: string | null) => {
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (id === null) n.delete('doc'); else n.set('doc', id);
      return n;
    }, { preventScrollReset: true });
  }, [setParams]);
  const setSort = (s: DocSort) => { setSortState(s); saveSort(s); };
  const today = todayLocal();
  const exportApproved = async () => {
    setExporting(true);
    try {
      const { blob, fileName } = await docsApi.exportApproved(query);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast(`Выгружено: ${fileName}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Не удалось выгрузить реестр', 'error');
    } finally {
      setExporting(false);
    }
  };
  const approvedRow = (d: DocItem) => {
    const left = d.reviewDue ? daysTo(d.reviewDue, today) : null;
    return (
      <tr key={d.id} data-doc={d.id} className={d.id === selected ? 'sel' : undefined} tabIndex={0} aria-selected={d.id === selected}
        onClick={() => select(d.id)} onKeyDown={(e) => { if (e.key === 'Enter') select(d.id); }}>
        <td className="mono">{d.number}</td>
        <td><div className="w500">{d.title}</div>{sort !== 'type' && <div className="hint">{d.type.value}</div>}</td>
        <td>{d.owner.fullName}</td>
        <td className="mono">{versionLabel({ no: d.approvedVersionNo ?? d.versionNo, edition: d.approvedEdition ?? '' })}{d.approvedOrderNo && <div className="hint">приказ № {d.approvedOrderNo}</div>}</td>
        <td className="mono">{d.signedOn ? formatDate(d.signedOn) : d.approvedAt ? formatDate(d.approvedAt.slice(0, 10)) : '—'}</td>
        <td className={`mono${left !== null && left < 0 ? ' late-t' : ''}`} data-testid="review-due">
          {d.reviewDue ? formatDate(d.reviewDue) : '—'}
          {left !== null && <div className="hint">{left < 0 ? `просрочен на ${-left} дн.` : left === 0 ? 'сегодня' : `через ${left} дн.`}</div>}
        </td>
        {ibWork && <td className="mono" data-testid="controls-count">{d.controlsActive || '—'}</td>}
        {ibWork && <td className="mono" data-testid="automations-count">{d.automationsActive || '—'}</td>}
        <td>{d.onReview ? <span className="chip high" data-testid="on-review">на пересмотре</span> : null}</td>
      </tr>
    );
  };
  const toggleType = (id: string) => setCollapsed((c) => {
    const n = new Set(c);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const row = (d: DocItem) => (
    <tr key={d.id} data-doc={d.id} className={d.id === selected ? 'sel' : undefined} tabIndex={0} aria-selected={d.id === selected}
      onClick={() => select(d.id)} onKeyDown={(e) => { if (e.key === 'Enter') select(d.id); }}>
      <td><div className="w500">{d.title}</div>{sort !== 'type' && <div className="hint">{d.type.value}</div>}</td>
      <td>{d.owner.fullName}</td>
      <td className="mono">{versionLabel({ no: d.versionNo, edition: d.edition })}</td>
      <td className="mono">{d.approvedAt ? formatDate(d.approvedAt.slice(0, 10)) : '—'}</td>
      <td className={`mono${d.status === 'review_overdue' ? ' late-t' : ''}`}>{reviewLabel(d)}</td>
      <td>
        <RouteDots d={d} />
        {stageHint(d) && <div className={`hint${d.waitingForMe ? ' tone-accent w600' : ''}`}>{stageHint(d)}</div>}
        {d.holders && <HoldersLine holders={d.holders} testId="doc-holders" />}
        {d.partiesDue && <div className={`hint mono${d.partiesOverdue ? ' late-t' : ''}`} title="Ближайший срок ответственного лица">лица: до {formatDate(d.partiesDue)}</div>}
        {d.openBlockers > 0 && <div><span className="chip crit" title="Открытые блокеры">блокер{d.openBlockers > 1 ? ` · ${d.openBlockers}` : ''}</span></div>}
      </td>
      <td><span className={`chip ${STATUS_TONE[d.status]}`}>{d.statusName}</span></td>
    </tr>
  );

  return (
    <>
      <div className="head">
        <div>
          <h1>Внутренние документы ИБ</h1>
          <p>
            {ibWork
              ? 'Реестр нормативных документов отдела. Документ до утверждения — ссылка OnlyOffice, здесь ведутся маршрут и контроль сроков пересмотра: драфт → согласование → перевод → утверждение.'
              : 'Утверждённые документы отдела ИБ и документы, которые ждут вашего действия.'}
          </p>
        </div>
        <div className="row">
          {view === 'approved' && (
            <button className="btn" type="button" disabled={exporting} onClick={() => void exportApproved()}>Выгрузить в Excel</button>
          )}
          {canManage && <button className="btn primary" type="button" onClick={() => setNewOpen(true)}>Новый документ</button>}
        </div>
      </div>

      <div className="tabs page-tabs" role="tablist" aria-label="Подменю документов">
        {VIEWS.filter((v) => ibWork || v.key !== 'work').map((v) => (
          <NavLink key={v.path} to={v.path} end role="tab" aria-selected={view === v.key}>{v.title}</NavLink>
        ))}
      </div>

      <div className="row docs-bar">
        {view === 'work' ? (
          <ChipScroller label="Фильтр документов в работе" className="toolbar-grow">
            <button type="button" aria-pressed={!filter && !stage} onClick={() => setParam({ filter: null, stage: null, doc: null })}>Все</button>
            <button type="button" aria-pressed={filter === 'waiting'} onClick={() => setParam({ filter: 'waiting', stage: null, doc: null })}>
              Ждут вас <span className="mono">{summary.data?.waitingForMe ?? 0}</span>
            </button>
            {STAGE_FILTERS.map((f) => (
              <button key={f.stage} type="button" aria-pressed={stage === f.stage} onClick={() => setParam({ stage: String(f.stage), filter: null, doc: null })}>{f.title}</button>
            ))}
          </ChipScroller>
        ) : view === 'approved' ? (
          <ChipScroller label="Фильтр утверждённых документов" className="toolbar-grow">
            <button type="button" aria-pressed={!filter} onClick={() => setParam({ filter: null, doc: null })}>Все</button>
            <button type="button" aria-pressed={filter === 'on_review'} onClick={() => setParam({ filter: 'on_review', doc: null })}>На пересмотре</button>
            <button type="button" aria-pressed={filter === 'review_overdue'} onClick={() => setParam({ filter: 'review_overdue', doc: null })}>
              Пересмотр просрочен <span className="mono">{summary.data?.reviewOverdue ?? 0}</span>
            </button>
          </ChipScroller>
        ) : (
        <ChipScroller label="Фильтр документов" className="toolbar-grow">
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
        </ChipScroller>
        )}
        <input className="inp docs-search" type="search" placeholder="Поиск по названию" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Поиск по названию" />
      </div>

      <div className="row docs-bar docs-filters" data-testid="docs-filters">
        <div className="row">
          <select className="inp" value={typeId ?? ''} aria-label="Тип документа" onChange={(e) => setParam({ type: e.target.value || null, doc: null })}>
            <option value="">Все типы</option>
            {facets.types.map((t) => <option key={t.id} value={t.id}>{t.value}</option>)}
          </select>
          <select className="inp" value={ownerId ?? ''} aria-label="Автор" onChange={(e) => setParam({ owner: e.target.value || null, doc: null })}>
            <option value="">Все авторы</option>
            {facets.owners.map((o) => <option key={o.id} value={o.id}>{o.fullName}</option>)}
          </select>
          <select className="inp" value={dueMode} aria-label="Срок пересмотра"
            onChange={(e) => setParam({ due: e.target.value || null, dueTo: e.target.value === 'to' ? dueTo ?? null : null, doc: null })}>
            <option value="">Любой срок пересмотра</option>
            {DUE_FILTERS.map((f) => <option key={f.key} value={f.key}>{f.title}</option>)}
            <option value="to">До даты…</option>
          </select>
          {dueMode === 'to' && (
            <input className="inp" type="date" value={dueTo ?? ''} aria-label="Пересмотр не позже" onChange={(e) => setParam({ due: 'to', dueTo: e.target.value || null, doc: null })} />
          )}
          {(narrowed || dueMode) && (
            <button className="btn sm ghost" type="button" onClick={() => setParam({ type: null, owner: null, due: null, dueTo: null, doc: null })}>Сбросить</button>
          )}
        </div>
        <div className="filters" role="group" aria-label="Порядок">
          {SORTS.map((s) => (
            <button key={s.key} type="button" aria-pressed={sort === s.key} onClick={() => setSort(s.key)}>{s.title}</button>
          ))}
        </div>
      </div>

      {docs.isError && <div className="form-error">{docs.error.message}</div>}
      <div className="dash ld">
        <section className="panel w8 ld-list">
          <div className="tbl-wrap">
            <table className="docs-tbl">
              <thead>
                {view === 'approved'
                  ? <tr><th>№</th><th>Документ</th><th>Владелец</th><th>Действующая версия</th><th>Утверждён</th><th>Пересмотр до</th>{ibWork && <th>Механизмов контроля</th>}{ibWork && <th>Автоматизаций</th>}<th /></tr>
                  : <tr><th>Документ</th><th>Владелец</th><th>Версия</th><th>Утверждён</th><th>Пересмотр до</th><th>Согласование</th><th>Статус</th></tr>}
              </thead>
              <tbody>
                {sort === 'type'
                  ? groupByType(items).map((g) => {
                    const open = !collapsed.has(g.type.id);
                    return (
                      <Fragment key={g.type.id}>
                        <tr className="docs-grp" data-testid="doc-type-group" data-type-id={g.type.id} data-type={g.type.value}>
                          <td colSpan={7}>
                            <button type="button" aria-expanded={open} onClick={() => toggleType(g.type.id)}>
                              <span className="docs-caret" aria-hidden="true">{open ? '▾' : '▸'}</span> {g.type.value} <span className="mono hint">{g.items.length}</span>
                            </button>
                          </td>
                        </tr>
                        {open && g.items.map(view === 'approved' ? approvedRow : row)}
                      </Fragment>
                    );
                  })
                  : items.map(view === 'approved' ? approvedRow : row)}
                {docs.isSuccess && items.length === 0 && (
                  <tr><td colSpan={7} className="hint">
                    {filter === 'waiting' ? 'Сейчас ничего не ждёт вашего согласования' : search || narrowed ? 'Ничего не найдено'
                      : view === 'approved' ? 'Утверждённых документов пока нет' : view === 'work' ? 'Документов в работе нет' : 'Документов пока нет'}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
        {selected
          ? <DocumentPanel id={selected} className="w4" onGone={() => select(null)} onClose={picked ? () => select(null) : undefined} key={selected} />
          : !narrow && (
            <DetailPanel label="Документ" variant="inline" className="w4" title="Документ не выбран">
              <div className="hint">{items.length ? 'Нажмите строку в реестре — карточка с маршрутом откроется здесь.' : 'Когда в реестре появятся документы, карточка выбранного откроется здесь.'}</div>
            </DetailPanel>
          )}
      </div>
      {newOpen && <NewDocumentDrawer meId={me.id} onClose={() => setNewOpen(false)} onCreated={(id) => { setNewOpen(false); setParam({ filter: null, doc: id }); }} />}
    </>
  );
}
