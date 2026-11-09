// «Задачи → Отчёт» (1.6.4): выполненные задачи за период — цифры, иллюстрации и список, чтобы понять, как работал
// сотрудник. Страница и выгрузка — по праву «Задачи: отчёт» (tasks.report); фильтры — в адресе страницы.
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import type { Me } from '../../api/client';
import { settingsApi } from '../../api/settings';
import { tasksApi, tkeys, type TaskStatsFilter } from '../../api/tasks';
import { useToast } from '../../components/Toast';
import { formatDate } from '../registers/logic';
import { todayLocal } from './logic';
import { CLOSED_BY, days, pct, PRESETS, presetOf, presetRange, sortItems, type SortKey } from './stats';
import { CategoriesChart, PeopleChart, WeeksChart } from './StatsCharts';
import { TaskReportDialog } from './TaskReportDialog';
import { Select } from '../../components/Select';

const COLUMNS: { key: SortKey; title: string }[] = [
  { key: 'number', title: '№' },
  { key: 'title', title: 'Задача' },
  { key: 'category', title: 'Категория' },
  { key: 'assignee', title: 'Исполнитель' },
  { key: 'startedAt', title: 'В работе с' },
  { key: 'completedAt', title: 'Выполнена' },
  { key: 'dueDate', title: 'Срок' },
  { key: 'lateDays', title: 'Опоздание' },
  { key: 'leadDays', title: 'Дней' },
];

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'ontime' | 'late' }) {
  return (
    <div className={`st-kpi${tone ? ` ${tone}` : ''}`}>
      <div className="st-kpi-l">{label}</div>
      <div className="st-kpi-v mono">{value}</div>
      {sub && <div className="hint">{sub}</div>}
    </div>
  );
}

