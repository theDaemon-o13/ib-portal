// «Обзор»: уровень и итог со шкалой, заполненность и ключевые разделы, радар, средние по доменам, распределение,
// слабые места. Щелчок по домену или разделу открывает его в чек-листе.
import { useNavigate } from 'react-router-dom';
import type { Assessment } from '../../api/assessments';
import { DomainBars, Donut, LevelPill, Radar, RadarLegend, Ring, Scale } from './Charts';
import { answersByCode, deltaTone, shortTitle, signed, unanswered, weakSections } from './logic';

const WEAK_LIMIT = 8;

export function Overview({ a }: { a: Assessment }) {
  const navigate = useNavigate();
  const m = a.methodology;
  const s = a.score;
  const prev = a.previous;
  const by = answersByCode(a.answers);
  const description = m.maturity.find((x) => x.code === s.level.code)?.description ?? '';
  const delta = prev ? s.total - prev.total : null;
  const missing = unanswered(m, a.answers);
  const weak = weakSections(m, a.answers);
  const goto = (dom: number, sec?: string) => navigate(`/assessment/checklist?id=${a.id}&dom=${dom}${sec ? `&sec=${sec}` : ''}`);
  const domainOf = (code: string) => m.domains.find((d) => d.sections.some((x) => x.code === code))?.no ?? 1;
  const nameOf = (code: string) => m.domains.flatMap((d) => d.sections).find((x) => x.code === code)?.name ?? code;
  const top = m.maturity.reduce((x, y) => (y.min > x.min ? y : x), m.maturity[0] ?? { name: '', min: 0 });

  return (
    <div className="sa-grid">
      <section className="panel sa-w8">
        <div className="sa-lvl">
          <div className="sa-lvl-top">
            <div>
              <div className="hint">Уровень КБ{s.preliminary ? ' · предварительно' : ''}</div>
              <div className="sa-lvl-name" data-testid="sa-level">{s.level.name}</div>
              {description && <div className="sa-lvl-sub">{description}</div>}
            </div>
            <div className="sa-lvl-score">
              <b className="num" data-testid="sa-total">{s.total}</b> <span>из {s.max}</span>
              <div className={`sa-delta ${deltaTone(delta)}`}>
                {prev && delta !== null ? `${signed(delta)} к «${shortTitle(prev.title)}»` : 'нет прошлой оценки'}
              </div>
            </div>
          </div>
          <Scale m={m} total={s.total} prevTotal={prev?.total} />
        </div>
      </section>

      <section className="panel sa-w4">
        <div className="panel-h"><h3>Готовность</h3><span className="hint">{a.statusName}</span></div>
        <div className="panel-b">
          <div className="sa-ring">
            <Ring value={s.answered} total={s.sections} />
            <div>
              <b className="num sa-ring-n" data-testid="sa-answered">{s.answered} из {s.sections}</b>
              <div className="hint">{missing.length ? `Не заполнено: ${missing.join(', ')}` : 'Все разделы заполнены'}</div>
            </div>
          </div>
          <div className="sa-keys">
            <div className="hint">Для «{top.name}» нужно {top.min}+ баллов и {m.scale.at(-1)?.level ?? 4} в ключевых разделах:</div>
            {s.keySections.map((k) => {
              const ok = k.level === (m.scale.at(-1)?.level ?? 4);
              return (
                <div key={k.code} className="sa-key">
                  <span className={ok ? 'sa-ok' : 'sa-no'} aria-label={ok ? 'выполнено' : 'не выполнено'}>{ok ? '✓' : '✗'}</span>
                  <button type="button" onClick={() => goto(domainOf(k.code), k.code)}><span className="sa-code">{k.code}</span> {k.name}</button>
                  <LevelPill level={k.level} />
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="panel sa-w6">
        <div className="panel-h">
          <h3>Профиль по доменам</h3>
          <RadarLegend title={shortTitle(a.title)} prevTitle={prev ? shortTitle(prev.title) : null} hasTarget={s.domains.some((d) => d.targetAvg !== null)} />
        </div>
        <div className="panel-b"><Radar score={s} prev={prev?.domains.map((d) => d.avg)} /></div>
      </section>

      <section className="panel sa-w6">
        <div className="panel-h"><h3>Средний балл по доменам</h3><span className="hint">из 4{prev ? ' · штрих — прошлая оценка' : ''}</span></div>
        <div className="panel-b"><DomainBars score={s} prev={prev} onPick={(no) => goto(no)} /></div>
      </section>

      <section className="panel sa-w5">
        <div className="panel-h"><h3>Распределение ответов</h3><span className="hint">разделов на уровне</span></div>
        <div className="panel-b"><Donut m={m} dist={s.distribution} /></div>
      </section>

      <section className="panel sa-w7">
        <div className="panel-h"><h3>Слабые места</h3><span className="hint">разделы на базовом уровне, ключевые первыми</span></div>
        <div className="panel-b sa-weak">
          {weak.length ? (
            <>
              {weak.slice(0, WEAK_LIMIT).map((x) => {
                const target = by.get(x.code)?.targetLevel;
                return (
                  <button key={x.code} type="button" onClick={() => goto(x.domainNo, x.code)}>
                    <span className="sa-code">{x.code}</span>
                    <span>{nameOf(x.code)} <span className="hint">· {x.domainName}</span></span>
                    <span className="row">
                      {x.key && <span className="chip high">ключевой</span>}
                      {target && <span className="chip low">цель {target}</span>}
                    </span>
                  </button>
                );
              })}
              {weak.length > WEAK_LIMIT && <div className="hint sa-more">и ещё {weak.length - WEAK_LIMIT}</div>}
            </>
          ) : <p className="hint">Разделов на базовом уровне нет.</p>}
        </div>
      </section>
    </div>
  );
}
