// Карточка записи, этап 8б: поле «Файл» (sha256 и дата загрузки, предпросмотр, фиксация), поле «Связь с записью»,
// статус основания (сверка с DLP) и обратные связи — записи других реестров, которые ссылаются на эту.
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { filesApi, formatSize, type FileInfo } from '../../api/files';
import { registersApi, type RegisterField, type RegisterRecord } from '../../api/registers';
import { FilePreview } from '../../components/files/FilePreview';
import { FileUpload } from '../../components/files/FileUpload';
import { useToast } from '../../components/Toast';
import { formatDateTime } from '../settings/logic';
import { BASIS_TONES, deadlineChip, isBasisRule } from './logic';

/** Подпись связанной записи: «#12 Иванов Иван Иванович», у закрытой — с меткой статуса «(уволен)» (1.8.0). */
export const linkText = (l: { number: number; title: string; closedLabel?: string | null }) =>
  `#${l.number}${l.title ? ` ${l.title}` : ''}${l.closedLabel ? ` (${l.closedLabel})` : ''}`;

/** Карточка записи по ссылке: /registers?record=<id>#<реестр>/records. */
export const recordHref = (registerId: string, recordId: string) => `/registers?record=${recordId}#${registerId}/records`;

/** Статус текста PDF для поиска: «текст не распознан» — поиск только по полям. */
function TextStatus({ fileId }: { fileId: string }) {
  const meta = useQuery({ queryKey: ['files', 'meta', fileId], queryFn: () => filesApi.meta(fileId), staleTime: 30_000 });
  const t = meta.data?.text;
  if (!t || t.status === 'text') return null;
  if (t.status === 'pending') return <span className="chip" title="Текст PDF извлекается для поиска">текст извлекается</span>;
  return <span className="chip high" title="В PDF нет текстового слоя (скан): по нему ищется только по полям записи и имени файла">текст не распознан, поиск только по полям</span>;
}

/**
 * Поле «Файл»: файлы прикладываются сразу (не через «Сохранить»). Пока статус записи фиксирует поле,
 * документ нельзя отвязать или заменить — только новой записью.
 */
export function FileField({ f, rec, canEdit, onChanged }: {
  f: RegisterField; rec: RegisterRecord | null; canEdit: boolean; onChanged: (r: RegisterRecord) => Promise<void>;
}) {
  const toast = useToast();
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<FileInfo[]>([]);
  const run = async (fn: () => Promise<RegisterRecord>, ok: string) => {
    setBusy(true);
    try {
      await onChanged(await fn());
      toast(ok);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Не удалось', 'error');
    } finally {
      setBusy(false);
    }
  };
  // Загруженные файлы сразу приложить к записи.
  useEffect(() => {
    if (!picked.length || !rec) return;
    const ids = picked.map((x) => x.id);
    setPicked([]);
    void run(() => registersApi.attachFiles(rec.id, rec.version, f.id, ids), ids.length > 1 ? `Приложено файлов: ${ids.length}` : 'Файл приложен');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- приложить ровно один раз на выбор файлов
  }, [picked]);
  if (!rec) return <div className="ro"><small>Файлы прикладываются после создания записи.</small></div>;
  const list = rec.files[f.id] ?? [];
  const locked = rec.locked[f.id] === 'locked' && list.length > 0;
  const editable = canEdit && !rec.archived && !locked;

  return (
    <div className="grid-gap" data-file-field={f.label}>
      {list.length === 0 && <small className="hint">Файлов нет</small>}
      {list.map((l) => (
        <div key={l.linkId} className="file-card">
          <div className="row nowrap">
            <b className="fn ellipsis" title={l.file.name}>{l.file.name}</b>
            <span className="hint">{formatSize(l.file.size)}</span>
            <TextStatus fileId={l.file.id} />
          </div>
          <div className="hint">
            Загружен {formatDateTime(l.file.uploadedAt)} · {l.file.uploadedBy.fullName} · sha256 <span className="mono sha" title={l.file.sha256}>{l.file.sha256}</span>
          </div>
          <div className="row">
            <button className="btn sm" type="button" onClick={() => setOpen(open === l.linkId ? null : l.linkId)}>{open === l.linkId ? 'Скрыть' : 'Просмотр'}</button>
            <button className="btn sm" type="button" onClick={() => void filesApi.save(l.file.id, l.file.name)}>Скачать</button>
            {editable && (
              <button className="btn ghost sm danger-t" type="button" disabled={busy}
                onClick={() => void run(() => registersApi.removeFile(rec.id, l.linkId, rec.version), `Файл «${l.file.name}» отвязан`)}>Отвязать</button>
            )}
          </div>
          {open === l.linkId && <FilePreview file={{ id: l.file.id, name: l.file.name, mime: l.file.mime, size: l.file.size }} />}
        </div>
      ))}
      {locked && <small className="row nowrap"><span className="chip">зафиксировано</span> Документ действующей записи не заменяется и не отвязывается — только новой записью.</small>}
      {editable && <FileUpload label={list.length ? 'Приложить ещё' : 'Приложить файл'} value={[]} onChange={setPicked} multiple={rec.locked[f.id] !== 'locked'} />}
    </div>
  );
}

