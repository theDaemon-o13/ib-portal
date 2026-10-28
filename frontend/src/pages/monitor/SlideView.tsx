import type { MonitorItem, MonitorSlide, MonitorVuln } from '../../api/dashboard';
import { barWidth, dateRu, daysBox, daysText, num, pageOf } from '../dashboard/logic';
import { emptyText, pagesOf } from './slides';

const KIND_NAMES: Record<MonitorItem['kind'], string> = { task: 'Задача', document: 'Документ', risk: 'Риск ИБ', evidence: 'Доказательство' };

function Days({ days }: { days: number | null }) {
  const d = daysBox(days);
  return <div className={`days ${d.tone}`}><b>{d.value}</b><span>{d.caption}</span></div>;
}

/**
 * Один слайд экрана мониторинга (релиз 1.1.0) — так же на стене и в предпросмотре настроек.
 * page — страница длинного списка, per — строк на странице (по размеру экрана).
 */
export function SlideView({ slide, page, per }: { slide: MonitorSlide; page: number; per: number }) {
  const pages = pagesOf(slide, per);
  const d = slide.data;
  return (
    <div className="mon-slide" data-slide={slide.kind} aria-label={`Слайд «${slide.title}»`}>
      <div className="mon-slide-h">
        <h2>{slide.title}</h2>
        {pages > 1 && <span className="mono pg">стр. {page + 1} из {pages}</span>}
      </div>
      {slide.empty ? (
        <div className="mon-empty" data-testid="slide-empty">{emptyText(slide)}</div>
      ) : d.kind === 'kpis' ? (
        <div className="mon-kpis mon-kpis-big" aria-label="Ключевые показатели">
          {d.items.map((k) => (
            <div key={k.key} className={`mk ${k.tone ?? ''}`} data-kpi={k.key}>
              <div className="l" title={k.label}>{k.label}</div>
              <div className="v">{k.value ?? '—'}</div>
              <div className="src">{k.source}</div>
            </div>
          ))}
        </div>
      ) : d.kind === 'vulns' && d.vulns ? (
        <VulnsSlide vulns={d.vulns} page={page} per={per} />
      ) : d.kind === 'items' ? (
        <section className="mp">
          <div className="mp-b">
            {pageOf<MonitorItem>(d.items, per, page).items.map((o) => (
              <div key={`${o.kind}:${o.id}`} className="mrow mrow-2">
                <Days days={o.days} />
                <div className="min0">
                  <div className="t1">{o.title}</div>
                  <div className="t2">{KIND_NAMES[o.kind]} · {o.sub} · до {dateRu(o.due)}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : d.kind === 'dlp' && d.widget ? (
        <section className="mp mon-dlp">
          <div className="mp-b">
            <div className="mon-dlp-total"><b>{num(d.widget.total)}</b><span>{d.widget.stats[0]?.label ?? 'без основания'}</span></div>
            <div className="bars">
              {d.widget.rows.map((r) => (
                <div key={r.label} className="bar">
                  <span className="t" title={r.label}>{r.label}</span>
                  <span className="track"><span className={`fill${r.tone ? ` c-${r.tone}` : ''}`} style={{ width: `${barWidth(r.count, d.widget?.rows ?? [])}%` }} /></span>
                  <span className="n">{r.count}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      ) : (
        <div className="mon-empty">{emptyText(slide)}</div>
      )}
    </div>
  );
}

function VulnsSlide({ vulns, page, per }: { vulns: NonNullable<Extract<MonitorSlide['data'], { kind: 'vulns' }>['vulns']>; page: number; per: number }) {
  const list = pageOf<MonitorVuln>(vulns.items, per, page);
  return (
    <div className="mon-main mon-main-2">
      <section className="mp" aria-label="Уязвимости: дни до срока устранения">
        <div className="mp-b">
          {list.items.map((v) => (
            <div key={v.id} className="mrow">
              <Days days={v.days} />
              <div className="min0">
                <div className="t1">{v.title} <span>{v.pkg}</span></div>
                <div className="t2">{v.desc}</div>
              </div>
              <div className="mr">
                {v.crit && <span className={`chip ${v.crit.tone ?? ''}`}>{v.crit.label}</span>}
                <span className="mono">{v.hits ? `${v.hits} ПК · ` : ''}{v.due ? `до ${dateRu(v.due)}` : 'без срока'}</span>
              </div>
            </div>
          ))}
        </div>
      </section>
      <div className="mcol">
        <section className="mp" aria-label="Сроки устранения">
          <div className="mp-h"><span>Сроки устранения</span><span className="mono pg">{vulns.total} откр.</span></div>
          <div className="mp-b">
            <div className="bars">
              {vulns.buckets.map((b) => (
                <div key={b.key} className="bar">
                  <span className="t">{b.label}</span>
                  <span className="track"><span className={`fill${b.tone ? ` c-${b.tone}` : ''}`} style={{ width: `${barWidth(b.count, vulns.buckets)}%` }} /></span>
                  <span className="n">{b.count}</span>
                </div>
              ))}
            </div>
            <div className="mdates">
              {vulns.dates.map((d) => (
                <div key={d.date} className="md">
                  <span className="mono">{dateRu(d.date)}</span>
                  <span className={d.days < 0 ? 'neg' : d.days <= 7 ? 'warn' : ''}>{daysText(d.days)}</span>
                  <b className="mono">{d.count}</b>
                </div>
              ))}
            </div>
          </div>
        </section>
        <section className="mp" aria-label="Открытые по пакетам">
          <div className="mp-h"><span>Открытые по пакетам</span></div>
          <div className="mp-b">
            <div className="bars">
              {vulns.packages.map((p) => (
                <div key={p.label} className="bar">
                  <span className="t" title={p.label}>{p.label}</span>
                  <span className="track"><span className="fill" style={{ width: `${barWidth(p.count, vulns.packages)}%` }} /></span>
                  <span className="n">{p.count}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
