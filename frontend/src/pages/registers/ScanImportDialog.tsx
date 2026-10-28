import { Overlay } from '../../components/Overlay';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { registersApi, type RegisterDetail, type ScanPreview } from '../../api/registers';
import { settingsApi } from '../../api/settings';
import { useToast } from '../../components/Toast';
import { CompareDialog } from './CompareDialog';
import { rkeys } from './keys';
import { formatDate } from './logic';

const SHOW = 50;

/**
 * Отчёт сканера, шаг 1 → 2: предпросмотр (ничего не изменено), затем применение одной транзакцией.
 * Дата отчёта — из имени файла или вводится здесь; от даты передачи в ДИКТ считается срок (п. 7.2).
 */
export function ScanImportDialog({ reg, preview, file, onClose }: { reg: RegisterDetail; preview: ScanPreview; file: File | null; onClose: () => void }) {
  // «Сравнение» (релиз 1.1.0): поверх окна импорта; Escape закрывает только его.
  const [comparing, setComparing] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const s = preview.summary;
  const [reportDate, setReportDate] = useState(s.reportDate ?? '');
  const [notifiedDate, setNotifiedDate] = useState(s.reportDate ?? '');
  const [notifiedTouched, setNotifiedTouched] = useState(false);
  // Система отчёта: по ней метка «Владелец системы» находит, кому ставить задачи.
  const [systemId, setSystemId] = useState('');
  // Подсказка (этап Б.2): открытые записи отдела отчёта и выбранной системы, которых нет в отчёте.
  const hint = useQuery({ queryKey: ['registers', 'not-in-report', preview.id, systemId], queryFn: () => registersApi.notInReport(preview.id, systemId) });
  const systems = useQuery({ queryKey: ['settings', 'items', 'systems', 'active'], queryFn: () => settingsApi.items('systems', false) });
  const nothing = s.created + s.mergedChanged === 0;
  const dateMissing = !reportDate;
  const dateOrder = !!reportDate && !!notifiedDate && notifiedDate < reportDate;

  const apply = useMutation({
    mutationFn: () => registersApi.applyScan(preview.id, { reportDate: reportDate || null, notifiedDate: notifiedDate || null, systemId: systemId || null }),
    onSuccess: async (r) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: rkeys.records(reg.id) }),
        qc.invalidateQueries({ queryKey: rkeys.list }),
        qc.invalidateQueries({ queryKey: rkeys.detail(reg.id) }),
        qc.invalidateQueries({ queryKey: rkeys.scanReports(reg.id) }),
        qc.invalidateQueries({ queryKey: rkeys.events(reg.id) }),
      ]);
      toast(`Отчёт загружен: новых уязвимостей ${r.created}, уже были в реестре ${r.merged}${r.updated ? `, обновлено «Обнаружений» ${r.updated}` : ''}`);
      onClose();
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Не удалось применить', 'error'),
  });
  const cancel = async () => {
    try {
      await registersApi.cancelImport(preview.id);
    } catch {
      // не критично: предпросмотр сам устареет через 30 минут
    }
    onClose();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !apply.isPending && !comparing) void cancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  return (
    <Overlay>
    <div className="backdrop" role="presentation">
      <div className="modal panel wide-modal" role="dialog" aria-modal="true" aria-labelledby="scan-title">
        <h2 id="scan-title">Отчёт сканера → «{reg.name}»</h2>
        <p className="imp-kind">Файл распознан как <span className="chip info">Отчёт сканера</span> — листы «Хосты» и уязвимости.</p>
        <p className="hint">
          Файл «{s.fileName}», лист «{s.sheet}»{s.department ? `, ${s.department}` : ''}: строк {s.rows}, хостов {s.hostsCount}. Пока ничего не изменено.
        </p>
        <div className="row scan-dates">
          <label className="fd-label">Дата отчёта
            <input className="inp" type="date" required value={reportDate} aria-label="Дата отчёта"
              onChange={(e) => { setReportDate(e.target.value); if (!notifiedTouched) setNotifiedDate(e.target.value); }} />
          </label>
          <label className="fd-label">Передан в ДИКТ
            <input className="inp" type="date" value={notifiedDate} min={reportDate || undefined} aria-label="Дата передачи в ДИКТ"
              onChange={(e) => { setNotifiedDate(e.target.value); setNotifiedTouched(true); }} />
          </label>
          <span className="hint">
            {s.reportDate ? `Дата отчёта взята из имени файла: ${formatDate(s.reportDate)}.` : 'В имени файла нет даты — укажите её.'} Срок устранения считается от передачи в ДИКТ.
          </span>
        </div>
        <div className="row scan-dates">
          <label className="fd-label">Система
            <select className="inp" value={systemId} onChange={(e) => setSystemId(e.target.value)} aria-label="Система отчёта">
              <option value="">— не указана</option>
              {systems.data?.items.map((i) => <option key={i.id} value={i.id}>{i.value}{i.owner ? ` · владелец ${i.owner.fullName}` : ''}</option>)}
            </select>
          </label>
          <span className="hint">Ставится новым записям отчёта. По ней задачи «Владельцу системы» получает владелец из справочника «Системы».</span>
        </div>
        {dateMissing && <p className="form-error" role="alert">В имени файла нет даты отчёта. Укажите её — без даты отчёт не загрузить.</p>}
        {dateOrder && <p className="form-error" role="alert">Отчёт не мог быть передан в ДИКТ раньше, чем составлен.</p>}
        {hint.data && hint.data.count > 0 && (
          <div className="note" data-testid="not-in-report">
            {hint.data.count === 1 ? '1 запись' : `${hint.data.count} ${hint.data.count % 10 >= 2 && hint.data.count % 10 <= 4 && (hint.data.count % 100 < 12 || hint.data.count % 100 > 14) ? 'записи' : 'записей'}`} нет в этом отчёте ({hint.data.label}) — нажмите «Сравнение».
          </div>
        )}
        <div className="imp-kpis">
          <div><b className="mono">{s.created}</b><span>новых</span></div>
          <div><b className="mono">{s.merged}</b><span>уже в реестре</span></div>
          <div><b className="mono">{s.mergedChanged}</b><span>обновится «Обнаружений»</span></div>
          <div className={s.errorRows ? 'bad' : undefined}><b className="mono">{s.errorRows}</b><span>строк с ошибками</span></div>
        </div>
        {s.critCounts.length > 0 && (
          <div>
            <div className="eyebrow">Новые по критичности</div>
            <div className="cover">{s.critCounts.map((c) => <span key={c.key} className={`chip ${c.key === 'critical' ? 'crit' : c.key === 'medium' ? 'med' : c.key}`}>{c.label}: {c.count}</span>)}</div>
          </div>
        )}
        {s.newOptions.length > 0 && (
          <div className="hint">Добавятся значения списков: {s.newOptions.map((o) => `${o.field} — ${o.values.length}`).join('; ')}</div>
        )}
        {s.warnings.length > 0 && <ul className="warn-list">{s.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
        {s.inFileDuplicates > 0 && <div className="hint">В файле повторяются пары «CVE + пакет»: {s.inFileDuplicates}. Берётся максимум «Обнаружений».</div>}
        {s.duplicates.length > 0 && (
          <details className="grid-gap">
            <summary className="eyebrow">Дубли открытых записей — не создаются заново ({s.merged})</summary>
            <div className="tbl-wrap imp-errors">
              <table className="cat-tbl">
                <thead><tr><th>CVE / БДУ</th><th>Пакет</th><th>Запись</th><th>Обнаружений</th></tr></thead>
                <tbody>
                  {s.duplicates.slice(0, SHOW).map((d) => (
                    <tr key={d.recordId}>
                      <td className="mono">{d.cve}</td><td>{d.pkg}</td><td className="mono">#{d.number}</td>
                      <td className="mono">{d.hitsBefore === d.hitsAfter ? (d.hitsAfter ?? '—') : `${d.hitsBefore ?? '—'} → ${d.hitsAfter ?? '—'}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {s.duplicates.length > SHOW && <div className="hint">Показаны первые {SHOW}</div>}
          </details>
        )}
        {s.hosts.length > 0 && (
          <details className="grid-gap">
            <summary className="eyebrow">Хосты ({s.hostsCount})</summary>
            <div className="tbl-wrap imp-errors">
              <table className="cat-tbl">
                <thead><tr><th>Имя хоста</th><th>IP-адрес</th><th>ОС</th></tr></thead>
                <tbody>{s.hosts.map((h, i) => <tr key={i}><td>{h.name}</td><td className="mono">{h.ip}</td><td>{h.os}</td></tr>)}</tbody>
              </table>
            </div>
          </details>
        )}
        {s.errors.length > 0 && (
          <div className="grid-gap">
            <div className="eyebrow">Строки с ошибками — не будут загружены</div>
            <div className="tbl-wrap imp-errors">
              <table className="cat-tbl">
                <thead><tr><th>Строка</th><th>Колонка</th><th>Ошибка</th></tr></thead>
                <tbody>{s.errors.map((e, i) => <tr key={i}><td className="mono">{e.row}</td><td>{e.field ?? '—'}</td><td>{e.message}</td></tr>)}</tbody>
              </table>
            </div>
          </div>
        )}
        <div className="row end">
          <button className="btn" type="button" onClick={() => void cancel()} disabled={apply.isPending}>Отмена</button>
          {file && <button className="btn" type="button" onClick={() => setComparing(true)} disabled={apply.isPending}
            title="Какие открытые записи реестра есть в реестре, но нет в этом файле">Сравнение</button>}
          <button className="btn primary" type="button" onClick={() => apply.mutate()} disabled={dateMissing || dateOrder || apply.isPending}>
            {nothing ? 'Сохранить отчёт без новых записей' : `Загрузить: новых ${s.created}${s.mergedChanged ? `, обновить ${s.mergedChanged}` : ''}`}
          </button>
        </div>
      </div>
    </div>
    {comparing && file && <CompareDialog reg={reg} importId={preview.id} file={file} defaultScope={hint.data?.scope ?? null} defaultLabel={hint.data?.label ?? null} onClose={() => setComparing(false)} />}
    </Overlay>
  );
}
