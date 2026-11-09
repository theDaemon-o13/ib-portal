import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { registersApi, RISK_REGISTER_KEY, type RegisterDetail, type RegisterField, type RegisterRecord } from '../../api/registers';
import type { FileInfo } from '../../api/files';
import { FilePreview } from '../../components/files/FilePreview';
import { FileUpload } from '../../components/files/FileUpload';
import { useToast } from '../../components/Toast';
import { formatDate } from './logic';
import { rkeys } from './keys';
import { Select } from '../../components/Select';

const DOC_KINDS = ['Служебная записка ОУР', 'Протокол риск-комитета', 'Письмо ОУР'];
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Решение другого отдела в карточке записи: текущее решение, внесение нового — только с файлом документа-основания,
 * номером и датой; история решений с просмотром документа. Решения только пополняются.
 */
export function DecisionBlock({ reg, f, rec, canEdit, onSaved }: {
  reg: RegisterDetail; f: RegisterField; rec: RegisterRecord; canEdit: boolean; onSaved: (r: RegisterRecord) => Promise<void> | void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const isRisk = reg.systemKey === RISK_REGISTER_KEY;
  const refField = isRisk ? reg.fields.find((x) => x.systemKey === 'ormRef') : undefined;
  const dueField = isRisk ? reg.fields.find((x) => x.systemKey === 'reviewDue') : undefined;
  const options = f.options.filter((o) => !o.archived);
  const choices = options.slice(1); // первый вариант — «Ожидает решения»
  const hist = useQuery({ queryKey: [...rkeys.decisions(rec.id), f.id], queryFn: () => registersApi.decisions(rec.id, f.id) });
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const [form, setForm] = useState({
    optionId: choices[0]?.id ?? '', documentTitle: DOC_KINDS[0] ?? '', documentNumber: '', documentDate: today(),
    externalRef: refField ? String(rec.values[refField.id] ?? '') : '', reviewDue: '',
  });
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const d = rec.decisions[f.id];

  const save = useMutation({
    mutationFn: () => registersApi.addDecision(rec.id, {
      recordVersion: rec.version, fieldId: f.id, optionId: form.optionId,
      documentTitle: form.documentTitle, documentNumber: form.documentNumber, documentDate: form.documentDate,
      fileId: files[0]?.id ?? '',
      reviewDue: form.reviewDue || null,
      externalRef: refField ? form.externalRef || null : null,
    }),
    onSuccess: async (r) => {
      setOpen(false);
      setFiles([]);
      setError(null);
      await Promise.all([qc.invalidateQueries({ queryKey: rkeys.decisions(rec.id) }), qc.invalidateQueries({ queryKey: ['evidence'] })]);
      await onSaved(r);
      toast(`Решение «${r.display[f.id] ?? ''}» сохранено, документ добавлен в доказательную базу`);
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Решение не сохранено'),
  });
  const submit = (e: FormEvent | KeyboardEvent) => {
    e.preventDefault();
    if (!form.documentNumber.trim() || !form.documentDate) {
      setError('Укажите номер и дату документа');
      return;
    }
    if (!files[0]) {
      setError('Приложите документ-основание. Без него решение не сохраняется');
      return;
    }
    save.mutate();
  };
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  const preview = hist.data?.items.find((h) => h.id === shown);

  return (
    <div className="ro decision">
      <span className="chip info">{rec.display[f.id] ?? options[0]?.label ?? '—'}</span>
      {d && <small>{d.documentTitle} № {d.documentNumber} от {formatDate(d.documentDate)} · {d.decidedBy}{d.reviewDue ? ` · пересмотр до ${formatDate(d.reviewDue)}` : ''}</small>}
      {canEdit && !rec.archived && !open && (
        <div><button type="button" className="btn sm" onClick={() => setOpen(true)}>Внести решение</button></div>
      )}
      {open && (
        // Внутри формы записи: своя форма не вкладывается, Enter сохраняет решение, а не запись.
        <div className="decide" role="group" aria-label="Внести решение" onKeyDown={(e) => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') submit(e); }}>
          <div>
            <b className="w600">{f.label}</b>
            <div className="hint">Решение выносит другой отдел. Без файла документа решение не сохранится; документ попадёт в доказательную базу.</div>
          </div>
          <div className="fgrid">
            <label>Решение
              <Select className="inp" value={form.optionId} onChange={(e) => set({ optionId: e.target.value })}>
                {choices.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </Select>
            </label>
            <label>Документ-основание
              <input className="inp" list={`dk-${f.id}`} maxLength={300} value={form.documentTitle} onChange={(e) => set({ documentTitle: e.target.value })} />
              <datalist id={`dk-${f.id}`}>{DOC_KINDS.map((k) => <option key={k} value={k} />)}</datalist>
            </label>
            <label>№ документа<input className="inp" maxLength={100} value={form.documentNumber} onChange={(e) => set({ documentNumber: e.target.value })} /></label>
            <label>Дата документа<input className="inp" type="date" max={today()} value={form.documentDate} onChange={(e) => set({ documentDate: e.target.value })} /></label>
            {refField && <label>{refField.label}<input className="inp" maxLength={100} placeholder="ОР-2026-…" value={form.externalRef} onChange={(e) => set({ externalRef: e.target.value })} /></label>}
            <label>{dueField ? `${dueField.label} (по документу)` : 'Пересмотр до (если указан)'}<input className="inp" type="date" value={form.reviewDue} onChange={(e) => set({ reviewDue: e.target.value })} /></label>
          </div>
          <FileUpload label="Файл документа" multiple={false} accept=".pdf,.png,.jpg,.jpeg,.docx" allowed={['pdf', 'png', 'jpg', 'jpeg', 'docx']} value={files} onChange={setFiles} />
          {error && <div className="form-error" role="alert">{error}</div>}
          <div className="row">
            <button type="button" className="btn primary" disabled={save.isPending} onClick={submit}>Сохранить решение</button>
            <button type="button" className="btn" onClick={() => { setOpen(false); setError(null); }}>Отмена</button>
          </div>
        </div>
      )}
      {hist.data && hist.data.items.length > 0 && (
        <div className="hist">
          {hist.data.items.map((h) => (
            <div key={h.id}>
              {formatDate(h.decidedAt.slice(0, 10))} · {h.decidedBy}: «{h.label}» — {h.documentTitle} № {h.documentNumber} от {formatDate(h.documentDate)}{' '}
              <button type="button" className="btn ghost sm" aria-pressed={shown === h.id} onClick={() => setShown(shown === h.id ? null : h.id)}>{h.file.name}</button>
              {h.evidence && <> · <Link to={`/evidence?ev=${h.evidence.id}`}>доказательство #{h.evidence.number}</Link></>}
            </div>
          ))}
        </div>
      )}
      {preview && <FilePreview key={preview.file.id} file={preview.file} />}
    </div>
  );
}
