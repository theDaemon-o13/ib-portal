// «История»: все оценки, сравнение двух по разделам и итогу, журнал действий по открытой оценке (из audit_log,
// без права «История в карточках» — ADR-0026).
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { akeys, assessmentsApi, type Assessment, type AssessmentSummary } from '../../api/assessments';
import { dateRu } from '../dashboard/logic';
import { formatDateTime } from '../settings/logic';
import { LevelPill } from './Charts';
import { deltaTone, logText, shortTitle, signed, STATUS_TONE } from './logic';
import { Select } from '../../components/Select';

function Compare({ items, current }: { items: readonly AssessmentSummary[]; current: Assessment }) {
  // По умолчанию: прошлая оценка → открытая.
  const [aId, setA] = useState(current.previous?.id ?? items.find((x) => x.id !== current.id)?.id ?? current.id);
  const [bId, setB] = useState(current.id);
  const cmp = useQuery({ queryKey: akeys.compare(aId, bId), queryFn: () => assessmentsApi.compare(aId, bId) });
  const options = items.map((x) => <option key={x.id} value={x.id}>{x.title}{x.status === 'archived' ? ' · архив' : ''}</option>);
  const total = cmp.data ? cmp.data.b.total - cmp.data.a.total : 0;
  return (
    <section className="panel sa-w8">
      <div className="panel-h">
        <h3>Сравнение</h3>
        <div className="row">
          <Select className="inp sm-inp" aria-label="Первая оценка" value={aId} onChange={(e) => setA(e.target.value)}>{options}</Select>
          <span className="hint">→</span>
          <Select className="inp sm-inp" aria-label="Вторая оценка" value={bId} onChange={(e) => setB(e.target.value)}>{options}</Select>
        </div>
      </div>
      {cmp.isPending ? <div className="panel-b hint">Загрузка…</div>
        : cmp.isError ? <div className="panel-b hint">Не удалось сравнить: {cmp.error.message}</div> : (
          <div className="tbl-wrap sa-cmp">
            <table>
              <thead><tr><th>Раздел</th><th>{shortTitle(cmp.data.a.title)}</th><th>{shortTitle(cmp.data.b.title)}</th><th>Изменение</th></tr></thead>
              <tbody>
                {cmp.data.sections.map((s) => {
                  const d = s.a !== null && s.b !== null ? s.b - s.a : null;
                  return (
                    <tr key={s.code} data-code={s.code}>
                      <td><span className="sa-code">{s.code}</span> {s.name}</td>
                      {/* Раздела нет в первой оценке (другая методика, 1.13.8) — так и пишем, а не «—». */}
                      <td>{s.inA ? <LevelPill level={s.a} /> : <span className="hint">нет</span>}</td>
                      <td><LevelPill level={s.b} /></td>
                      <td className={`sa-delta ${deltaTone(d)}`}>{!s.inA ? 'нет в прошлой оценке' : d === null ? '—' : d === 0 ? 'без изменений' : signed(d)}</td>
                    </tr>
                  );
                })}
                <tr>
                  <td><b>Итого</b></td>
                  <td className="num"><b>{cmp.data.a.total}</b></td>
                  <td className="num"><b>{cmp.data.b.total}</b></td>
                  <td className={`sa-delta ${deltaTone(total)}`}>{signed(total)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}

function Journal({ a }: { a: Assessment }) {
  const log = useQuery({ queryKey: akeys.log(a.id), queryFn: () => assessmentsApi.log(a.id) });
  return (
    <section className="panel sa-w4">
      <div className="panel-h"><h3>Журнал: {shortTitle(a.title)}</h3></div>
      <div className="panel-b sa-log" data-testid="sa-journal">
        {log.isPending ? <div className="hint">Загрузка…</div>
          : log.isError ? <div className="hint">Не удалось загрузить журнал: {log.error.message}</div>
            : log.data.items.map((e) => <div key={e.id}><span>{formatDateTime(e.at)}</span>{logText(e.summary, a.title)} · {e.actor}</div>)}
      </div>
    </section>
  );
}

export function History({ a, items, onOpen, onArchive }: {
  a: Assessment;
  items: readonly AssessmentSummary[];
  onOpen: (id: string) => void;
  onArchive: (x: { id: string; title: string; version: number }) => void;
}) {
  return (
    <div className="sa-grid">
      <section className="panel sa-w12">
        <div className="panel-h"><h3>Оценки</h3></div>
        <div className="tbl-wrap">
          <table className="sa-list">
            <thead><tr><th>Оценка</th><th>Дата</th><th>Статус</th><th>Итог</th><th>Уровень</th><th>Зафиксирована</th><th /></tr></thead>
            <tbody>
              {items.map((x) => (
                <tr key={x.id} data-id={x.id}>
                  <td><b>{x.title}</b></td>
                  <td className="num">{dateRu(x.assessedOn)}</td>
                  <td><span className={`chip ${STATUS_TONE[x.status]}`}>{x.statusName}</span></td>
                  <td className="num"><b>{x.total}</b> / {x.max}{x.preliminary && <span className="hint"> · {x.answered}/{x.sections}</span>}</td>
                  <td>{x.level.name}{x.preliminary && <span className="hint"> · предварительно</span>}</td>
                  <td className="num">{x.finalizedAt ? formatDateTime(x.finalizedAt) : '—'}</td>
                  <td>
                    <div className="row sa-nowrap">
                      {x.id !== a.id ? <button className="btn sm" type="button" onClick={() => onOpen(x.id)}>Открыть</button> : <span className="hint">открыта</span>}
                      {x.status !== 'archived' && (
                        <button className="btn ghost sm" type="button" onClick={() => onArchive({ id: x.id, title: x.title, version: x.version })}>В архив</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {items.length > 1 ? <Compare key={a.id} items={items} current={a} /> : (
        <section className="panel sa-w8"><div className="panel-h"><h3>Сравнение</h3></div><div className="panel-b hint">Сравнение появится, когда оценок станет больше одной.</div></section>
      )}
      <Journal a={a} />
    </div>
  );
}
