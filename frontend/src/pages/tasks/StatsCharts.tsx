// Иллюстрации отчёта по выполненным задачам (1.6.4): SVG без библиотек. «В срок» — акцент, «с опозданием» — критичный
// (пара проверена на дальтонизм в светлой и чёрной теме); у каждой — легенда и подсказка при наведении, список — таблица.
import { useState, type ReactNode } from 'react';
import type { TaskStats } from '../../api/tasks';
import { days, niceTicks, pct, shortDate } from './stats';

type Tip = { x: number; y: number; lines: string[] } | null;

/** Подсказка над отметкой: позиция — от контейнера графика. */
function useTip() {
  const [tip, setTip] = useState<Tip>(null);
  const show = (e: React.PointerEvent | React.FocusEvent, lines: string[]) => {
    const box = (e.currentTarget as Element).closest('.st-chart')?.getBoundingClientRect();
    const r = (e.currentTarget as Element).getBoundingClientRect();
    if (box) setTip({ x: r.left - box.left + r.width / 2, y: r.top - box.top, lines });
  };
  const node = tip && (
    <div className="st-tip" role="status" style={{ left: tip.x, top: tip.y }}>
      {tip.lines.map((l, i) => (i === 0 ? <b key={l}>{l}</b> : <div key={l}>{l}</div>))}
    </div>
  );
  return { show, hide: () => setTip(null), node };
}

export function Legend() {
  return (
    <div className="st-legend" aria-hidden="true">
      <span><i className="st-sw ontime" />в срок</span>
      <span><i className="st-sw late" />с опозданием</span>
    </div>
  );
}

function Panel({ title, sub, children, legend = false }: { title: string; sub?: string; children: ReactNode; legend?: boolean }) {
  return (
    <section className="panel st-panel">
      <div className="panel-h"><h3>{title}</h3>{legend && <Legend />}</div>
      {sub && <p className="hint st-sub">{sub}</p>}
      <div className="st-chart">{children}</div>
    </section>
  );
}

/** Выполнено по неделям: столбцы «в срок» снизу, «с опозданием» сверху, 2px зазор между частями. */
export function WeeksChart({ weeks }: { weeks: TaskStats['weeks'] }) {
  const tip = useTip();
  const W = 640;
  const H = 200;
  const pad = { l: 32, r: 8, t: 8, b: 26 };
  const max = Math.max(1, ...weeks.map((w) => w.onTime + w.late));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] ?? 1;
  const band = (W - pad.l - pad.r) / Math.max(1, weeks.length);
  const bw = Math.min(24, band * 0.6);
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / top);
  const every = Math.ceil(weeks.length / 8);
  return (
    <Panel title="Выполнено по неделям" legend>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Выполнено по неделям: в срок и с опозданием" className="st-svg">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="st-grid" />
            <text x={pad.l - 6} y={y(t)} className="st-axis" textAnchor="end" dominantBaseline="middle">{t}</text>
          </g>
        ))}
        {weeks.map((w, i) => {
          const x = pad.l + band * i + (band - bw) / 2;
          const onH = y(0) - y(w.onTime);
          const lateH = y(0) - y(w.late);
          const lines = [`Неделя с ${shortDate(w.week)}`, `в срок: ${w.onTime}`, `с опозданием: ${w.late}`];
          return (
            <g key={w.week} tabIndex={0} onPointerEnter={(e) => tip.show(e, lines)} onPointerLeave={tip.hide} onFocus={(e) => tip.show(e, lines)} onBlur={tip.hide}>
              <rect x={pad.l + band * i} y={pad.t} width={band} height={H - pad.t - pad.b} className="st-hit" />
              {w.onTime > 0 && <path d={bar(x, y(0), bw, onH, w.late === 0)} className="st-ontime" />}
              {w.late > 0 && <path d={bar(x, y(w.onTime) - (w.onTime > 0 ? 2 : 0), bw, lateH - (w.onTime > 0 ? 2 : 0), true)} className="st-late" />}
              {i % every === 0 && <text x={x + bw / 2} y={H - 8} className="st-axis" textAnchor="middle">{shortDate(w.week)}</text>}
            </g>
          );
        })}
        <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} className="st-base" />
      </svg>
      {tip.node}
    </Panel>
  );
}

