// Выбор связи в предпросмотре импорта (1.8.0, docs/specs/awareness.md, 7.2): строки, которые адаптер не сопоставил сам.
// У каждой — причина, кандидаты (однофамильцы) и поиск по реестру связи в области выбора («Работает» — открытые записи).
// Выбор не обязателен: строка без выбора останется «Не сопоставлен». Проверку делает backend при применении.
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { registersApi, type ImportChoices } from '../../api/registers';

export type ChoiceMap = Record<string, string | null>;

function Search({ registerId, onPick, onClose }: { registerId: string; onPick: (id: string, label: string) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const reg = useQuery({ queryKey: ['registers', 'detail', registerId], queryFn: () => registersApi.get(registerId) });
  // Область выбора — «Работает»: незакрытые записи реестра (state=open).
  const found = useQuery({
    queryKey: ['registers', 'choice-search', registerId, debounced],
    queryFn: () => registersApi.records(registerId, { q: debounced, filter: { state: 'open' } }),
    enabled: debounced.length >= 2,
  });
  const title = reg.data?.fields.find((f) => f.isTitle);
  const dept = reg.data?.fields.find((f) => f.systemKey === 'dept');
  return (
    <div className="choice-search grid-gap">
      <div className="row">
        <input className="inp" type="search" autoFocus placeholder="ФИО или табельный номер, от 2 символов" aria-label="Поиск сотрудника"
          value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn sm ghost" type="button" onClick={onClose}>Закрыть</button>
      </div>
      {debounced.length >= 2 && found.isSuccess && found.data.items.length === 0 && <div className="hint">Никого не нашлось среди работающих</div>}
      <div className="list">
        {found.data?.items.slice(0, 10).map((r) => {
          const label = `#${r.number} ${title ? r.display[title.id] ?? '' : ''}`;
          return (
            <button key={r.id} type="button" className="li li-link" onClick={() => onPick(r.id, label)}>
              <div className="min0"><div className="ellipsis">{label}</div>{dept && <div className="m">{r.display[dept.id] || '—'}</div>}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function ImportChoicesBlock({ choices, value, onChange }: { choices: ImportChoices; value: ChoiceMap; onChange: (v: ChoiceMap) => void }) {
  const [searching, setSearching] = useState<number | null>(null);
  // Подписи выбранных через поиск (у кандидатов подпись уже есть).
  const [found, setFound] = useState<Record<string, string>>({});
  const chosen = Object.values(value).filter(Boolean).length;
  return (
    <div className="grid-gap" data-block={choices.code} data-testid="import-choices">
      <div className="eyebrow">{choices.title}</div>
      {choices.hint && <p className="hint">{choices.hint}</p>}
      <div className="tbl-wrap imp-errors">
        <table className="cat-tbl" aria-label="Ручное сопоставление">
          <thead><tr><th>Строка</th><th>Из отчёта</th><th>Почему</th><th>Сотрудник</th></tr></thead>
          <tbody>
            {choices.rows.map((r) => {
              const key = String(r.row);
              const sel = value[key] ?? '';
              const options = [...r.candidates, ...Object.entries(found).filter(([id]) => id === sel && !r.candidates.some((c) => c.id === id)).map(([id, label]) => ({ id, label }))];
              return (
                <tr key={r.row} data-row={r.row}>
                  <td className="mono">{r.row}</td>
                  <td className="min0"><div>{r.title}</div>{r.detail && <div className="hint">{r.detail}</div>}</td>
                  <td><span className="chip">{r.reason}</span></td>
                  <td className="min0">
                    <div className="row">
                      <select className="inp" aria-label={`Сотрудник для строки ${r.row}`} value={sel}
                        onChange={(e) => onChange({ ...value, [key]: e.target.value || null })}>
                        <option value="">— не выбрано (останется «Не сопоставлен»)</option>
                        {options.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                      </select>
                      <button className="btn sm" type="button" onClick={() => setSearching(searching === r.row ? null : r.row)}>Найти…</button>
                    </div>
                    {searching === r.row && (
                      <Search registerId={choices.registerId} onClose={() => setSearching(null)}
                        onPick={(id, label) => { setFound({ ...found, [id]: label }); onChange({ ...value, [key]: id }); setSearching(null); }} />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="hint">Выбрано: {chosen} из {choices.rows.length}. Выбранные получат «Вручную» и подразделение сотрудника.</div>
    </div>
  );
}
