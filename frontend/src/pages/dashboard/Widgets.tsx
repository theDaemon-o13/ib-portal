import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { dashboardApi, dashkeys, type Kpi, type WidgetData, type WidgetRef } from '../../api/dashboard';
import { barWidth, daysBox, num } from './logic';

const REFRESH_MS = 60_000;

/** KPI: щелчок ведёт в раздел с тем же фильтром. */
export function KpiCard({ k }: { k: Kpi }) {
  const body = (
    <>
      <div className="l">{k.label}</div>
      <div className="v">{k.value === null ? '—' : k.value}</div>
      <div className="src">{k.source}</div>
    </>
  );
  const cls = `kpi ${k.tone ?? ''}`;
  if (!k.link) return <div className={cls} title="Источник не настроен">{body}</div>;
  return <Link className={`${cls} kpi-link`} to={k.link} aria-label={`${k.label}: ${k.value ?? 'нет данных'}. Открыть`}>{body}</Link>;
}

type Row = WidgetData['rows'][number];

/** Полосы: каждая строка — ссылка в раздел с фильтром по этому значению. */
export function Bars({ rows }: { rows: Row[] }) {
  if (!rows.length) return <div className="hint">Нет значений</div>;
  return (
    <div className="bars">
      {rows.map((r) => {
        const inner = (
          <>
            <span className="t" title={r.label}>{r.label}</span>
            <span className="track"><span className={`fill${r.tone ? ` c-${r.tone}` : ''}`} style={{ width: `${barWidth(r.count, rows)}%` }} /></span>
            <span className="n mono">{r.count}</span>
          </>
        );
        return r.link
          ? <Link key={r.label} className="bar bar-link" to={r.link} aria-label={`${r.label}: ${r.count}`}>{inner}</Link>
          : <div key={r.label} className="bar">{inner}</div>;
      })}
    </div>
  );
}

function Stats({ w }: { w: WidgetData }) {
  return (
    <div className="row stats">
      {w.stats.map((s) => {
        const inner = (
          <>
            <div className="eyebrow">{s.label}</div>
            <div className={`mono big-n${s.tone ? ` tone-${s.tone}` : ''}`}>{num(s.value)}</div>
          </>
        );
        return s.link
          ? <Link key={s.label} className="stat stat-link" to={s.link}>{inner}</Link>
          : <div key={s.label} className="stat">{inner}</div>;
      })}
    </div>
  );
}

function Timeline({ rows }: { rows: Row[] }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <>
      <div className="cols">
        {rows.map((r) => (
          <Link key={r.label} className="c" to={r.link ?? '#'} aria-label={`${r.label}: ${r.count}`}>
            <span>{r.count || ''}</span>
            <i className={r.tone === 'accent' ? 'last' : ''} style={{ height: `${(r.count / max) * 88}%` }} />
          </Link>
        ))}
      </div>
      <div className="cols-x">{rows.map((r) => <span key={r.label}>{r.label}</span>)}</div>
    </>
  );
}

function Deadline({ w }: { w: WidgetData }) {
  return (
    <>
      <Stats w={w} />
      <div className="list">
        {w.items.length === 0 && <div className="hint">Просроченных и горящих записей нет</div>}
        {w.items.map((i) => {
          const d = daysBox(i.days);
          return (
            <Link key={i.id} className="li li-link" to={i.link}>
              <div className="min0"><div className="ellipsis">{i.title}</div><div className="m">{i.sub}</div></div>
              <span className={`chip ${d.tone === 'over' ? 'crit' : d.tone === 'soon' ? 'high' : ''}`}>
                {i.days === null ? 'без срока' : i.days < 0 ? `просрочено ${-i.days} дн.` : i.days === 0 ? 'сегодня' : `осталось ${i.days} дн.`}
              </span>
            </Link>
          );
        })}
      </div>
    </>
  );
}

/** «Доступ без основания» (сверка с DLP): главная цифра — устройства с открытым каналом без действующего разрешения. */
function Basis({ w }: { w: WidgetData }) {
  const big = <div className={`mono big-n${w.total ? ' tone-crit' : ''}`}>{num(w.total)}</div>;
  return (
    <div className="grid-gap">
      {w.link ? <Link className="stat stat-link" to={w.link} aria-label={`Доступ без основания: ${w.total ?? 0}. Открыть`}>{big}</Link> : big}
      <Stats w={w} />
    </div>
  );
}

const SIZE: Record<WidgetRef['kind'], string> = { deadline: 'w6', timeline: 'w6', distribution: 'w4', metric: 'w4', bars: 'w4', tile: 'w3', basis: 'w6' };

/** Виджет: свой запрос к серверу (кэш там же, 1 минута), обновление раз в минуту. */
export function WidgetPanel({ w, bare = false }: { w: WidgetRef; bare?: boolean }) {
  const q = useQuery({ queryKey: dashkeys.widget(w.key), queryFn: () => dashboardApi.widget(w.key), refetchInterval: REFRESH_MS });
  const d = q.data;
  return (
    // bare — ширину задаёт раскладка (обёртка в сетке), а не вид виджета.
    <section className={bare ? 'panel' : `panel ${SIZE[w.kind]}`} aria-label={w.title} data-widget={w.key}>
      <div className="panel-h">
        <h3>{w.title}</h3>
        {d?.link ? <Link className="sub" to={d.link}>{w.source}</Link> : <span className="sub">{w.source}</span>}
      </div>
      <div className="panel-b">
        {q.isPending && <div className="hint">Загрузка…</div>}
        {q.isError && !d && <div className="hint">Не удалось загрузить</div>}
        {d && (d.kind === 'distribution' || d.kind === 'bars') && <Bars rows={d.rows} />}
        {d && d.kind === 'metric' && <Stats w={d} />}
        {d && d.kind === 'timeline' && <Timeline rows={d.rows} />}
        {d && d.kind === 'deadline' && <Deadline w={d} />}
        {d && d.kind === 'basis' && <Basis w={d} />}
      </div>
    </section>
  );
}

/** Плитка-счётчик: итог (без закрытых записей) и разбивка по значениям. */
export function TilePanel({ w }: { w: WidgetRef }) {
  const q = useQuery({ queryKey: dashkeys.widget(w.key), queryFn: () => dashboardApi.widget(w.key), refetchInterval: REFRESH_MS });
  const d = q.data;
  const total = d?.link
    ? <Link className="v" to={d.link} aria-label={`${w.title}: ${d.total ?? 0}. Открыть`}>{num(d.total)}</Link>
    : <div className="v">{num(d?.total)}</div>;
  return (
    <section className="tile" aria-label={w.title} data-widget={w.key}>
      <div className="l">{w.title}</div>
      {total}
      <div className="src">{w.source}{d?.stats[0] ? ` · ${d.stats[0].label}` : ''}</div>
      {d && d.rows.length > 1 && <Bars rows={d.rows} />}
    </section>
  );
}
