// Графики самооценки — свои SVG (новых зависимостей нет): шкала уровней, кольцо заполненности, радар по доменам,
// средний балл с динамикой, распределение ответов. Те же компоненты — на «Обзоре» и в презентации.
import type { Assessment, Methodology, Score } from '../../api/assessments';
import {
  deltaTone, domainShort, donutArcs, LEVELS, levelName, MAX_LEVEL, n1, pct, radarAnchor, radarPoint, radarPolygon, scalePct, scaleZones,
  signed,
} from './logic';

/** Кружок с баллом в цвете уровня; нет ответа — «–». */
export function LevelPill({ level }: { level: number | null | undefined }) {
  return <span className="sa-pill"><i className={`sa-l${level ?? 0}`}>{level ?? '–'}</i></span>;
}

/** Кольцо заполненности k из n. */
export function Ring({ value, total }: { value: number; total: number }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const f = total ? value / total : 0;
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true">
      <circle cx="32" cy="32" r={r} fill="none" stroke="var(--fill)" strokeWidth="7" />
      <circle cx="32" cy="32" r={r} fill="none" stroke={f >= 1 ? 'var(--low)' : 'var(--accent)'} strokeWidth="7" strokeLinecap="round"
        strokeDasharray={`${c * f} ${c}`} transform="rotate(-90 32 32)" />
    </svg>
  );
}

/** Шкала из четырёх зон уровней с отметками текущей и прошлой оценки. */
export function Scale({ m, total, prevTotal }: { m: Methodology; total: number; prevTotal?: number | null }) {
  const { lo, hi, zones } = scaleZones(m);
  return (
    <div className="sa-scale" role="img" aria-label={`Шкала уровней: ${total} баллов${prevTotal != null ? `, прошлая оценка — ${prevTotal}` : ''}`}>
      {prevTotal != null && <div className="sa-mk prev" style={{ left: `${scalePct(prevTotal, lo, hi)}%` }}>{prevTotal}</div>}
      <div className="sa-mk cur" style={{ left: `${scalePct(total, lo, hi)}%` }}>{total}</div>
      <div className="sa-track">
        {zones.map((z, i) => <i key={z.code} className={`sa-z${i + 1}`} style={{ flex: z.flex }} />)}
      </div>
      <div className="sa-zl">
        {zones.map((z) => <span key={z.code} style={{ flex: z.flex }}><b>{z.name}</b>{z.from}–{z.to}</span>)}
      </div>
    </div>
  );
}

/** Радар средних баллов по доменам: текущая (заливка), прошлая (серая линия), цель (зелёный пунктир). */
export function Radar({ score, prev }: { score: Score; prev?: readonly (number | null)[] | null }) {
  const W = 520;
  const H = 330;
  const cx = W / 2;
  const cy = H / 2 + 4;
  const R = 118;
  const n = score.domains.length;
  const ring = (l: number) => radarPolygon(Array.from({ length: n }, () => l), cx, cy, R);
  const cur = score.domains.map((d) => d.avg);
  const hasTarget = score.domains.some((d) => d.targetAvg !== null);
  // Домен без цели в линии цели — на текущем уровне, а не в центре.
  const target = score.domains.map((d) => d.targetAvg ?? d.avg ?? 0);
  return (
    <svg className="sa-radar" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Радар средних баллов по доменам">
      {LEVELS.map((l) => <polygon key={l} points={ring(l)} fill="none" stroke="var(--line-2)" strokeWidth="1" />)}
      {score.domains.map((d, i) => {
        const [x, y] = radarPoint(i, MAX_LEVEL, n, cx, cy, R);
        return <line key={d.no} x1={cx} y1={cy} x2={x.toFixed(1)} y2={y.toFixed(1)} stroke="var(--line)" strokeWidth="1" />;
      })}
      {LEVELS.map((l) => {
        const [x, y] = radarPoint(0, l, n, cx, cy, R);
        return <text key={l} x={x + 4} y={y + 3} fontSize="9.5">{l}</text>;
      })}
      {score.domains.map((d, i) => {
        const [x, y] = radarPoint(i, 4.62, n, cx, cy, R);
        const anchor = radarAnchor(x, cx);
        // Домен вне итога (1.13.10): подпись оси с пометкой второй строкой.
        return (
          <text key={d.no} x={x.toFixed(1)} y={(y + (d.inTotal ? 4 : -2)).toFixed(1)} fontSize="11" textAnchor={anchor}>
            {d.no}. {domainShort(d.no, d.name)}
            {!d.inTotal && <tspan x={x.toFixed(1)} dy="12" fontSize="9.5" className="sa-radar-note">вне итога</tspan>}
          </text>
        );
      })}
      {hasTarget && <polygon points={radarPolygon(target, cx, cy, R)} fill="none" stroke="var(--low)" strokeWidth="1.6" strokeDasharray="5 4" />}
      {prev && <polygon points={radarPolygon(prev, cx, cy, R)} fill="none" stroke="var(--faint)" strokeWidth="1.6" />}
      <polygon points={radarPolygon(cur, cx, cy, R)} fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth="2" />
      {cur.map((v, i) => {
        const [x, y] = radarPoint(i, v ?? 0, n, cx, cy, R);
        return <circle key={i} cx={x.toFixed(1)} cy={y.toFixed(1)} r="3" fill="var(--accent)" />;
      })}
    </svg>
  );
}

