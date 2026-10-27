import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent } from 'react';
import {
  registersApi, VULN_REGISTER_KEY, type ImportPreview, type RegisterDetail, type RegisterField, type RegisterRecord, type ScanPreview,
} from '../../api/registers';
import { useToast } from '../../components/Toast';
import { ImportDialog } from './ImportDialog';
import { deadlineChip, deadlineFieldOf, formatDate, optionTone, pinOffsets, visibleColumns } from './logic';
import { rkeys } from './keys';
import { RecordDrawer } from './RecordDrawer';
import { ScanImportDialog } from './ScanImportDialog';

interface Col {
  key: string;
  label: string;
  field?: RegisterField;
}

/** Колонка контроля сроков (не поле реестра): сортировка «срочное сначала» на сервере. */
const DEADLINE_KEY = 'deadline';

const pinKey = (id: string) => `ibportal.registers.pin.${id}`;
/** По умолчанию закреплены 2 столбца, как в прототипе. */
export const DEFAULT_PIN = 2;
export function parsePin(raw: string | null): number {
  if (raw === null || raw.trim() === '') return DEFAULT_PIN;
  const v = Number(raw);
  return Number.isInteger(v) && v >= 0 && v <= 4 ? v : DEFAULT_PIN;
}
function loadPin(id: string): number {
  try {
    return parsePin(window.localStorage.getItem(pinKey(id)));
  } catch {
    return DEFAULT_PIN;
  }
}
function savePin(id: string, n: number) {
  try {
    window.localStorage.setItem(pinKey(id), String(n));
  } catch {
    // хранилище недоступно — выбор просто не запомнится
  }
}

function Cell({ rec, col }: { rec: RegisterRecord; col: Col }) {
  if (col.key === 'number') {
    return (
      <span className="mono">
        {rec.number}
        {rec.openTasks > 0 && <span className="ev-dot" title={`Открытых задач по записи: ${rec.openTasks}`} aria-label={`задач: ${rec.openTasks}`}>{rec.openTasks}</span>}
      </span>
    );
  }
  if (col.key === DEADLINE_KEY) {
    const chip = deadlineChip(rec.deadline);
    if (!chip) return <span className="faint">—</span>;
    return <span className={`chip ${chip.cls}`} title={rec.deadline?.date ? `Срок: ${formatDate(rec.deadline.date)}` : undefined}>{chip.text}</span>;
  }
  const f = col.field as RegisterField;
  const text = rec.display[f.id] ?? '';
  if (!text) return <span className="faint">—</span>;
  if (f.type === 'number' || f.type === 'date' || f.type === 'calc') return <span className="mono">{text}</span>;
  if (f.type === 'catalog') return <span className="chip">{text}</span>;
  if (f.type === 'select' || f.type === 'decision') {
    const closed = f.isStatus && rec.closed;
    const tone = optionTone(f.options.find((o) => o.id === rec.values[f.id]));
    const manual = rec.manualFieldIds.includes(f.id);
    return (
      <span className={`chip ${closed ? '' : tone ?? (f.isStatus ? 'acc' : 'info')}`} title={manual ? 'Исправлено вручную' : undefined}>
        {text}{manual ? ' ✎' : ''}
      </span>
    );
  }
  return <span title={text}>{text}</span>;
}

/** Загруженные отчёты сканера: отдел · дата · хостов · уязвимостей, внутри — хосты. */
function ScanReports({ registerId }: { registerId: string }) {
  const reports = useQuery({ queryKey: rkeys.scanReports(registerId), queryFn: () => registersApi.scanReports(registerId) });
  const items = reports.data?.items ?? [];
  if (!items.length) return null;
  return (
    <div className="scan-reports">
      {items.map((r) => (
        <details key={r.id} className="scan-report">
          <summary>
            <b>{r.label}</b>
            <span className="hint"> · хостов: {r.hostsCount} · уязвимостей в отчёте: {r.rowsTotal} · новых: {r.createdCount} · передан в ДИКТ {formatDate(r.notifiedDate)}</span>
          </summary>
          <div className="tbl-wrap">
            <table className="cat-tbl">
              <thead><tr><th>Хост</th><th>IP-адрес</th><th>ОС</th></tr></thead>
              <tbody>{r.hosts.map((h, i) => <tr key={i}><td>{h.name}</td><td className="mono">{h.ip}</td><td>{h.os}</td></tr>)}</tbody>
            </table>
          </div>
        </details>
      ))}
    </div>
  );
}

