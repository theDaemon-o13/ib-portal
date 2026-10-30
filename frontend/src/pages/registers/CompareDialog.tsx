import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../api/client';
import {
  registersApi, type CompareResult, type CompareScope, type CompareStatusPreview, type RegisterDetail,
} from '../../api/registers';
import { Overlay } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { changesOf, plural, setForPicked } from './compare';
import { rkeys } from './keys';

type Step = 'scope' | 'result' | 'confirm';

/**
 * «Сравнение» из окна импорта (релиз 1.1.0, ADR-0017): какие открытые записи области есть в реестре, но нет
 * в файле. Ключ — из настроек реестра, область — обязательно. Статус — свой у строки или один у отмеченных;
 * дальше предпросмотр → подтверждение → журнал со ссылкой на файл.
 */
export function CompareDialog({ reg, importId, file, onClose }: {
  reg: RegisterDetail; importId: string; file: File;
  /** Отчёт сканера (этап Б.2): область по умолчанию — отдел отчёта и выбранная система. */
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const scopeFields = reg.fields.filter((f) => reg.compareScopeFieldIds.includes(f.id) && !f.archived);
  const keyLabel = reg.compareKeyFieldIds.length
    ? reg.compareKeyFieldIds.map((id) => reg.fields.find((f) => f.id === id)?.label ?? '?').join(' + ')
    : 'ID записи';
  const [step, setStep] = useState<Step>('scope');
  const [scopeField, setScopeField] = useState<string>(scopeFields[0]?.id ?? 'all');
  const [scopeValues, setScopeValues] = useState<ReadonlySet<string>>(new Set());
  const [result, setResult] = useState<CompareResult | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [choices, setChoices] = useState<Map<string, string>>(new Map());
  const [bulkStatus, setBulkStatus] = useState('');
  const [preview, setPreview] = useState<CompareStatusPreview | null>(null);
  const [changed, setChanged] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const field = scopeFields.find((f) => f.id === scopeField);
  const scope: CompareScope | null = scopeField === 'all' ? { all: true }
      : scopeValues.size ? { conditions: [{ fieldId: scopeField, values: [...scopeValues] }] } : null;
  const current = useMemo(() => new Map((result?.missing ?? []).map((m) => [m.id, m.statusId])), [result]);
  const changes = changesOf(choices, current);
  const statusLabel = (id: string | null) => result?.status?.options.find((o) => o.id === id)?.label ?? '—';

  const run = async <T,>(fn: () => Promise<T>, onOk: (v: T) => void) => {
    setBusy(true);
    setError(null);
    try {
      onOk(await fn());
    } catch (e) {
      const fresh = e instanceof ApiError && e.code === 'BULK_CHANGED' ? (e.details?.preview as CompareStatusPreview | undefined) : undefined;
      if (fresh) {
        setPreview(fresh);
        setChanged(true);
      } else {
        setError(e instanceof Error ? e.message : 'Не удалось выполнить');
      }
    } finally {
      setBusy(false);
    }
  };

  const doCompare = () => scope && void run(() => registersApi.compare(importId, file, scope), (r) => {
    setResult(r);
    setPicked(new Set());
    setChoices(new Map());
    setStep('result');
  });
  const doPreview = () => scope && void run(() => registersApi.compareStatusPreview(reg.id, { importId, scope, changes, reason: reason || null }), (p) => {
    setPreview(p);
    setChanged(false);
    setStep('confirm');
  });
  const doApply = () => scope && preview && void run(() => registersApi.compareStatusApply(reg.id, {
    importId, scope, changes, reason: reason || null, expected: { willChange: preview.willChange },
  }), (r) => {
    void qc.invalidateQueries({ queryKey: rkeys.records(reg.id) });
    void qc.invalidateQueries({ queryKey: rkeys.analytics(reg.id) });
    toast(`Статус изменён: ${plural(r.changed, 'запись', 'записи', 'записей')}${r.skipped ? `, пропущено ${r.skipped}` : ''}`);
    onClose();
  });

  const toggle = (id: string) => setPicked((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  return (
    <Overlay>
      <div className="backdrop" role="presentation">
        <div className="modal panel bulk-dialog compare-dialog" role="dialog" aria-modal="true" aria-labelledby="cmp-title">
          <h2 id="cmp-title">Сравнение с реестром</h2>
          <p className="hint">Файл «{file.name}». Ключ: <b>{keyLabel}</b> (задаётся в настройках реестра). Новые и изменившиеся строки показывает предпросмотр импорта; здесь — записи, которых нет в файле.</p>

          {step === 'scope' && (
            <>
              <div className="grid-gap" role="radiogroup" aria-label="Область сравнения">
                <b>Область сравнения</b>
                {scopeFields.map((f) => (
                  <label key={f.id} className="check"><input type="radio" name="scope" checked={scopeField === f.id} onChange={() => { setScopeField(f.id); setScopeValues(new Set()); }} />
                    {' '}{f.systemKey === 'report' ? 'Конкретный прошлый отчёт' : f.label}
                  </label>
                ))}
                <label className="check"><input type="radio" name="scope" checked={scopeField === 'all'} onChange={() => setScopeField('all')} /> Весь реестр</label>
              </div>
              {field && (
                <div className="scope-values" aria-label={`Значения «${field.label}»`}>
                  {field.options.filter((o) => !o.archived).map((o) => (
                    <label key={o.id} className="check">
                      <input type="checkbox" checked={scopeValues.has(o.id)} onChange={() => setScopeValues((s) => {
                        const n = new Set(s);
                        if (n.has(o.id)) n.delete(o.id);
                        else n.add(o.id);
                        return n;
                      })} /> {o.label}
                    </label>
                  ))}
                </div>
              )}
              {scopeField === 'all' && <div className="note">Весь реестр: все открытые записи, которых нет в файле, попадут в «Нет в файле». Выбирайте, только если файл — полная выгрузка.</div>}
            </>
          )}

          {step === 'result' && result && (
            <>
              <div className="hint" data-testid="compare-summary">
                Сравнить с записями реестра: {result.scope.label}.
                {' '}Нет в файле: <b>{result.missing.length}</b>.
                {result.noKey > 0 && ` Без ключа (не сопоставлены): ${result.noKey}.`}
                {result.outOfScopeRows > 0 && ` Строк файла вне области: ${result.outOfScopeRows}.`}
                {result.badKeyRows > 0 && ` Строк файла без ключа: ${result.badKeyRows}.`}
              </div>
              {result.missing.length > 0 && result.status && (
                <div className="row">
                  <span className="hint">Статус отмеченным ({picked.size}):</span>
                  <select className="inp sm-inp" value={bulkStatus} onChange={(e) => setBulkStatus(e.target.value)} aria-label="Статус отмеченным">
                    <option value="">—</option>
                    {result.status.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                  <button className="btn sm" type="button" disabled={!picked.size || !bulkStatus} onClick={() => setChoices(setForPicked(choices, picked, bulkStatus))}>Проставить</button>
                </div>
              )}
              <div className="tbl-wrap compare-tbl">
                <table className="cat-tbl">
                  <thead>
                    <tr>
                      <th><input type="checkbox" aria-label="Отметить все" checked={result.missing.length > 0 && picked.size === result.missing.length}
                        onChange={(e) => setPicked(e.target.checked ? new Set(result.missing.map((m) => m.id)) : new Set())} /></th>
                      <th>№</th><th>Запись</th><th>Ключ</th><th>Сейчас</th><th>Новый статус</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.missing.length === 0 && <tr><td colSpan={6} className="hint">Всё, что есть в области, есть и в файле</td></tr>}
                    {result.missing.map((m) => (
                      <tr key={m.id} data-record={m.id}>
                        <td><input type="checkbox" aria-label={`Отметить запись ${m.number}`} checked={picked.has(m.id)} onChange={() => toggle(m.id)} /></td>
                        <td className="mono">{m.number}</td>
                        <td>{m.title}</td>
                        <td className="mono">{m.key}</td>
                        <td>{statusLabel(m.statusId)}</td>
                        <td>
                          <select className="inp sm-inp" value={choices.get(m.id) ?? ''} aria-label={`Новый статус записи ${m.number}`}
                            onChange={(e) => setChoices(new Map(choices).set(m.id, e.target.value))}>
                            <option value="">не менять</option>
                            {result.status?.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <label>Причина (для полей, которые меняются только с причиной)
                <input className="inp" value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} placeholder="Например: устранено по отчёту сканера от …" />
              </label>
            </>
          )}

          {step === 'confirm' && preview && (
            <div data-testid="compare-preview" className="grid-gap">
              <b>Изменится статус: {plural(preview.willChange, 'запись', 'записи', 'записей')}</b>
              {preview.skipped.length > 0 && (
                <div className="hint">Пропущено {preview.skipped.length}: {preview.skipped.slice(0, 10).map((s) => `${s.number ? `#${s.number} — ` : ''}${s.reason}`).join('; ')}</div>
              )}
              <div className="hint">В истории каждой записи и в журнале будет ссылка на файл «{file.name}».</div>
              {changed && <div className="note" role="status">Записи изменились, пока окно было открыто. Проверьте число и подтвердите ещё раз.</div>}
            </div>
          )}

          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="row end">
            {step === 'scope' && <>
              <button className="btn" type="button" onClick={onClose} disabled={busy}>Закрыть</button>
              <button className="btn primary" type="button" disabled={!scope || busy} onClick={doCompare}>{busy ? 'Сравниваем…' : 'Сравнить'}</button>
            </>}
            {step === 'result' && <>
              <button className="btn" type="button" onClick={() => setStep('scope')} disabled={busy}>Другая область</button>
              <button className="btn" type="button" onClick={onClose} disabled={busy}>Закрыть</button>
              <button className="btn primary" type="button" disabled={!changes.length || busy} onClick={doPreview}>Проставить статус ({changes.length})</button>
            </>}
            {step === 'confirm' && <>
              <button className="btn" type="button" onClick={() => setStep('result')} disabled={busy}>Назад</button>
              <button className="btn primary" type="button" disabled={!preview?.willChange || busy} onClick={doApply}>
                {busy ? 'Выполняется…' : 'Подтвердить'}
              </button>
            </>}
          </div>
        </div>
      </div>
    </Overlay>
  );
}
