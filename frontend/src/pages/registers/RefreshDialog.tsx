// «Обновить по сотрудникам» (1.8.0, docs/specs/awareness.md, раздел 5): записи «Не сопоставлен», которые теперь
// сопоставляются «Точно». Любую строку можно снять; применение — отмеченные, с числом строк предпросмотра
// (изменилось — сервер ответит 409, окно предложит перечитать).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { registersApi, type RegisterDetail } from '../../api/registers';
import { Overlay } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { rkeys } from './keys';

const ruDate = (iso: string | null) => (iso ? iso.split('-').reverse().join('.') : '—');

export function RefreshDialog({ reg, onClose }: { reg: RegisterDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const preview = useQuery({ queryKey: ['registers', 'awareness-refresh', reg.id], queryFn: () => registersApi.refreshPreview(reg.id), staleTime: 0 });
  const items = preview.data?.items ?? [];
  const [off, setOff] = useState<string[]>([]);
  const picked = items.filter((i) => !off.includes(i.recordId)).map((i) => i.recordId);
  const apply = useMutation({
    mutationFn: () => registersApi.refreshApply(reg.id, picked, preview.data?.total ?? 0),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: rkeys.records(reg.id) });
      toast(`Сопоставлено: ${r.updated}${r.skipped ? `, оставлено без изменений: ${r.skipped}` : ''}`);
      onClose();
    },
    onError: async (e) => {
      toast(e instanceof Error ? e.message : 'Не удалось применить', 'error');
      setOff([]);
      await preview.refetch();
    },
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !apply.isPending) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });
  return (
    <Overlay>
      <div className="backdrop" role="presentation">
        <div className="modal panel wide-modal" role="dialog" aria-modal="true" aria-labelledby="refresh-title" data-testid="awareness-refresh">
          <h2 id="refresh-title">Обновить по сотрудникам</h2>
          <p className="hint">
            Результаты «Не сопоставлен», для которых теперь нашёлся ровно один работающий сотрудник с тем же полным ФИО.
            Отмеченные получат связь, «Точно» и подразделение сотрудника. «Точно» и «Вручную» не меняются.
          </p>
          {preview.isPending && <div className="hint">Ищем…</div>}
          {preview.isError && <div className="hint">Не удалось загрузить: {preview.error instanceof Error ? preview.error.message : ''}</div>}
          {preview.isSuccess && items.length === 0 && <div className="hint">Сопоставлять нечего: новых совпадений нет</div>}
          {items.length > 0 && (
            <div className="tbl-wrap imp-errors">
              <table className="cat-tbl" aria-label="Что изменится">
                <thead><tr><th aria-label="Отметить" /><th>ФИО</th><th>Тест</th><th>Дата</th><th>Сотрудник</th><th>Подразделение</th></tr></thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.recordId} data-record={i.recordId}>
                      <td>
                        <input type="checkbox" aria-label={`Обновить ${i.fio}`} checked={!off.includes(i.recordId)}
                          onChange={(e) => setOff(e.target.checked ? off.filter((x) => x !== i.recordId) : [...off, i.recordId])} />
                      </td>
                      <td>{i.fio}</td>
                      <td className="min0"><div className="ellipsis" title={i.test}>{i.test}</div></td>
                      <td className="mono">{ruDate(i.date)}</td>
                      <td>#{i.employee.number} {i.employee.fio}</td>
                      <td>{i.deptFrom === i.deptTo ? i.deptTo || '—' : <>{i.deptFrom || '—'} → <b>{i.deptTo}</b></>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="row end">
            <button className="btn" type="button" onClick={onClose} disabled={apply.isPending}>Отмена</button>
            <button className="btn primary" type="button" onClick={() => apply.mutate()} disabled={!picked.length || apply.isPending || !preview.isSuccess}>
              {picked.length ? `Сопоставить: ${picked.length}` : 'Нечего применять'}
            </button>
          </div>
        </div>
      </div>
    </Overlay>
  );
}