/** Столбец снизу вверх: скруглённый верх (4px) — только у верхней части, у основания — прямой. */
function bar(x: number, base: number, w: number, h: number, roundTop: boolean): string {
  if (h <= 0) return '';
  const r = roundTop ? Math.min(4, w / 2, h) : 0;
  const top = base - h;
  return `M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${base} Z`;
}

/** Горизонтальная полоса из частей: 2px зазор между ними, скруглён только правый край последней (CSS). */
function Track({ parts }: { parts: { cls: string; share: number }[] }) {
  return (
    <span className="st-track" aria-hidden="true">
      {parts.filter((p) => p.share > 0).map((p) => <span key={p.cls} className={`st-seg ${p.cls}`} style={{ width: `${p.share}%` }} />)}
    </span>
  );
}

/** По сотрудникам: полоса «в срок + с опозданием»; щелчок — отчёт по этому сотруднику. */
export function PeopleChart({ people, onPick }: { people: TaskStats['byAssignee']; onPick: (id: string) => void }) {
  const tip = useTip();
  const max = Math.max(1, ...people.map((p) => p.done));
  const rows = people.slice(0, 15);
  return (
    <Panel title="По сотрудникам" sub={people.length > rows.length ? `Первые ${rows.length} из ${people.length} по числу задач` : 'Щелчок по строке — отчёт по сотруднику'} legend>
      <div className="st-rows">
        {rows.map((p) => {
          const share = pct(p.onTime, p.done);
          const lines = [p.fullName, `выполнено: ${p.done}`, `в срок: ${p.onTime}${share !== null ? ` (${share}%)` : ''}`, `с опозданием: ${p.late}`,
            ...(p.avgLeadDays !== null ? [`в среднем: ${days(p.avgLeadDays)}`] : [])];
          const onW = (p.onTime / max) * 100;
          const lateW = (p.late / max) * 100;
          return (
            <button key={p.id ?? 'none'} type="button" className="st-row" disabled={!p.id} onClick={() => p.id && onPick(p.id)}
              onPointerEnter={(e) => tip.show(e, lines)} onPointerLeave={tip.hide} onFocus={(e) => tip.show(e, lines)} onBlur={tip.hide}>
              <span className="st-name">{p.fullName}</span>
              <Track parts={[{ cls: 'st-ontime', share: onW }, { cls: 'st-late', share: lateW }]} />
              <span className="st-val mono">{p.done}<span className="hint"> · {share ?? '—'}%</span></span>
            </button>
          );
        })}
        {rows.length === 0 && <p className="hint">Нет выполненных задач</p>}
      </div>
      {tip.node}
    </Panel>
  );
}

/** По категориям: один ряд — легенда не нужна, название говорит, что показано. */
export function CategoriesChart({ categories }: { categories: TaskStats['byCategory'] }) {
  const tip = useTip();
  const max = Math.max(1, ...categories.map((c) => c.done));
  const total = categories.reduce((a, c) => a + c.done, 0);
  return (
    <Panel title="По категориям">
      <div className="st-rows">
        {categories.map((c) => {
          const lines = [c.value, `выполнено: ${c.done} (${pct(c.done, total) ?? 0}%)`];
          return (
            <div key={c.id} className="st-row" tabIndex={0} onPointerEnter={(e) => tip.show(e, lines)} onPointerLeave={tip.hide} onFocus={(e) => tip.show(e, lines)} onBlur={tip.hide}>
              <span className="st-name">{c.value}</span>
              <Track parts={[{ cls: 'st-cat', share: (c.done / max) * 100 }]} />
              <span className="st-val mono">{c.done}</span>
            </div>
          );
        })}
        {categories.length === 0 && <p className="hint">Нет выполненных задач</p>}
      </div>
      {tip.node}
    </Panel>
  );
}
