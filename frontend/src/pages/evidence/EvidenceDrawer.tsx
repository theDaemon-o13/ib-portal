import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { evidenceApi, ekeys, type EvidenceDetail } from '../../api/evidence';
import type { FileInfo } from '../../api/files';
import { FilePreview } from '../../components/files/FilePreview';
import { FileUpload } from '../../components/files/FileUpload';
import { LockIcon } from '../../components/LockIcon';
import { DetailPanel } from '../../components/DetailPanel';
import { useToast } from '../../components/Toast';
import { formatDate } from '../registers/logic';
import { formatDateTime } from '../settings/logic';
import { resultText, STATE_TONE, validText } from './logic';

/** Куда ведёт объект доказательства. */
function objectLink(e: EvidenceDetail): string | null {
  if (e.object.type === 'document') return `/documents?doc=${e.object.id}`;
  if (e.object.type === 'record' && e.object.registerId) return `/registers?record=${e.object.id}#${e.object.registerId}/records`;
  return null;
}

/** Карточка доказательства: данные, поля формы со сверкой, файлы с просмотром, проверка ИБ, история. */
export function EvidenceDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const ev = useQuery({ queryKey: ekeys.detail(id), queryFn: () => evidenceApi.get(id) });
  const [fileIdx, setFileIdx] = useState(0);
  const [mode, setMode] = useState<'view' | 'reject' | 'add'>('view');
  const [comment, setComment] = useState('');
  const [added, setAdded] = useState<FileInfo[]>([]);
  const [stale, setStale] = useState(false);
  const e = ev.data;


  const done = async (r: EvidenceDetail, text: string) => {
    qc.setQueryData(ekeys.detail(id), r);
    setMode('view');
    setComment('');
    setAdded([]);
    await Promise.all([qc.invalidateQueries({ queryKey: ekeys.all }), qc.invalidateQueries({ queryKey: ['tasks'] })]);
    toast(text);
  };
  const onError = (err: unknown) => {
    if (err instanceof ApiError && (err.code === 'VERSION_CONFLICT' || err.code === 'NOT_PENDING')) {
      setStale(true);
      return;
    }
    toast(err instanceof Error ? err.message : 'Не удалось выполнить действие', 'error');
  };
  const v = e?.version ?? 0;
  const accept = useMutation({ mutationFn: () => evidenceApi.review(id, { version: v, decision: 'accept' }), onSuccess: (r) => done(r, r.validUntil ? `Доказательство принято, действует до ${formatDate(r.validUntil)}` : 'Доказательство принято'), onError });
  const reject = useMutation({ mutationFn: () => evidenceApi.review(id, { version: v, decision: 'reject', comment }), onSuccess: (r) => done(r, 'Отклонено. Загрузившему создана задача на исправление'), onError });
  const addFiles = useMutation({ mutationFn: () => evidenceApi.addFiles(id, v, added.map((f) => f.id)), onSuccess: (r) => done(r, r.status === 'pending' && e?.status !== 'pending' ? 'Файл добавлен, доказательство снова на проверке' : 'Файл добавлен к доказательству'), onError });
  const removeFile = useMutation({ mutationFn: (fileId: string) => evidenceApi.removeFile(id, fileId, v), onSuccess: (r) => { setFileIdx(0); return done(r, 'Файл убран из доказательства'); }, onError });
  const archive = useMutation({
    mutationFn: () => (e?.archived ? evidenceApi.restore(id, v) : evidenceApi.archive(id, v)),
    onSuccess: (r) => done(r, r.archived ? 'Доказательство в архиве' : 'Доказательство возвращено из архива'),
    onError,
  });
  const busy = accept.isPending || reject.isPending || addFiles.isPending || removeFile.isPending || archive.isPending;
  const file = e?.fileList[Math.min(fileIdx, Math.max(0, (e?.fileList.length ?? 1) - 1))];
  const link = e ? objectLink(e) : null;

  return (
    <DetailPanel label="Доказательство" wide onClose={onClose} scrollKey={id}
      eyebrow={e ? <>{e.kindName}, #{e.number}</> : 'Доказательство'}
      title={e?.title ?? 'Загрузка…'}
      badges={e ? <><span className={`chip ${STATE_TONE[e.state]}`}>{e.stateName}</span>{e.archived && <span className="chip">в архиве</span>}</> : undefined}>
          {ev.isError && <div className="form-error">{ev.error.message}</div>}
          {stale && (
            <div className="note conflict" role="alert">
              Доказательство уже изменили или проверили. Обновите карточку.
              <div className="row mt6"><button className="btn sm primary" type="button" onClick={() => { setStale(false); void ev.refetch(); }}>Обновить</button></div>
            </div>
          )}
          {e && (
            <>
              {e.can.review && mode === 'view' && (
                <div className="row">
                  <button className="btn primary" type="button" disabled={busy} onClick={() => accept.mutate()}>Принять</button>
                  <button className="btn" type="button" disabled={busy} onClick={() => setMode('reject')}>Отклонить</button>
                  <span className="hint">Сверьте значения формы с приложенными файлами</span>
                </div>
              )}
              {e.reviewBlocked && <div className="note ro"><LockIcon /><span>{e.reviewBlocked}</span></div>}
              {mode === 'reject' && (
                <form className="task-form" onSubmit={(x) => { x.preventDefault(); reject.mutate(); }}>
                  <label>Что не так
                    <textarea className="inp" required maxLength={4000} placeholder="Комментарий увидит загрузивший: он попадёт в задачу на исправление" value={comment} onChange={(x) => setComment(x.target.value)} />
                  </label>
                  <div className="row">
                    <button className="btn primary" type="submit" disabled={busy || !comment.trim()}>Отклонить</button>
                    <button className="btn" type="button" onClick={() => setMode('view')}>Отмена</button>
                  </div>
                </form>
              )}

              <div className="meta-grid">
                <div><div className="eyebrow">Объект</div><div>{link ? <Link to={link}>{e.object.label}</Link> : e.object.label}</div></div>
                <div><div className="eyebrow">Основание</div><div>{e.basis || e.decision?.documentTitle || '—'}</div></div>
                <div><div className="eyebrow">Загрузил</div><div>{e.uploadedBy.fullName}</div></div>
                <div><div className="eyebrow">Подтвердил (ДИКТ)</div><div>{e.confirmedBy || '—'}</div></div>
                <div><div className="eyebrow">Дата загрузки</div><div className="mono">{formatDate(e.createdAt.slice(0, 10))}</div></div>
                <div><div className="eyebrow">Действует до</div><div className="mono">{validText(e)}</div></div>
                <div><div className="eyebrow">Ответственный</div><div>{e.owner.fullName}</div></div>
                <div><div className="eyebrow">Результат сверки</div><div>{resultText(e) ?? '—'}</div></div>
              </div>
              {e.reviewedBy && (
                <div className="hint">
                  {e.status === 'rejected' ? 'Отклонил' : 'Проверил'}: {e.reviewedBy.fullName}, {formatDateTime(e.reviewedAt)}{e.reviewComment ? ` — ${e.reviewComment}` : ''}
                </div>
              )}
              {e.decision && (
                <div className="note">
                  Решение «{e.decision.label}» по документу «{e.decision.documentTitle}» № {e.decision.documentNumber} от {formatDate(e.decision.documentDate)}
                  {e.decision.reviewDue ? `, пересмотр до ${formatDate(e.decision.reviewDue)}` : ''}.
                </div>
              )}

              {e.checks && (
                <div>
                  <div className="eyebrow">Поля формы</div>
                  <div className="tbl-wrap">
                    <table className="checks">
                      <thead><tr><th>Требование</th><th>Нужно</th><th>Указано</th><th aria-label="Соответствие" /></tr></thead>
                      <tbody>
                        {e.checks.map((c) => (
                          <tr key={c.fieldId}>
                            <td>{c.label}</td>
                            <td className="hint">{c.requirement}</td>
                            <td className="mono">{c.value || '—'}</td>
                            <td><span className={`mark ${c.ok ? 'ok' : 'no'}`} aria-label={c.ok ? 'соответствует' : 'не соответствует'}>{c.ok ? '✓' : '✕'}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <div>
                <div className="row sb mb6">
                  <span className="eyebrow">Файлы <span className="count">{e.fileList.length}</span></span>
                  {e.can.addFiles && mode === 'view' && <button className="btn sm" type="button" onClick={() => setMode('add')}>Добавить файл</button>}
                </div>
                {mode === 'add' && (
                  <form className="task-form" onSubmit={(x) => { x.preventDefault(); addFiles.mutate(); }}>
                    <FileUpload label="Файлы" value={added} onChange={setAdded} />
                    {e.status !== 'pending' && <div className="hint">Доказательство снова уйдёт на проверку.</div>}
                    <div className="row">
                      <button className="btn primary" type="submit" disabled={busy || !added.length}>Добавить</button>
                      <button className="btn" type="button" onClick={() => { setMode('view'); setAdded([]); }}>Отмена</button>
                    </div>
                  </form>
                )}
                <div className="file-list">
                  {e.fileList.map((f, i) => (
                    <span key={f.id} className={`file${f === file ? ' on' : ''}`}>
                      <button type="button" className="file-b" aria-pressed={f === file} onClick={() => setFileIdx(i)}>{f.name}</button>
                      {e.can.removeFiles && (
                        <button type="button" className="btn ghost sm" disabled={busy} aria-label={`Убрать ${f.name}`} onClick={() => removeFile.mutate(f.id)}>×</button>
                      )}
                    </span>
                  ))}
                </div>
                {file && <FilePreview key={file.id} file={file} />}
              </div>

              {/* История приходит только пользователю с правом «История в карточках» (ADR-0021). */}
              {e.history.length > 0 && (
                <div>
                  <div className="eyebrow">История</div>
                  <div className="hist">
                    {e.history.map((h) => <div key={h.id} className="hist-item"><div className="hist-meta"><b>{h.actor}</b><time>{formatDateTime(h.at)}</time></div><div>{h.summary}</div></div>)}
                  </div>
                </div>
              )}
              {e.can.archive && (
                <div className="row dr-actions">
                  <button className="btn sm" type="button" disabled={busy} onClick={() => archive.mutate()}>{e.archived ? 'Вернуть из архива' : 'В архив'}</button>
                </div>
              )}
            </>
          )}
    </DetailPanel>
  );
}