/** Легенда радара. */
export function RadarLegend({ title, prevTitle, hasTarget }: { title: string; prevTitle?: string | null; hasTarget: boolean }) {
  return (
    <div className="sa-legend">
      <span><i style={{ background: 'var(--accent)' }} />{title}</span>
      {prevTitle && <span><i style={{ background: 'var(--faint)' }} />{prevTitle}</span>}
      {hasTarget && <span><i style={{ background: 'var(--low)' }} />Цель</span>}
    </div>
  );
}

/** Средний балл по доменам (из 4) со штрихом прошлой оценки и разницей. */
export function DomainBars({ score, prev, onPick }: {
  score: Score;
  prev?: Assessment['previous'];
  onPick?: (domainNo: number) => void;
}) {
  return (
    <div className="sa-dbars">
      {score.domains.map((d) => {
        const pv = prev?.domains.find((x) => x.no === d.no)?.avg ?? null;
        const dd = d.avg !== null && pv !== null ? d.avg - pv : null;
        const body = (
          <>
            <span className="t">{d.no}. {d.name}{!d.inTotal && <span className="chip sa-out">вне итога</span>}</span>
            <span className="track">
              <i style={{ width: `${((d.avg ?? 0) / MAX_LEVEL) * 100}%` }} />
              {pv !== null && <u style={{ left: `calc(${(pv / MAX_LEVEL) * 100}% - 1px)` }} />}
            </span>
            <span className="n">{n1(d.avg)}</span>
            <span className={`sa-delta ${deltaTone(dd)}`}>{dd === null ? '' : signed(dd, 1)}</span>
          </>
        );
        return onPick
          ? <button key={d.no} type="button" className="sa-dbar" onClick={() => onPick(d.no)}>{body}</button>
          : <div key={d.no} className="sa-dbar">{body}</div>;
      })}
    </div>
  );
}

const DONUT_COLORS: Record<number, string> = { 1: 'var(--crit)', 2: 'var(--high)', 3: 'var(--accent)', 4: 'var(--low)' };

/** Кольцо распределения ответов по уровням и подписи с долями. */
export function Donut({ m, dist }: { m: Methodology; dist: Score['distribution'] }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const answered = LEVELS.reduce((s, l) => s + dist[l], 0);
  return (
    <div className="sa-donut">
      <svg width="140" height="140" viewBox="0 0 140 140" role="img" aria-label={`Распределение ответов: ${LEVELS.map((l) => `${levelName(m, l)} — ${dist[l]}`).join(', ')}`}>
        <circle cx="70" cy="70" r={r} fill="none" stroke="var(--fill)" strokeWidth="18" />
        {donutArcs(dist, r).map((a) => (
          <circle key={a.level} cx="70" cy="70" r={r} fill="none" stroke={DONUT_COLORS[a.level]} strokeWidth="18"
            strokeDasharray={`${Math.max(a.len - 2, 0)} ${c}`} strokeDashoffset={-a.offset} transform="rotate(-90 70 70)" />
        ))}
        <text x="70" y="68" textAnchor="middle" fontSize="24" fontWeight="600" className="sa-donut-n">{answered}</text>
        <text x="70" y="86" textAnchor="middle" fontSize="11">ответов</text>
      </svg>
      <div className="sa-donut-l">
        {LEVELS.map((l) => (
          <div key={l}>
            <LevelPill level={l} />
            <span className="nm">{levelName(m, l)}</span>
            <b className="num">{dist[l]}</b>
            <span className="hint">{pct(dist[l], answered)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}