/** Поле «Связь с записью»: выбранные записи — метками, поиск по связанному реестру. Значение — id через запятую. */
export function LinkField({ f, rec, value, onChange, disabled }: {
  f: RegisterField; rec: RegisterRecord | null; value: string; onChange: (v: string) => void; disabled: boolean;
}) {
  const ids = value ? value.split(',').filter(Boolean) : [];
  const [labels, setLabels] = useState<Record<string, string>>(() =>
    Object.fromEntries((rec?.links[f.id] ?? []).map((l) => [l.id, linkText(l)])));
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const target = useQuery({ queryKey: ['registers', 'detail', f.linkRegisterId], queryFn: () => registersApi.get(f.linkRegisterId ?? ''), enabled: !!f.linkRegisterId });
  const found = useQuery({
    queryKey: ['registers', 'link-search', f.linkRegisterId, debounced],
    queryFn: () => registersApi.records(f.linkRegisterId ?? '', { q: debounced }),
    enabled: !!f.linkRegisterId && debounced.length >= 1 && !disabled,
  });
  const title = target.data?.fields.find((x) => x.isTitle);
  const add = (r: RegisterRecord) => {
    setLabels({ ...labels, [r.id]: `#${r.number}${title ? ` ${r.display[title.id] ?? ''}` : ''}` });
    if (!ids.includes(r.id)) onChange([...ids, r.id].join(','));
    setQ('');
  };
  return (
    <div className="grid-gap">
      <div className="cover">
        {ids.map((id) => {
          const ref = rec?.links[f.id]?.find((l) => l.id === id);
          return (
            <span key={id} className="chip acc">
              {f.linkRegisterId && !ref?.deleted ? <Link to={recordHref(f.linkRegisterId, id)}>{labels[id] ?? 'запись'}</Link> : labels[id] ?? '(запись удалена)'}
              {!disabled && <button type="button" className="chip-x" aria-label={`Убрать ${labels[id] ?? ''}`} onClick={() => onChange(ids.filter((x) => x !== id).join(','))}>×</button>}
            </span>
          );
        })}
        {ids.length === 0 && <span className="hint">Не выбрано</span>}
      </div>
      {!disabled && (
        <>
          <input className="inp" type="search" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={`Найти в «${target.data?.name ?? 'реестре'}»: имя хоста, номер…`} aria-label={`Добавить в «${f.label}»`} />
          {debounced && (
            <div className="link-results">
              {found.data?.items.filter((r) => !ids.includes(r.id)).slice(0, 10).map((r) => (
                <button key={r.id} type="button" className="btn ghost sm" onClick={() => add(r)}>
                  + #{r.number} {title ? r.display[title.id] : ''}
                </button>
              ))}
              {found.isSuccess && found.data.items.filter((r) => !ids.includes(r.id)).length === 0 && <span className="hint">Ничего не найдено</span>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Статус основания: «есть основание — разрешение №, до» со ссылкой на разрешение. */
export function BasisField({ f, rec }: { f: RegisterField; rec: RegisterRecord | null }) {
  const b = rec?.basis[f.id];
  const rule = isBasisRule(f.calcRule) ? f.calcRule : null;
  if (!b) return <div className="ro"><small>Считается после сохранения записи.</small></div>;
  return (
    <div className="ro">
      <span className="row nowrap">
        <span className={`chip ${BASIS_TONES[b.state] ?? ''}`}>{b.text}</span>
        {b.permission && rule && <Link to={recordHref(rule.sourceRegisterId, b.permission.id)}>Открыть разрешение</Link>}
      </span>
      <small>Сверка по связи «Устройства» действующих разрешений, а не по ФИО. Только чтение.</small>
    </div>
  );
}

/** Обратные связи: например, разрешения в карточке устройства — со статусом и сроком. */
export function Backlinks({ recordId }: { recordId: string }) {
  const q = useQuery({ queryKey: ['registers', 'backlinks', recordId], queryFn: () => registersApi.backlinks(recordId) });
  const groups = q.data?.items ?? [];
  if (!groups.length) return null;
  return (
    <div>
      {groups.map((g) => (
        <div key={g.fieldId} className="grid-gap">
          <div className="eyebrow">{g.registerName}: ссылаются полем «{g.fieldLabel}»</div>
          <div className="hist">
            {g.items.map((r) => {
              const chip = deadlineChip(r.deadline);
              return (
                <div key={r.id} className="hist-item row nowrap">
                  <Link to={recordHref(g.registerId, r.id)}>#{r.number} {r.title}</Link>
                  {r.status && <span className={`chip ${r.closed ? '' : 'acc'}`}>{r.status}</span>}
                  {chip && !r.closed && <span className={`chip ${chip.cls}`}>{chip.text}</span>}
                  {r.archived && <span className="chip">В архиве</span>}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

