import { useState } from 'react';
import { registersApi, type FieldType, type RegisterDetail } from '../../api/registers';
import { useAction } from '../settings/useAction';
import { rkeys } from './keys';
import { Select } from '../../components/Select';

// Те же типы, что проверяет backend (structure.service.ts: COMPARE_KEY_TYPES, COMPARE_SCOPE_TYPES).
const KEY_TYPES: readonly FieldType[] = ['text', 'number', 'date', 'select', 'catalog', 'user'];
const SCOPE_TYPES: readonly FieldType[] = ['select', 'catalog'];

/**
 * Настройки «Сравнения с реестром» (релиз 1.1.0): ключ — до трёх полей по порядку (пусто — по ID записи),
 * поля, по которым выбирается область. При сравнении ключ только показывается.
 */
export function CompareSettings({ reg }: { reg: RegisterDetail }) {
  const live = reg.fields.filter((f) => !f.archived);
  const [key, setKey] = useState<string[]>([...reg.compareKeyFieldIds, '', '', ''].slice(0, 3));
  const [scope, setScope] = useState<ReadonlySet<string>>(new Set(reg.compareScopeFieldIds));
  const save = useAction(() => registersApi.update(reg.id, {
    version: reg.version, compareKeyFieldIds: key.filter(Boolean), compareScopeFieldIds: [...scope],
  }), { invalidate: [rkeys.detail(reg.id)], success: () => 'Настройки сравнения сохранены' });
  const setKeyAt = (i: number, v: string) => setKey(key.map((k, j) => (j === i ? v : k)));
  return (
    <details className="panel-b cmp-settings" aria-label="Сравнение с реестром">
      <summary className="eyebrow">Сравнение с реестром</summary>
      <div className="hint">Ключ сопоставляет строки файла с записями (например, «CVE / БДУ + Пакет» или имя хоста); без ключа — по колонке ID. Область сравнения выбирается при сравнении по одному из отмеченных полей или «Весь реестр».</div>
      <div className="row">
        <span className="hint">Ключ:</span>
        {key.map((k, i) => (
          <Select key={i} className="inp sm-inp" value={k} aria-label={`Поле ключа ${i + 1}`} onChange={(e) => setKeyAt(i, e.target.value)}>
            <option value="">{i === 0 ? '— по ID записи' : '—'}</option>
            {live.filter((f) => KEY_TYPES.includes(f.type) && (f.id === k || !key.includes(f.id))).map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </Select>
        ))}
      </div>
      <div className="row">
        <span className="hint">Область по полям:</span>
        {live.filter((f) => SCOPE_TYPES.includes(f.type)).map((f) => (
          <label key={f.id} className="check">
            <input type="checkbox" checked={scope.has(f.id)} onChange={() => setScope((s) => {
              const n = new Set(s);
              if (n.has(f.id)) n.delete(f.id);
              else n.add(f.id);
              return n;
            })} /> {f.label}
          </label>
        ))}
      </div>
      <div className="row"><button className="btn primary sm" type="button" disabled={save.isPending} onClick={() => save.mutate(undefined)}>Сохранить</button></div>
    </details>
  );
}
