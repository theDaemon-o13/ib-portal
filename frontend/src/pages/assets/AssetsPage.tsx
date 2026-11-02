import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useOutletContext } from 'react-router-dom';
import { assetsApi, type AssetFact, type AssetSection } from '../../api/assets';
import type { Me } from '../../api/client';
import { formatDateTime } from '../settings/logic';
import { assessmentHref, factScore, groupBySection, sectionAnchor, STATUS_CHIP } from './logic';

/** Сколько записей показать сразу: у проверки рабочих станций их могут быть тысячи. */
const SHOWN = 50;

function RecordLine({ r }: { r: AssetFact['records'][number] }) {
  return (
    <li>
      {r.href ? <Link to={r.href}>{r.title}</Link> : r.title}
      {r.detail && <span className="hint"> — {r.detail}</span>}
    </li>
  );
}

function FactRow({ f }: { f: AssetFact }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const chip = STATUS_CHIP[f.status];
  const shown = all ? f.records : f.records.slice(0, SHOWN);
  return (
    <div className="hist-item" data-fact={f.code}>
      <div className="row">
        <span className={chip.cls}>{chip.label}</span>
        <b>{f.title}</b>
        {f.status !== 'no_data' && <span className="hint">{factScore(f)}</span>}
        {f.relatedSections.length > 0 && (
          <span className="hint">также раздел {f.relatedSections.map((s, i) => <span key={s}>{i > 0 && ', '}<Link to={{ hash: sectionAnchor(s) }}>{s}</Link></span>)}</span>
        )}
        {f.records.length > 0 && (
          <button type="button" className="btn ghost sm" onClick={() => setOpen(!open)}>
            {open ? 'Свернуть' : `Показать: ${f.records.length}`}
          </button>
        )}
      </div>
      {f.message && <div className="hint">{f.message}</div>}
      {f.warnings.map((w) => (
        <div key={w.message} className="hint" role="alert">
          ⚠ {w.message}{' '}
          {w.records.map((r, i) => <span key={r.id}>{i > 0 && ', '}{r.href ? <Link to={r.href}>{r.title}</Link> : r.title}</span>)}
        </div>
      ))}
      {open && (
        <>
          <ul>{shown.map((r) => <RecordLine key={r.id} r={r} />)}</ul>
          {!all && f.records.length > SHOWN && (
            <button type="button" className="btn ghost sm" onClick={() => setAll(true)}>Показать все: {f.records.length}</button>
          )}
        </>
      )}
    </div>
  );
}

/** Раздел методики: название, полный текст и проверки. Ссылка #sec-2.2 прокручивает к разделу и раскрывает текст. */
function SectionPanel({ code, info, facts, related, canAssess }: { code: string; info?: AssetSection; facts: AssetFact[]; related: AssetFact[]; canAssess: boolean }) {
  const { hash } = useLocation();
  const anchor = sectionAnchor(code);
  const linked = hash === `#${anchor}`;
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (linked) ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [linked]);
  return (
    <section ref={ref} id={anchor} className="panel" data-section={code}>
      <div className="panel-h">
        <h3>Раздел {code}{info && `. ${info.name}`}</h3>
        {info?.key && <span className="chip high">ключевой</span>}
      </div>
      {info && (
        <details className="sa-target" open={linked}>
          <summary>Что требует методика</summary>
          <p className="hint">Домен {info.domainNo}. {info.domainName}</p>
          <p><b>Целевое состояние</b>{'\n'}{info.target}</p>
          {info.levels.map((l) => <p key={l.level}><b>Уровень {l.level} · {l.name}</b>{'\n'}{l.criteria}</p>)}
          <div className="row">
            <Link className="btn ghost sm" to={{ hash: anchor }}>Ссылка на раздел</Link>
            {canAssess && <Link className="btn ghost sm" to={assessmentHref(info)}>Открыть в самооценке</Link>}
          </div>
        </details>
      )}
      <div className="panel-b">
        {facts.map((f) => <FactRow key={f.code} f={f} />)}
        {related.map((f) => <div key={f.code} className="hint">Проверка «{f.title}» показана в разделе <Link to={{ hash: sectionAnchor(f.section) }}>{f.section}</Link></div>)}
      </div>
    </section>
  );
}

/** Сверка активов: что не сходится между продуктами, компонентами, хостами, KSC, сканами, DLP и рисками. Только чтение. */
export function AssetsPage() {
  const me = useOutletContext<Me>();
  const checks = useQuery({ queryKey: ['assets', 'checks'], queryFn: assetsApi.checks });

  if (checks.isPending) return <div className="hint">Загрузка…</div>;
  if (checks.isError) return <div className="hint" role="alert">{checks.error.message}</div>;
  const { items, sections, registers } = checks.data;
  const at = items[0]?.calculatedAt;
  return (
    <div className="stack">
      <div className="row">
        {registers.services && <Link className="btn sm" to={`/registers/${registers.services}/records`}>Сервисы</Link>}
        {registers.components && <Link className="btn sm" to={`/registers/${registers.components}/records`}>Компоненты</Link>}
        {registers.hosts && <Link className="btn sm" to={`/registers/${registers.hosts}/records`}>Хосты</Link>}
        {at && <span className="hint">Рассчитано {formatDateTime(at)}</span>}
      </div>
      {groupBySection(items).map((g) => (
        <SectionPanel key={g.section} code={g.section} info={sections.find((s) => s.code === g.section)} facts={g.facts} related={g.related} canAssess={me.permissions.includes('assessment.manage')} />
      ))}
    </div>
  );
}
