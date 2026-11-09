import { TONE_OPTIONS, type ToneKey } from './logic';
import { Select } from '../../components/Select';

export function ToneDot({ tone }: { tone: string | null }) {
  return <span className={`dot tone-${tone ?? 'muted'}`} aria-hidden="true" />;
}

export function ToneSelect({ value, onChange, id }: { value: ToneKey; onChange: (t: ToneKey) => void; id?: string }) {
  return (
    <Select id={id} className="inp" value={value} onChange={(e) => onChange(e.target.value as ToneKey)} aria-label="Цвет">
      {TONE_OPTIONS.map((t) => (
        <option key={t.tone} value={t.tone}>{t.label}</option>
      ))}
    </Select>
  );
}