export function RecordsTab({ reg, canEdit, canDelete }: { reg: RegisterDetail; canEdit: boolean; canDelete: boolean }) {
  const toast = useToast();
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const deadline = deadlineFieldOf(reg);
  const isVulns = reg.systemKey === VULN_REGISTER_KEY;
  // Реестр со сроками открывается «срочное сначала», как в прототипе.
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' }>(deadline ? { key: DEADLINE_KEY, dir: 'asc' } : { key: 'number', dir: 'desc' });
  const [archived, setArchived] = useState(false);
  const [withTasks, setWithTasks] = useState(false);
  const [scanPreview, setScanPreview] = useState<ScanPreview | null>(null);
  const [pin, setPin] = useState(() => loadPin(reg.id));
  const [open, setOpen] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const headRefs = useRef<(HTMLTableCellElement | null)[]>([]);
  const [lefts, setLefts] = useState<number[]>([]);

  // Поиск — после паузы в наборе.
  useEffect(() => {
    const t = setTimeout(() => setQ(qInput.trim()), 300);
    return () => clearTimeout(t);
  }, [qInput]);

  const query = useInfiniteQuery({
    queryKey: [...rkeys.records(reg.id), q, sort.key, sort.dir, archived, withTasks],
    queryFn: ({ pageParam }) => registersApi.records(reg.id, { q, sort: sort.key, dir: sort.dir, includeArchived: archived, withTasks, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];
  const total = query.data?.pages[0]?.total ?? 0;
  const fieldCols = visibleColumns(reg).map((f): Col => ({ key: f.id, label: f.label, field: f }));
  // «Дней до срока» — сразу после заголовка записи.
  const cols: Col[] = [
    { key: 'number', label: '№' },
    ...fieldCols.slice(0, 1),
    ...(deadline ? [{ key: DEADLINE_KEY, label: 'Дней до срока' }] : []),
    ...fieldCols.slice(1),
  ];

  // Закреплённые столбцы: отступ слева = сумма ширин предыдущих.
  useLayoutEffect(() => {
    const widths = headRefs.current.map((th) => th?.getBoundingClientRect().width ?? 0);
    setLefts(pinOffsets(widths, pin));
  }, [pin, rows.length, reg.version, q]);

  // Вычисляемые поля и сроки сортируются на сервере; решение другого отдела — нет.
  const sortable = (c: Col) => !c.field || c.field.type !== 'decision';
  const sortBy = (c: Col) => {
    if (!sortable(c)) return;
    const first = c.key === DEADLINE_KEY ? 'asc' : 'desc';
    setSort((s) => ({ key: c.key, dir: s.key === c.key ? (s.dir === 'asc' ? 'desc' : 'asc') : first }));
  };

  const exportFile = async () => {
    setBusy(true);
    try {
      const { blob, fileName } = await registersApi.exportFile(reg.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast(`Выгружено: ${fileName}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Не удалось выгрузить', 'error');
    } finally {
      setBusy(false);
    }
  };

  // Одна кнопка «Импорт из Excel»: отчёт сканера или выгрузку реестра распознаёт backend.
  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const p = await registersApi.previewFile(reg.id, file);
      if (p.format === 'scan') setScanPreview(p.scan);
      else setPreview(p.records);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Не удалось прочитать файл', 'error');
    } finally {
      setBusy(false);
    }
  };

  const pinStyle = (i: number) => (i < lefts.length ? { left: lefts[i] } : undefined);
  const pinClass = (i: number) => (i < pin ? `pin${i === pin - 1 ? ' pin-last' : ''}` : undefined);

  return (
    <>
      <div className="io panel-b">
        <div className="row">
          {canEdit && (
            <>
              <button className={isVulns ? 'btn primary' : 'btn'} type="button" onClick={() => fileRef.current?.click()} disabled={busy}>Импорт из Excel</button>
              <input ref={fileRef} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(e) => void onFile(e)} aria-label="Файл импорта" />
            </>
          )}
          <button className="btn" type="button" onClick={() => void exportFile()} disabled={busy}>Экспорт в Excel</button>
          <span className="hint">
            {isVulns ? 'Отчёт сканера (листы «Хосты» и уязвимости, дата в имени файла) или выгрузка реестра — тип файла определяется сам. ' : ''}
            Выгруженный файл после заполнения в ДИКТ обновляет записи по колонке ID. Перед применением — предпросмотр.
          </span>
        </div>
        {isVulns && <ScanReports registerId={reg.id} />}
      </div>
      <div className="rec-tools">
        <input className="inp" type="search" placeholder="Поиск по реестру" value={qInput} onChange={(e) => setQInput(e.target.value)} aria-label="Поиск по реестру" />
        <label className="hint" htmlFor="rec-pin">Закрепить столбцов</label>
        <select id="rec-pin" className="inp" value={pin} onChange={(e) => { const n = Number(e.target.value); setPin(n); savePin(reg.id, n); }}>
          {[0, 1, 2, 3, 4].map((n) => (
            <option key={n} value={n}>{n === 0 ? 'нет' : `${n}: ${cols.slice(0, n).map((c) => c.label).join(', ')}`}</option>
          ))}
        </select>
        <label className="check"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> С архивными</label>
        <label className="check"><input type="checkbox" checked={withTasks} onChange={(e) => setWithTasks(e.target.checked)} /> С задачами</label>
        <span className="hint mono">{rows.length} из {total}</span>
        {canEdit && <button className="btn primary sm" type="button" onClick={() => setOpen('new')}>Новая запись</button>}
      </div>
      <div className="tbl-wrap recs-wrap">
        <table className="recs">
          <thead>
            <tr>
              {cols.map((c, i) => {
                const canSort = sortable(c);
                const active = sort.key === c.key;
                return (
                  <th key={c.key} ref={(el) => { headRefs.current[i] = el; }} className={pinClass(i)} style={pinStyle(i)}
                    aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                    {canSort ? (
                      <button type="button" className="th-sort" onClick={() => sortBy(c)}>
                        {c.label}{active ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                      </button>
                    ) : c.label}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {query.isPending && <tr><td colSpan={cols.length} className="hint">Загрузка…</td></tr>}
            {query.isError && <tr><td colSpan={cols.length} className="form-error">{query.error.message}</td></tr>}
            {query.isSuccess && rows.length === 0 && <tr><td colSpan={cols.length} className="hint">{q || withTasks ? 'Ничего не найдено' : 'Записей пока нет'}</td></tr>}
            {rows.map((rec) => (
              <tr key={rec.id} className={`rec-row${rec.closed ? ' closed' : ''}${rec.archived ? ' archived' : ''}`} tabIndex={0}
                title="Открыть карточку записи" onClick={() => setOpen(rec.id)}
                onKeyDown={(e) => { if (e.key === 'Enter') setOpen(rec.id); }}>
                {cols.map((c, i) => <td key={c.key} className={pinClass(i)} style={pinStyle(i)}><Cell rec={rec} col={c} /></td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {query.hasNextPage && (
        <div className="panel-b"><button className="btn sm" type="button" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>Показать ещё</button></div>
      )}
      {open && <RecordDrawer key={open} reg={reg} recordId={open === 'new' ? null : open} canEdit={canEdit} canDelete={canDelete} onClose={() => setOpen(null)} onCreated={(id) => setOpen(id)} />}
      {preview && <ImportDialog reg={reg} preview={preview} onClose={() => setPreview(null)} />}
      {scanPreview && <ScanImportDialog reg={reg} preview={scanPreview} onClose={() => setScanPreview(null)} />}
    </>
  );
}