export function TaskStatsPage() {
  const me = useOutletContext<Me>();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const today = todayLocal();
  const month = presetRange('month', today);
  const from = params.get('from') ?? month.from;
  const to = params.get('to') ?? month.to;
  const f: TaskStatsFilter = {
    from, to,
    assigneeId: params.get('assignee') ?? undefined,
    categoryId: params.get('category') ?? undefined,
    late: params.get('late') === '1' ? 'true' : undefined,
    archived: params.get('archived') === '1' ? 'true' : undefined,
  };
  const allowed = me.permissions.includes('tasks.report');
  const stats = useQuery({ queryKey: ['tasks', 'stats', f], queryFn: () => tasksApi.stats(f), enabled: allowed && from <= to });
  const categories = useQuery({ queryKey: tkeys.categories, queryFn: () => settingsApi.items('task_categories', false), enabled: allowed });
  const people = useQuery({ queryKey: ['settings', 'userOptions'], queryFn: settingsApi.userOptions, enabled: allowed });
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'completedAt', dir: 'desc' });
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const items = useMemo(() => sortItems(stats.data?.items ?? [], sort.key, sort.dir), [stats.data, sort]);

  const set = (patch: Record<string, string | null>) => setParams((p) => {
    const n = new URLSearchParams(p);
    for (const [k, v] of Object.entries(patch)) if (v === null || v === '') n.delete(k); else n.set(k, v);
    return n;
  }, { replace: true });
  const sortBy = (key: SortKey) => setSort((s) => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : key === 'title' || key === 'assignee' || key === 'category' ? 'asc' : 'desc' }));

  const exportXlsx = async () => {
    setBusy(true);
    try {
      const { blob, fileName } = await tasksApi.report({
        period: 'completed', from, to, assigneeId: f.assigneeId, categoryId: f.categoryId, overdue: f.late, archived: f.archived,
      });
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
      toast(err instanceof Error ? err.message : 'Не удалось выгрузить отчёт', 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!allowed) {
    return (
      <div className="panel panel-b">
        <p>Отчёт по задачам открывает право «Задачи: отчёт». Его назначают в «Настройки → Пользователи и роли».</p>
        <Link to="/tasks">← К доске задач</Link>
      </div>
    );
  }
  const s = stats.data?.summary;
  const active = presetOf(from, to, today);
  return (
    <>
      <div className="head">
        <div>
          <h1>Отчёт по выполненным задачам</h1>
          <p>Что сделано за период, в срок ли, сколько заняло и кто принял. Выполненной считается задача в колонке «Выполнено»; задачи, переданные другому ответственному, — только с «С архивом».</p>
        </div>
        <div className="row">
          <Link className="btn" to="/tasks">К доске</Link>
          <button className="btn" type="button" onClick={() => setAdvanced(true)}>Расширенная выгрузка</button>
          <button className="btn primary" type="button" disabled={busy} onClick={() => void exportXlsx()}>{busy ? 'Выгружаем…' : 'Выгрузить в Excel'}</button>
        </div>
      </div>

      <div className="st-filters" data-testid="stats-filters">
        <div className="filters" role="group" aria-label="Период">
          {PRESETS.map((p) => (
            <button key={p.key} type="button" aria-pressed={active === p.key} onClick={() => set(presetRange(p.key, today))}>{p.title}</button>
          ))}
        </div>
        <label className="st-f">С<input className="inp" type="date" value={from} max={to} onChange={(e) => e.target.value && set({ from: e.target.value })} aria-label="С даты" /></label>
        <label className="st-f">по<input className="inp" type="date" value={to} min={from} onChange={(e) => e.target.value && set({ to: e.target.value })} aria-label="По дату" /></label>
        <Select className="inp" value={f.assigneeId ?? ''} aria-label="Сотрудник" onChange={(e) => set({ assignee: e.target.value })}>
          <option value="">Все сотрудники</option>
          {people.data?.items.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
        </Select>
        <Select className="inp" value={f.categoryId ?? ''} aria-label="Категория" onChange={(e) => set({ category: e.target.value })}>
          <option value="">Все категории</option>
          {categories.data?.items.map((c) => <option key={c.id} value={c.id}>{c.value}</option>)}
        </Select>
        <label className="check"><input type="checkbox" checked={!!f.late} onChange={(e) => set({ late: e.target.checked ? '1' : null })} /> только с опозданием</label>
        <label className="check"><input type="checkbox" checked={!!f.archived} onChange={(e) => set({ archived: e.target.checked ? '1' : null })} /> с архивом</label>
      </div>

      {from > to && <div className="form-error">Начало периода позже конца</div>}
      {stats.isError && <div className="form-error" role="alert">{stats.error.message}</div>}
      {stats.isPending && from <= to && <div className="panel panel-b hint">Считаем…</div>}
      {s && stats.data && (
        <>
          <div className="st-kpis" data-testid="stats-kpis">
            <Kpi label="Выполнено" value={String(s.done)} sub={`${formatDate(from)} — ${formatDate(to)}`} />
            <Kpi label="В срок" value={pct(s.onTime, s.done) === null ? '—' : `${pct(s.onTime, s.done)}%`} sub={`${s.onTime} из ${s.done}`} tone="ontime" />
            <Kpi label="С опозданием" value={String(s.late)} sub={s.avgLateDays !== null ? `в среднем на ${days(s.avgLateDays)}` : 'опозданий нет'} tone="late" />
            <Kpi label="Время выполнения" value={s.avgLeadDays !== null ? days(s.avgLeadDays) : '—'} sub="в среднем от взятия в работу" />
          </div>
          <div className="st-grid2">
            <WeeksChart weeks={stats.data.weeks} />
            <PeopleChart people={stats.data.byAssignee} onPick={(id) => set({ assignee: id })} />
          </div>
          <CategoriesChart categories={stats.data.byCategory} />

          <section className="panel">
            <div className="panel-h"><h3>Выполненные задачи</h3><span className="hint">{items.length}</span></div>
            <div className="tbl-wrap">
              <table className="st-tbl" data-testid="stats-table">
                <thead>
                  <tr>
                    {COLUMNS.map((c) => (
                      <th key={c.key} aria-sort={sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                        <button type="button" className="st-sort" onClick={() => sortBy(c.key)}>
                          {c.title}{sort.key === c.key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                        </button>
                      </th>
                    ))}
                    <th>Закрыта</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.id}>
                      <td className="mono">{i.number}</td>
                      <td><Link to={`/tasks?task=${i.id}`}>{i.title}</Link></td>
                      <td>{i.category.value}</td>
                      <td>{i.assignee?.fullName ?? <span className="hint">—</span>}</td>
                      <td className="mono">{i.startedAt ? formatDate(i.startedAt) : '—'}</td>
                      <td className="mono">{formatDate(i.completedAt)}</td>
                      <td className="mono">{i.dueDate ? formatDate(i.dueDate) : '—'}</td>
                      <td>{i.lateDays === null ? <span className="hint">без срока</span> : i.lateDays > 0
                        ? <span className="chip crit">+{days(i.lateDays)}</span>
                        : <span className="chip acc">в срок</span>}</td>
                      <td className="mono">{i.leadDays}</td>
                      <td className="hint">{i.closedBy.fullName ? `${i.closedBy.fullName} — ${CLOSED_BY[i.closedBy.how]}` : CLOSED_BY[i.closedBy.how]}</td>
                    </tr>
                  ))}
                  {items.length === 0 && <tr><td colSpan={COLUMNS.length + 1} className="hint">За период нет выполненных задач</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
      {advanced && <TaskReportDialog onClose={() => setAdvanced(false)} />}
    </>
  );
}
