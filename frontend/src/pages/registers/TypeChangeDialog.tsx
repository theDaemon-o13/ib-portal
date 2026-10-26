import { useEffect, useState } from 'react';
import { registersApi, type FieldType, type RegisterDetail, type RegisterField, type TypePreview } from '../../api/registers';
import { useAction } from '../settings/useAction';
import { TYPE_NAMES, typeTargets } from './logic';
import { rkeys } from './keys';

const KIND_TEXT: Record<TypePreview['kind'], string> = {
  empty: 'В поле нет данных — тип меняется без изменения записей.',
  to_text: 'Значения превратятся в текст как есть на экране. Обратно в прежний тип автоматически не вернуть.',
  from_text: 'Каждое значение должно распознаваться. Если хоть одно не подходит — тип не меняется.',
};

/** Смена типа поля: всегда с предпросмотром «изменится N записей». */
export function TypeChangeDialog({ reg, field, onClose }: { reg: RegisterDetail; field: RegisterField; onClose: () => void }) {
  const targets = typeTargets(field.type);
  const [to, setTo] = useState<FieldType>(targets[0] ?? 'text');
  const [preview, setPreview] = useState<TypePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    registersApi.previewType(field.id, to)
      .then((p) => { if (!cancelled) setPreview(p); })
      .catch((e: unknown) => { if (!cancelled) { setPreview(null); setError(e instanceof Error ? e.message : 'Не удалось'); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [field.id, to]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const apply = useAction(() => registersApi.changeType(field.id, field.version, to), {
    invalidate: [rkeys.detail(reg.id), rkeys.records(reg.id)],
    success: () => `Тип поля «${field.label}» изменён: ${TYPE_NAMES[field.type]} → ${TYPE_NAMES[to]}`,
    onDone: onClose,
  });
  const blocked = !preview || preview.errors.length > 0;

  return (
    <div className="backdrop" role="presentation">
      <div className="modal panel wide-modal" role="dialog" aria-modal="true" aria-labelledby="tc-title">
        <h2 id="tc-title">Сменить тип поля «{field.label}»</h2>
        <label className="grid-gap">
          <span className="eyebrow">{TYPE_NAMES[field.type]} →</span>
          <select className="inp" value={to} onChange={(e) => setTo(e.target.value as FieldType)} aria-label="Новый тип">
            {targets.map((t) => <option key={t} value={t}>{TYPE_NAMES[t]}</option>)}
          </select>
        </label>
        {loading && <div className="hint">Считаем…</div>}
        {error && <p className="form-error" role="alert">{error}</p>}
        {preview && !loading && (
          <div className="grid-gap">
            <div className="note"><b>Изменится записей: {preview.affected}.</b> {KIND_TEXT[preview.kind]}</div>
            {preview.newOptions.length > 0 && <div className="hint">Будут созданы значения списка: {preview.newOptions.join(', ')}</div>}
            {preview.samples.length > 0 && (
              <table className="cat-tbl">
                <thead><tr><th>Запись</th><th>Было</th><th>Станет</th></tr></thead>
                <tbody>{preview.samples.map((s) => <tr key={s.number}><td className="mono">#{s.number}</td><td>{s.from}</td><td>{s.to}</td></tr>)}</tbody>
              </table>
            )}
            {preview.errors.length > 0 && (
              <div className="grid-gap">
                <p className="form-error">Не распознаны значения в {preview.errors.length} записях — исправьте их и повторите:</p>
                <ul className="err-list">{preview.errors.slice(0, 20).map((e) => <li key={e.number}>#{e.number}: «{e.value}»</li>)}</ul>
              </div>
            )}
          </div>
        )}
        <div className="row end">
          <button className="btn" type="button" onClick={onClose}>Отмена</button>
          <button className="btn primary" type="button" disabled={blocked || apply.isPending || loading} onClick={() => apply.mutate(undefined)}>
            Сменить тип{preview ? ` (${preview.affected})` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
