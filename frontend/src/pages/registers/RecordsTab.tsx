import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent } from 'react';
import { registersApi, type ImportPreview, type RegisterDetail, type RegisterField, type RegisterRecord } from '../../api/registers';
import { useToast } from '../../components/Toast';
import { ImportDialog } from './ImportDialog';
import { isWritable, pinOffsets, visibleColumns } from './logic';
import { rkeys } from './keys';
import { RecordDrawer } from './RecordDrawer';

interface Col {
  key: string;
  label: string;
  field?: RegisterField;
}

const pinKey = (id: string) => `ibportal.registers.pin.${id}`;
function loadPin(id: string): number {
  try {
    const v = Number(window.localStorage.getItem(pinKey(id)));
    return Number.isInteger(v) && v >= 0 && v <= 4 ? v : 1;
  } catch {
    return 1;
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
  if (col.key === 'number') return <span className="mono">{rec.number}</span>;
  const f = col.field as RegisterField;
  const text = rec.display[f.id] ?? '';
  if (!text) return <span className="faint">—</span>;
  if (f.type === 'number' || f.type === 'date' || f.type === 'calc') return <span className="mono">{text}</span>;
  if (f.type === 'select' || f.type === 'decision') {
    const closed = f.isStatus && rec.closed;
    return <span className={`chip ${closed ? '' : f.isStatus ? 'acc' : 'info'}`}>{text}</span>;
  }
  return <span title={text}>{text}</span>;
}

export function RecordsTab({ reg, canEdit, canDelete }: { reg: RegisterDetail; canEdit: boolean; canDelete: boolean }) {
  const toast = useToast();
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'number', dir: 'desc' });
  const [archived, setArchived] = useState(false);
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
    queryKey: [...rkeys.records(reg.id), q, sort.key, sort.dir, archived],
    queryFn: ({ pageParam }) => registersApi.records(reg.id, { q, sort: sort.key, dir: sort.dir, includeArchived: archived, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];
  const total = query.data?.pages[0]?.total ?? 0;
  const cols: Col[] = [{ key: 'number', label: '№' }, ...visibleColumns(reg).map((f) => ({ key: f.id, label: f.label, field: f }))];

  // Закреплённые столбцы: отступ слева = сумма ширин предыдущих.
  useLayoutEffect(() => {
    const widths = headRefs.current.map((th) => th?.getBoundingClientRect().width ?? 0);
    setLefts(pinOffsets(widths, pin));
  }, [pin, rows.length, reg.version, q]);

  const sortBy = (c: Col) => {
    if (c.field && !isWritable(c.field.type)) return; // по вычисляемому сроку — на этапе 4
    setSort((s) => ({ key: c.key, dir: s.key === c.key && s.dir === 'desc' ? 'asc' : 'desc' }));
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

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      setPreview(await registersApi.previewImport(reg.id, file));
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
              <button className="btn" type="button" onClick={() => fileRef.current?.click()} disabled={busy}>Импорт из Excel</button>
              <input ref={fileRef} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(e) => void onFile(e)} aria-label="Файл импорта" />
            </>
          )}
          <button className="btn" type="button" onClick={() => void exportFile()} disabled={busy}>Экспорт в Excel</button>
          <span className="hint">Выгруженный файл после заполнения в ДИКТ обновляет записи по колонке ID. Перед применением — предпросмотр.</span>
        </div>
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
        <span className="hint mono">{rows.length} из {total}</span>
        {canEdit && <button className="btn primary sm" type="button" onClick={() => setOpen('new')}>Новая запись</button>}
      </div>
      <div className="tbl-wrap recs-wrap">
        <table className="recs">
          <thead>
            <tr>
              {cols.map((c, i) => {
                const sortable = !c.field || isWritable(c.field.type);
                const active = sort.key === c.key;
                return (
                  <th key={c.key} ref={(el) => { headRefs.current[i] = el; }} className={pinClass(i)} style={pinStyle(i)}
                    aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                    {sortable ? (
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
            {query.isSuccess && rows.length === 0 && <tr><td colSpan={cols.length} className="hint">{q ? 'Ничего не найдено' : 'Записей пока нет'}</td></tr>}
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
    </>
  );
}
