// Блок карточки записи (ADR-0030): база срока, каждое продление, решение п. 7.3, итог; сканы, где встречалась; перенос.
import { useQuery } from '@tanstack/react-query';
import { vkeys, vulnsApi } from '../../api/vulns';
import { formatDate } from '../registers/logic';
import type { VulnView } from './logic';
import { STATE_LABELS } from './logic';

const OUTCOME: Record<string, string> = {
  new: 'Новая', reopened: 'Повторно обнаружена', changed: 'Изменилась', unchanged: 'Без изменений', fixed: 'Отмечена устранённой', legacy: 'Прежний реестр',
};

export function VulnRecordBlock({ recordId, go }: { recordId: string; go: (v: VulnView) => void }) {
  const info = useQuery({ queryKey: vkeys.recordInfo(recordId), queryFn: () => vulnsApi.recordInfo(recordId) });
  const d = info.data;
  if (!d) return null;
  const st = STATE_LABELS[d.state];
  const base = d.deadline;
  return (
    <div className="grid-gap" data-testid="vuln-block">
      <div className="eyebrow">Срок в узле «{d.node.label}»{d.cycle > 1 ? `, цикл ${d.cycle}` : ''}</div>
      <div className="v-dlbox">
        <div className="ln">
          <span>Базовый срок {base.source === 'legacy' ? '(из прежнего реестра)' : base.source === 'procedure' ? `(передача ИКТ + ${base.days ?? '?'} дн.)` : ''}</span>
          <b className="mono">{base.base ? formatDate(base.base) : 'не начался'}</b>
        </div>
        {base.scan && (
          <div className="ln hint">
            <button className="btn ghost sm" type="button" onClick={() => go({ kind: 'scan', id: base.scan?.id as string })}>Скан {formatDate(base.scan.scanDate)}</button>
            <span>{base.scan.handedOverOn ? `передан ${formatDate(base.scan.handedOverOn)}` : 'не передан'}</span>
          </div>
        )}
        {d.extensions.map((e) => (
          <div key={e.id} className={`ln${e.active ? '' : ' off'}`}>
            <span>+{e.days} дн. · ОИКТ № {e.basisNumber} от {formatDate(e.basisDate)}{e.cancelledAt ? ` · отменено ${formatDate(e.cancelledAt.slice(0, 10))}` : ''}</span>
            <span className="mono">{formatDate(e.dueBefore)} → {formatDate(e.dueAfter)}</span>
          </div>
        ))}
        {base.decision && (
          <div className="ln"><span>Решение п. 7.3: {base.decision.measures}</span><span className="mono">{formatDate(base.decision.due)}</span></div>
        )}
        <div className="ln total">
          <span>Итог <span className={`chip ${st.tone}`}>{st.label}</span></span>
          <b className="mono">{base.final ? formatDate(base.final) : '—'}</b>
        </div>
      </div>
      {d.scans.length > 0 && (
        <>
          <div className="eyebrow">Сканы{d.firstScanDate ? `: впервые ${formatDate(d.firstScanDate)}` : ''}{d.lastScanDate ? `${d.firstScanDate ? ',' : ':'} последний раз ${formatDate(d.lastScanDate)}` : ''}</div>
          <div className="v-seen">
            {d.scans.map((s) => (
              <div key={s.id} className="row v-between">
                <button className="btn ghost sm" type="button" onClick={() => go({ kind: 'scan', id: s.id })}>Скан {formatDate(s.scanDate)}</button>
                <span className="hint">{OUTCOME[s.outcome] ?? s.outcome}{s.changes.length ? `: ${s.changes.map((c) => `${c.label} ${c.from || '—'} → ${c.to || '—'}`).join('; ')}` : ''}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
