// «Обновить сроки» (ADR-0030): дни по Уровню сканера, обоснование ОИКТ, предпросмотр «было → станет», применение.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { ApiError } from '../../api/client';
import type { FileInfo } from '../../api/files';
import { vkeys, vulnsApi, type Extension, type ExtensionPlan } from '../../api/vulns';
import { useFileViewer } from '../../components/files/FileViewer';
import { FileUpload } from '../../components/files/FileUpload';
import { useToast } from '../../components/Toast';
import { formatDate } from '../registers/logic';
import { Modal } from './Dialogs';
import { useTodayIso } from './today';

export function ExtensionDialog({ scope, onClose }: { scope: { nodeId?: string; groupId?: string }; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const today = useTodayIso();
  const [days, setDays] = useState<Record<string, string>>({});
  const [onlyOverdue, setOnlyOverdue] = useState(false);
  const [dueUntil, setDueUntil] = useState('');
  const [number, setNumber] = useState('');
  const [date, setDate] = useState('');
  const [comment, setComment] = useState('');
  const [file, setFile] = useState<FileInfo[]>([]);
  const [step, setStep] = useState<'form' | 'confirm'>('form');
  const [conflict, setConflict] = useState(false);

  const parsed = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(days)) if (v.trim() !== '') out[k] = Number(v);
    return out;
  }, [days]);
  const badDays = Object.values(parsed).some((d) => !Number.isInteger(d) || d < 0 || d > 365);
  const plan: ExtensionPlan = { ...scope, daysByLevel: badDays ? {} : parsed, onlyOverdue, dueUntil: dueUntil || null };
  const preview = useQuery({ queryKey: ['vulns', 'extension-preview', plan], queryFn: () => vulnsApi.previewExtension(plan) });
  const p = preview.data;
  const basisOk = number.trim() !== '' && !!date && date <= today && file.length === 1;
  const ready = !!p?.items.length && basisOk && !badDays;

  const apply = useMutation({
    mutationFn: () => vulnsApi.applyExtension({
      ...plan, basisNumber: number, basisDate: date, basisFileId: file[0]?.id ?? '', comment: comment || null, expected: p?.items.length ?? 0,
    }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: vkeys.all });
      toast(`Сроки продлены: записей ${r.records}`);
      onClose();
    },
    onError: async (e) => {
      if (e instanceof ApiError && e.code === 'BULK_CHANGED') {
        setConflict(true);
        setStep('form');
        await preview.refetch();
      }
    },
  });

  if (step === 'confirm' && p) {
    return (
      <Modal title="Подтвердите продление" sub={`${p.scopeLabel}. Обоснование ОИКТ № ${number} от ${formatDate(date)}.`} wide onClose={() => setStep('form')}
        footer={<>
          <button className="btn" type="button" onClick={() => setStep('form')} disabled={apply.isPending}>Назад</button>
          <button className="btn primary" type="button" disabled={apply.isPending} onClick={() => apply.mutate()}>Продлить: записей {p.items.length}</button>
        </>}>
        <div className="tbl-wrap v-list">
          <table className="cat-tbl">
            <thead><tr><th>Пакет / идентификатор</th><th>Уровень</th><th className="v-r">Дней</th><th>Было</th><th>Станет</th></tr></thead>
            <tbody>
              {p.items.map((i) => (
                <tr key={i.recordId}>
                  <td className="v-pk"><b>{i.pkg}</b><span>{i.cve} · #{i.number}</span></td>
                  <td>{i.level}</td><td className="v-r mono">+{i.days}</td>
                  <td className="mono">{formatDate(i.dueBefore)}</td><td className="mono"><b>{formatDate(i.dueAfter)}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {apply.error && !conflict && <p className="form-error" role="alert">{apply.error.message}</p>}
      </Modal>
    );
  }

  return (
    <Modal title="Обновить сроки" sub={`${p?.scopeLabel ?? ''}. Продление — только по обоснованию ОИКТ. Процедура не меняется, отмена — целиком.`} wide onClose={onClose}
      footer={<>
        <span className="hint v-grow">{ready ? `Запишем продление у записей: ${p?.items.length}` : 'Заполните дни и обоснование'}</span>
        <button className="btn" type="button" onClick={onClose}>Отмена</button>
        <button className="btn primary" type="button" disabled={!ready} onClick={() => { setConflict(false); setStep('confirm'); }}>Предпросмотр</button>
      </>}>
      {conflict && <div className="note" role="status">Записи изменились, пока окно было открыто. Проверьте число и подтвердите ещё раз.</div>}
      <div className="tbl-wrap">
        <table className="cat-tbl">
          <thead><tr><th>Уровень сканера</th><th className="v-r">Записей</th><th className="v-r">Дней (0–365)</th></tr></thead>
          <tbody>
            {p?.levels.map((l) => (
              <tr key={l.id}>
                <td>{l.label}</td><td className="v-r mono">{l.count}</td>
                <td className="v-r"><input className="inp v-days" type="number" min={0} max={365} step={1} aria-label={`Дни: ${l.label}`} value={days[l.id] ?? ''} onChange={(e) => setDays({ ...days, [l.id]: e.target.value })} /></td>
              </tr>
            ))}
            {p && !p.levels.length && <tr><td colSpan={3} className="hint">В области нет открытых записей с идущим сроком.</td></tr>}
          </tbody>
        </table>
      </div>
      {badDays && <p className="form-error" role="alert">Дни — целое число от 0 до 365.</p>}
      <div className="row">
        <label className="check"><input type="checkbox" checked={onlyOverdue} onChange={(e) => setOnlyOverdue(e.target.checked)} /> Только просроченные</label>
        <label className="fd-label">Только со сроком до
          <input className="inp" type="date" value={dueUntil} onChange={(e) => setDueUntil(e.target.value)} aria-label="Только со сроком до" />
        </label>
      </div>
      {p && (
        <p className="hint" data-testid="extension-summary">
          Продлится: <b>{p.items.length}</b>. Не участвуют: с решением п. 7.3 — {p.withDecision}, не переданы ИКТ — {p.notHandedOver}.
          {p.filteredOut > 0 && ` Не прошли фильтр: ${p.filteredOut}.`}{p.noChange > 0 && ` Окончание не меняется после переноса с выходного: ${p.noChange}.`}
        </p>
      )}
      <div className="eyebrow">Обоснование ОИКТ</div>
      <div className="row scan-dates">
        <label className="fd-label">Номер обращения
          <input className="inp" value={number} maxLength={100} onChange={(e) => setNumber(e.target.value)} aria-label="Номер обращения" />
        </label>
        <label className="fd-label">Дата
          <input className="inp" type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} aria-label="Дата обращения" />
        </label>
      </div>
      <FileUpload label="Файл обоснования" required multiple={false} value={file} onChange={setFile} />
      <label className="fd-label">Комментарий (по желанию)
        <input className="inp" value={comment} maxLength={2000} onChange={(e) => setComment(e.target.value)} aria-label="Комментарий" />
      </label>
      {preview.error && <p className="form-error" role="alert">{preview.error.message}</p>}
    </Modal>
  );
}

export function ExtensionList({ items, canManage }: { items: Extension[]; canManage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const viewer = useFileViewer();
  const [confirm, setConfirm] = useState<string | null>(null);
  const cancel = useMutation({
    mutationFn: (id: string) => vulnsApi.cancelExtension(id),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: vkeys.all });
      setConfirm(null);
      toast(`Продление отменено: сроки вернулись у записей — ${r.returned}`);
    },
    onError: (e) => toast(e.message, 'error'),
  });
  if (!items.length) return <div className="panel-b hint">Продлений не было.</div>;
  return (
    <>
      {items.map((x) => (
        <div key={x.id} className={`v-shift${x.cancelledAt ? ' cancel' : ''}`}>
          <div className="row v-between">
            <b>Обоснование ОИКТ № {x.basisNumber} от {formatDate(x.basisDate)}</b>
            {x.cancelledAt
              ? <span className="chip">Отменено {formatDate(x.cancelledAt.slice(0, 10))}</span>
              : canManage && confirm !== x.id && <button className="btn sm danger-t" type="button" onClick={() => setConfirm(x.id)}>Отменить</button>}
          </div>
          <div className="row">
            {x.days.map((d) => <span key={d.level} className="chip acc">{d.level} +{d.days} дн.</span>)}
            <span className="hint">записей {x.recordsCount} · {x.scope}{x.onlyOverdue ? ' · только просроченные' : ''}{x.dueUntil ? ` · срок до ${formatDate(x.dueUntil)}` : ''}</span>
          </div>
          <div className="row">
            <button className="btn ghost sm" type="button" onClick={() => void viewer.open({ id: x.basisFile.id, name: x.basisFile.name, mime: '' })}>{x.basisFile.name}</button>
            <span className="hint">{x.createdBy}, {formatDate(x.createdAt.slice(0, 10))}{x.comment ? ` · ${x.comment}` : ''}</span>
          </div>
          {confirm === x.id && (
            <div className="note row v-between">
              <span>Сроки записей вернутся к прежним (у записей в том же цикле). Событие останется с отметкой.</span>
              <span className="row">
                <button className="btn sm primary" type="button" disabled={cancel.isPending} onClick={() => cancel.mutate(x.id)}>Отменить продление</button>
                <button className="btn sm" type="button" onClick={() => setConfirm(null)}>Нет</button>
              </span>
            </div>
          )}
        </div>
      ))}
      {viewer.element}
    </>
  );
}
