import { RECORD_REASONS, type ReasonDraft } from '../api/trash';

/** Причина удаления записей (1.6.1): список и текст для «Другое». «Ложное срабатывание» — только у уязвимостей. */
export function ReasonPicker({ vuln, value, onChange, disabled }: {
  vuln: boolean; value: ReasonDraft; onChange: (v: ReasonDraft) => void; disabled?: boolean;
}) {
  return (
    <div className="reason-picker">
      <label>Причина удаления
        <select className="inp" value={value.code} disabled={disabled} aria-label="Причина удаления" required
          onChange={(e) => onChange({ ...value, code: e.target.value as ReasonDraft['code'] })}>
          <option value="" disabled>Выберите причину</option>
          {RECORD_REASONS.filter((r) => vuln || !r.vulnOnly).map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
        </select>
      </label>
      {value.code === 'other' && (
        <label>Опишите причину
          <textarea className="inp" maxLength={2000} value={value.text} disabled={disabled} aria-label="Описание причины"
            onChange={(e) => onChange({ ...value, text: e.target.value })} />
        </label>
      )}
    </div>
  );
}
