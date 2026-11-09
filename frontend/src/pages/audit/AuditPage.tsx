import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Fragment, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AUDIT_FILTERS, auditApi, type AuditEntry, type AuditFilter } from '../../api/audit';
import { useToast } from '../../components/Toast';
import { formatDateTime } from '../settings/logic';
import { Select } from '../../components/Select';

/** YYYY-MM-DD в часовом поясе браузера. */
function isoDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function defaultFrom(): string {
  const d = new Date();
  d.setDate(d.getDate() - 6);
  return isoDay(d);
}

function Details({ e }: { e: AuditEntry }) {
  const text = e.diff === null ? '' : JSON.stringify(e.diff, null, 2);
  return (
    <div className="audit-details">
      <div className="hint">
        Код действия: <span className="mono">{e.action}</span>
        {e.entityId && <> · ID объекта: <span className="mono">{e.entityId}</span></>}
        {e.actorRoles.length > 0 && <> · роли: {e.actorRoles.join(', ')}</>}
      </div>
      {text && <pre className="mono">{text}</pre>}
    </div>
  );
}

/** Раздел «Журнал»: все действия пользователей. Только чтение; доступ — право «Журнал действий». */
export function AuditPage() {
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const filter: AuditFilter = {};
  for (const k of AUDIT_FILTERS) {
    const v = params.get(k);
    if (v) filter[k] = v;
  }
  if (!params.has('from')) filter.from = defaultFrom();
  const [q, setQ] = useState(filter.q ?? '');
  const [ip, setIp] = useState(filter.ip ?? '');
  const [open, setOpen] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const facets = useQuery({ queryKey: ['audit', 'facets'], queryFn: auditApi.facets, staleTime: 60_000 });
  const list = useInfiniteQuery({
    queryKey: ['audit', 'list', filter],
    queryFn: ({ pageParam }) => auditApi.list(filter, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];

  // Пустое «С» хранится в адресе как from= — иначе вернётся период по умолчанию (7 дней).
  const set = (patch: AuditFilter) => {
    const next = new URLSearchParams(params);
    if (!next.has('from')) next.set('from', filter.from ?? '');
    for (const [k, v] of Object.entries(patch)) {
      if (v || k === 'from') next.set(k, v ?? '');
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    set({ q: q.trim(), ip: ip.trim() });
  };
  const exportXlsx = async () => {
    setExporting(true);
    try {
      const { blob, fileName } = await auditApi.exportFile(filter);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast(`Выгружено: ${fileName}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Не удалось выгрузить', 'error');
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <div className="head">
        <div>
          <h1>Журнал</h1>
          <p>Все действия пользователей: вход, изменения в разделах и настройках. Записи журнала не меняются и не удаляются.</p>
        </div>
        <button className="btn" type="button" onClick={() => void exportXlsx()} disabled={exporting}>
          {exporting ? 'Выгружаем…' : 'Выгрузить в Excel'}
        </button>
      </div>
      <form className="panel panel-b audit-filters" onSubmit={submit} role="search">
        <label>С<input className="inp" type="date" value={filter.from ?? ''} onChange={(e) => set({ from: e.target.value })} /></label>
        <label>По<input className="inp" type="date" value={filter.to ?? ''} onChange={(e) => set({ to: e.target.value })} /></label>
        <label>Пользователь
          <Select className="inp" value={filter.userId ?? ''} onChange={(e) => set({ userId: e.target.value })}>
            <option value="">Все</option>
            <option value="system">Система</option>
            {facets.data?.users.map((u) => <option key={u.id} value={u.id}>{u.fullName} ({u.login}){u.isActive ? '' : ' — отключён'}</option>)}
          </Select>
        </label>
        <label>Раздел
          <Select className="inp" value={filter.entity ?? ''} onChange={(e) => set({ entity: e.target.value })}>
            <option value="">Все</option>
            {facets.data?.entities.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
          </Select>
        </label>
        <label>Действие
          <Select className="inp" value={filter.action ?? ''} onChange={(e) => set({ action: e.target.value })}>
            <option value="">Все</option>
            {facets.data?.actions.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
          </Select>
        </label>
        <label>IP<input className="inp mono" value={ip} onChange={(e) => setIp(e.target.value)} placeholder="10.0.5." /></label>
        <label className="grow">Поиск<input className="inp" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Что сделано, ФИО, логин, ID объекта" /></label>
        <button className="btn primary" type="submit">Найти</button>
      </form>
      <section className="panel">
        <div className="tbl-wrap">
          <table className="cat-tbl audit-tbl">
            <thead><tr><th>Когда</th><th>Кто</th><th>Действие</th><th>Что сделано</th><th>IP</th></tr></thead>
            <tbody>
              {list.isPending && <tr><td colSpan={5} className="hint">Загрузка…</td></tr>}
              {list.isError && <tr><td colSpan={5} className="form-error">{list.error.message}</td></tr>}
              {list.isSuccess && rows.length === 0 && <tr><td colSpan={5} className="hint">За выбранный период по фильтру записей нет</td></tr>}
              {rows.map((e) => (
                <Fragment key={e.id}>
                  <tr data-audit={e.id} className="clickable" onClick={() => setOpen(open === e.id ? null : e.id)} aria-expanded={open === e.id}>
                    <td className="mono nowrap">{formatDateTime(e.at)}</td>
                    <td>{e.actor ? <>{e.actor.fullName}<div className="hint mono">{e.actor.login}</div></> : <span className="hint">Система</span>}</td>
                    <td>{e.actionLabel}<div className="hint">{e.entityLabel}</div></td>
                    <td>
                      {e.summary || <span className="hint">—</span>}
                      {e.href && <div><Link to={e.href} onClick={(ev) => ev.stopPropagation()}>Открыть</Link></div>}
                      {e.objectDeleted && <div className="hint">объект удалён</div>}
                    </td>
                    <td className="mono">{e.ip ?? '—'}</td>
                  </tr>
                  {open === e.id && <tr className="audit-open"><td colSpan={5}><Details e={e} /></td></tr>}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {list.hasNextPage && (
          <div className="panel-b">
            <button className="btn sm" type="button" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>Показать ещё</button>
          </div>
        )}
      </section>
    </>
  );
}
