// «Задачи → Цепочки» (1.7.0, ADR-0035): цепочки с видимыми задачами — фильтр по статусу и ответственному, поиск
// по названию и номеру. Строка открывает панель цепочки (?chain=). Фильтры — в адресе страницы.
import { useQuery } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { Link, useNavigate, useOutletContext, useSearchParams } from 'react-router-dom';
import type { Me } from '../../api/client';
import { settingsApi } from '../../api/settings';
import { chainsApi, tkeys } from '../../api/tasks';
import { formatDate } from '../registers/logic';
import { ChainPanel } from './ChainPanel';
import { DiscoverDialog } from './DiscoverDialog';
import { chainCounts } from './logic';
import { Select } from '../../components/Select';

export function TaskChainsPage() {
  const me = useOutletContext<Me>();
  const [discover, setDiscover] = useState(false);
  // «Найти цепочки среди старых задач» — «Задачи: постановка другим» или «Настройки» (решение владельца 04.11.2026).
  // ib.work обязателен (1.8.0, ADR-0036): поиск показывает задачи — служебный администратор его не видит.
  const canDiscover = me.permissions.includes('ib.work') && (me.permissions.includes('tasks.assign') || me.permissions.includes('settings.manage'));
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const raw = params.get('status');
  const status: 'open' | 'closed' | 'all' = raw === 'closed' || raw === 'all' ? raw : 'open';
  const ownerId = params.get('owner') ?? '';
  const q = params.get('q') ?? '';
  const openId = params.get('chain');
  const [text, setText] = useState(q);
  const set = useCallback((patch: Record<string, string | null>) => setParams((p) => {
    const n = new URLSearchParams(p);
    for (const [k, v] of Object.entries(patch)) if (v === null || v === '') n.delete(k); else n.set(k, v);
    return n;
  }), [setParams]);
  const filter: { status?: 'open' | 'closed'; ownerId?: string; q?: string } = { status: status === 'all' ? undefined : status, ownerId: ownerId || undefined, q: q || undefined };
  const list = useQuery({ queryKey: tkeys.chainList(filter), queryFn: () => chainsApi.list(filter) });
  const people = useQuery({ queryKey: ['settings', 'userOptions'], queryFn: settingsApi.userOptions });

  return (
    <>
      <div className="head">
        <div>
          <h1>Цепочки задач</h1>
          <p>Задачи с одной темой — как переписка «RE: тема» в почте. Цепочку собирает человек: портал подсказывает при создании задачи. Проверка у каждой задачи своя.</p>
        </div>
        <div className="row">
          <Link className="btn" to="/tasks">К доске</Link>
          {canDiscover && <button className="btn" type="button" onClick={() => setDiscover(true)}>Найти цепочки среди старых задач</button>}
        </div>
      </div>
      <div className="toolbar chains-filters" aria-label="Фильтры цепочек">
        <div className="filters" role="group" aria-label="Статус">
          {([['open', 'Открытые'], ['closed', 'Закрытые'], ['all', 'Все']] as const).map(([k, title]) => (
            <button key={k} type="button" aria-pressed={status === k} onClick={() => set({ status: k === 'open' ? null : k })}>{title}</button>
          ))}
        </div>
        <Select className="inp" aria-label="Ответственный" value={ownerId} onChange={(e) => set({ owner: e.target.value })}>
          <option value="">Все ответственные</option>
          {people.data?.items.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
        </Select>
        <form className="grow" onSubmit={(e) => { e.preventDefault(); set({ q: text.trim() }); }}>
          <input className="inp" type="search" placeholder="Поиск по названию или номеру" aria-label="Поиск цепочки" value={text}
            onChange={(e) => { setText(e.target.value); if (!e.target.value) set({ q: null }); }} />
        </form>
      </div>
      <section className="panel" aria-label="Цепочки">
        <div className="tbl-wrap">
          <table className="cat-tbl chains-tbl">
            <thead><tr><th>№</th><th>Цепочка</th><th>Задачи</th><th>Ответственный</th><th>Срок</th><th>Статус</th></tr></thead>
            <tbody>
              {list.isPending && <tr><td colSpan={6} className="hint">Загрузка…</td></tr>}
              {list.isError && <tr><td colSpan={6} className="form-error">{list.error.message}</td></tr>}
              {list.isSuccess && list.data.items.length === 0 && (
                <tr><td colSpan={6} className="hint">{q || ownerId ? 'Ничего не найдено' : 'Цепочек пока нет. Создайте задачу с темой, как у другой задачи, — портал предложит собрать их в цепочку.'}</td></tr>
              )}
              {list.data?.items.map((c) => (
                <tr key={c.id} className={c.id === openId ? 'sel' : undefined} data-chain={c.title}>
                  <td className="mono">#{c.number}</td>
                  <td>
                    <button type="button" className="btn ghost sm ct-title" onClick={() => set({ chain: c.id })}>{c.title}</button>
                    {c.kind === 'system' && <span className="chip acc" title="Задачи автоматизаций реестра собирает портал">системная</span>}
                  </td>
                  <td>
                    {chainCounts(c.counts)}{c.allDone && c.status === 'open' ? <span className="chip low">всё выполнено</span> : null}
                    {c.kind === 'system' && c.counts.active === 0 && <span className="chip" data-testid="chain-idle">Нет активных задач</span>}
                  </td>
                  <td>{c.owner?.fullName ?? <span className="hint">—</span>}</td>
                  <td>{c.dueDate ? formatDate(c.dueDate) : <span className="hint">—</span>}</td>
                  <td>{c.status === 'open' ? 'Открыта' : <span className="chip">закрыта</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {list.data && list.data.total > list.data.items.length && <div className="hint panel-b">Показаны {list.data.items.length} из {list.data.total} — уточните поиск</div>}
      </section>
      {discover && <DiscoverDialog onClose={() => setDiscover(false)} />}
      {openId && <ChainPanel key={openId} id={openId} onClose={() => set({ chain: null })} onOpenTask={(taskId) => navigate(`/tasks?task=${taskId}`)} />}
    </>
  );
}
