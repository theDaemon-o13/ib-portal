import { useQuery } from '@tanstack/react-query';
import { registersApi, type Widget } from '../../api/registers';
import { rkeys } from './keys';

const ROLE_SHORT: Record<string, string> = { dimension: 'группировка', metric: 'показатель', date: 'динамика', deadline: 'сроки' };
const KIND: Record<Widget['kind'], string> = { distribution: 'Распределение', metric: 'Показатель', timeline: 'Динамика по датам', deadline: 'Контроль сроков' };

const num = (n: number | null) => (n === null ? '—' : n.toFixed(1).replace('.', ','));

function Bars({ w }: { w: Widget }) {
  const rows = [...w.rows, ...(w.empty ? [{ label: 'Не заполнено', count: w.empty }] : [])];
  const max = Math.max(1, ...rows.map((r) => r.count));
  if (!rows.length) return <div className="hint">Нет значений</div>;
  return (
    <div className="bars">
      {rows.map((r) => (
        <div key={r.label} className="bar-row">
          <span className="bar-label" title={r.label}>{r.label}</span>
          {/* Ширина полосы — доля от максимума; задаётся через CSSOM, не инлайн-атрибутом. */}
          <span className="bar-track"><span className="bar-fill" style={{ width: `${(r.count / max) * 100}%` }} /></span>
          <span className="mono bar-n">{r.count}</span>
        </div>
      ))}
    </div>
  );
}

/** Правая колонка «Попадёт на дашборд»: виджеты по полям с ролью для аналитики, как в прототипе. */
export function DashboardPreview({ registerId }: { registerId: string }) {
  const q = useQuery({ queryKey: rkeys.analytics(registerId), queryFn: () => registersApi.analytics(registerId) });
  const items = q.data?.items ?? [];
  return (
    <div className="panel preview-col">
      <div className="panel-h"><h3>Попадёт на дашборд</h3><span className="sub">{items.length} виджет.</span></div>
      <div className="panel-b prev">
        {q.isSuccess && items.length === 0 && (
          <div className="hint">Ни одно поле не отмечено для аналитики. Выберите роль в колонке «Для аналитики».</div>
        )}
        {items.map((w) => (
          <div key={w.fieldId} className="prev-card">
            <div className="ttl"><span>{w.label}</span><span className="role-ic">{ROLE_SHORT[w.role] ?? w.role}</span></div>
            {w.kind === 'distribution' && <Bars w={w} />}
            {w.kind === 'metric' && (
              <div className="row gap-lg">
                <div><div className="eyebrow">Среднее</div><div className="mono big-n">{num(w.avg)}</div></div>
                <div><div className="eyebrow">Максимум</div><div className="mono big-n">{num(w.max)}</div></div>
              </div>
            )}
            {(w.kind === 'timeline' || w.kind === 'deadline') && <div className="hint">{KIND[w.kind]}: {w.label}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
