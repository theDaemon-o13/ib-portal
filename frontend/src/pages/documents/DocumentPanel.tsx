import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { docsApi, dkeys, type DocDetail, type DocResult } from '../../api/documents';
import { settingsApi } from '../../api/settings';
import { LockIcon } from '../../components/LockIcon';
import { useToast } from '../../components/Toast';
import { formatDate } from '../registers/logic';
import { formatDateTime } from '../settings/logic';
import { historyText, reviewLabel, STATUS_TONE, versionLabel } from './logic';

/** Ошибки, после которых карточку нужно перечитать: документ успели изменить или он ушёл на другой этап. */
const STALE = new Set(['VERSION_CONFLICT', 'STAGE_CHANGED', 'NOT_IN_ROUTE']);

type Mode = 'view' | 'return' | 'edit' | 'revise' | 'settings';

interface ContentDraft {
  title: string;
  edition: string;
  onlyofficeUrl: string;
  changeNote: string;
}

const contentOf = (v: DocDetail['current']): ContentDraft => ({ title: v.title, edition: v.edition, onlyofficeUrl: v.onlyofficeUrl, changeNote: v.changeNote });

function ContentFields({ draft, setDraft, noteLabel }: { draft: ContentDraft; setDraft: (d: ContentDraft) => void; noteLabel: string }) {
  return (
    <>
      <label>Название<input className="inp" required maxLength={300} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>
      <div className="fgrid">
        <label>Редакция<input className="inp" maxLength={20} placeholder="например, 3.1" value={draft.edition} onChange={(e) => setDraft({ ...draft, edition: e.target.value })} /></label>
        <label>Ссылка на файл в OnlyOffice<input className="inp" type="url" required maxLength={2000} placeholder="https://" value={draft.onlyofficeUrl} onChange={(e) => setDraft({ ...draft, onlyofficeUrl: e.target.value })} /></label>
      </div>
      <label>{noteLabel}<textarea className="inp" maxLength={4000} value={draft.changeNote} onChange={(e) => setDraft({ ...draft, changeNote: e.target.value })} /></label>
    </>
  );
}

export function DocumentPanel({ id, onGone }: { id: string; onGone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const doc = useQuery({ queryKey: dkeys.detail(id), queryFn: () => docsApi.get(id), retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2 });
  const [mode, setMode] = useState<Mode>('view');
  const [comment, setComment] = useState('');
  const [content, setContent] = useState<ContentDraft | null>(null);
  const [settings, setSettings] = useState<{ typeId: string; ownerId: string; reviewMonths: number } | null>(null);
  const [stale, setStale] = useState<string | null>(null);
  const d = doc.data;

  const types = useQuery({ queryKey: dkeys.types, queryFn: () => settingsApi.items('document_types', false), enabled: mode === 'settings' });
  const people = useQuery({ queryKey: ['settings', 'userOptions'], queryFn: settingsApi.userOptions, enabled: mode === 'settings' });

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: dkeys.all }), qc.invalidateQueries({ queryKey: ['tasks'] })]);
  const done = async (r: DocResult, text: string) => {
    setMode('view');
    setComment('');
    await refresh();
    toast(text);
    // Документ вам больше не виден (например, юрист вернул его на доработку) — снять выбор.
    if (!r.document) onGone();
  };
  const onError = (e: unknown) => {
    if (e instanceof ApiError && STALE.has(e.code)) {
      setStale(e.message);
      return;
    }
    toast(e instanceof Error ? e.message : 'Не удалось выполнить действие', 'error');
  };
  const reload = async () => {
    setStale(null);
    setMode('view');
    await refresh();
  };

  const stage = d?.working?.stage ?? 0;
  const at = { version: d?.version ?? 0, stage };
  const submit = useMutation({ mutationFn: () => docsApi.submit(id, at), onSuccess: (r) => done(r, 'Документ отправлен на согласование'), onError });
  const approve = useMutation({
    mutationFn: () => docsApi.approve(id, at),
    onSuccess: (r) => done(r, stage === 3 ? 'Документ утверждён' : `Этап «${d?.stageName ?? ''}» согласован`),
    onError,
  });
  const back = useMutation({ mutationFn: () => docsApi.return(id, { ...at, comment }), onSuccess: (r) => done(r, 'Документ возвращён автору на доработку'), onError });
  const save = useMutation({
    mutationFn: (c: ContentDraft) => docsApi.update(id, { version: at.version, ...c }),
    onSuccess: (r) => done(r, 'Черновик сохранён'),
    onError,
  });
  const revise = useMutation({
    mutationFn: (c: ContentDraft) => docsApi.revise(id, { version: at.version, ...c }),
    onSuccess: (r) => done(r, `Создана версия ${r.document?.current.no ?? ''}: отправьте её на согласование`),
    onError,
  });
  const saveSettings = useMutation({
    mutationFn: (s: { typeId: string; ownerId: string; reviewMonths: number }) => docsApi.update(id, { version: at.version, ...s }),
    onSuccess: (r) => done(r, 'Документ сохранён'),
    onError,
  });
  const archive = useMutation({
    mutationFn: () => (d?.archived ? docsApi.restore(id, at.version) : docsApi.archive(id, at.version)),
    onSuccess: (r) => done(r, r.document?.archived ? 'Документ в архиве' : 'Документ возвращён из архива'),
    onError,
  });
  const busy = submit.isPending || approve.isPending || back.isPending || save.isPending || revise.isPending || saveSettings.isPending || archive.isPending;

  if (doc.isError) {
    return <div className="panel-b form-error">{doc.error instanceof ApiError && doc.error.status === 404 ? 'Документ не найден или вам не виден' : doc.error.message}</div>;
  }
  if (!d) return <div className="panel-b hint">Загрузка…</div>;

  const startEdit = (m: 'edit' | 'revise') => {
    setContent(m === 'revise' ? { ...contentOf(d.current), changeNote: '' } : contentOf(d.current));
    setMode(m);
  };
  const onContent = (e: FormEvent) => {
    e.preventDefault();
    if (!content) return;
    if (mode === 'revise') revise.mutate(content);
    else save.mutate(content);
  };
  const nextNo = Math.max(0, ...d.versions.map((v) => v.no)) + 1;

  return (
    <>
      <div className="panel-h">
        <h3>{d.title}</h3>
        <span className={`chip ${STATUS_TONE[d.status]}`}>{d.statusName}</span>
      </div>
      <div className="panel-b doc-detail">
        {stale && (
          <div className="note conflict" role="alert">
            {stale}
            <div className="row mt6"><button className="btn sm primary" type="button" onClick={() => void reload()}>Обновить документ</button></div>
          </div>
        )}
        <div className="row gap-lg">
          <div><div className="eyebrow">Версия</div><div className="mono">{versionLabel(d.current)}</div></div>
          <div><div className="eyebrow">Цикл пересмотра</div><div>{d.reviewMonths} мес.</div></div>
          <div><div className="eyebrow">Владелец</div><div>{d.owner.fullName}</div></div>
          <div><div className="eyebrow">Пересмотр до</div><div className={`mono${d.status === 'review_overdue' ? ' late-t' : ''}`}>{reviewLabel(d)}</div></div>
        </div>
        {d.working && d.approved && (
          <div className="hint">Действует версия {versionLabel(d.approved)} от {formatDate(d.approved.approvedAt?.slice(0, 10))}. Версия {d.working.no} — на этапе «{d.working.stageName}».</div>
        )}
        {d.archived && <div className="note ro"><LockIcon /><span>Документ в архиве: маршрут и пересмотр не ведутся.</span></div>}

        <div>
          <div className="eyebrow">Маршрут согласования{d.current.round > 1 ? ` · круг ${d.current.round}` : ''}</div>
          <div className="vsteps">
            {d.route.map((r) => (
              <div key={r.stage} className="vstep">
                <span className={`step${r.state === 'done' ? ' done' : r.state === 'current' ? ' cur' : ''}`} />
                <div>
                  <b>{r.name}</b>
                  <small title={r.hint}>{r.stage === 0 ? `Владелец: ${r.approvers.join(', ')}` : r.approvers.join(', ') || 'никто не назначен — выдайте право роли'}</small>
                </div>
                <small className="vr">
                  {r.actedBy
                    ? <>{r.stage === 0 ? 'отправил(а)' : 'согласовал(а)'}: {r.actedBy}<br />{formatDateTime(r.actedAt)}</>
                    : r.state === 'current' && !d.archived ? <b className="wait">ожидает</b> : null}
                </small>
              </div>
            ))}
          </div>
        </div>

        {mode === 'view' && (
          <div className="row">
            {d.can.submit && <button className="btn primary" type="button" disabled={busy} onClick={() => submit.mutate()}>Отправить на согласование</button>}
            {d.can.approve && <button className="btn primary" type="button" disabled={busy} onClick={() => approve.mutate()}>{stage === 3 ? 'Утвердить' : 'Согласовать этап'}</button>}
            {d.can.approve && <button className="btn" type="button" disabled={busy} onClick={() => setMode('return')}>Вернуть на доработку</button>}
            {d.can.edit && <button className="btn" type="button" disabled={busy} onClick={() => startEdit('edit')}>Изменить черновик</button>}
            {d.can.revise && <button className="btn" type="button" disabled={busy} onClick={() => startEdit('revise')}>Новая версия</button>}
            <a className="btn" href={d.current.onlyofficeUrl} target="_blank" rel="noopener noreferrer">Открыть в OnlyOffice</a>
          </div>
        )}
        {mode === 'view' && d.blockedReason && (
          <div className="note ro"><LockIcon /><span>{d.blockedReason}</span></div>
        )}

        {mode === 'return' && (
          <form className="task-form" onSubmit={(e) => { e.preventDefault(); back.mutate(); }}>
            <label>Что нужно исправить
              <textarea className="inp" required maxLength={4000} placeholder="Замечания для автора: они попадут в историю и в задачу автору" value={comment} onChange={(e) => setComment(e.target.value)} />
            </label>
            <div className="row">
              <button className="btn primary" type="submit" disabled={busy || !comment.trim()}>Вернуть автору</button>
              <button className="btn" type="button" onClick={() => setMode('view')}>Отмена</button>
            </div>
          </form>
        )}

        {(mode === 'edit' || mode === 'revise') && content && (
          <form className="task-form" onSubmit={onContent} aria-label={mode === 'revise' ? 'Новая версия' : 'Черновик'}>
            {mode === 'revise' && (
              <div className="hint">Версия {nextNo} пройдёт маршрут заново. Пересмотр без изменений — тоже новая версия. Версия {d.approvedVersionNo} действует, пока новую не утвердят.</div>
            )}
            <ContentFields draft={content} setDraft={setContent} noteLabel={mode === 'revise' ? 'Что изменено (необязательно)' : 'Что изменено'} />
            <div className="row">
              <button className="btn primary" type="submit" disabled={busy}>{mode === 'revise' ? `Создать версию ${nextNo}` : 'Сохранить'}</button>
              <button className="btn" type="button" onClick={() => setMode('view')}>Отмена</button>
            </div>
          </form>
        )}

        {mode === 'settings' && settings && (
          <form className="task-form" aria-label="Тип, владелец и цикл" onSubmit={(e) => { e.preventDefault(); saveSettings.mutate(settings); }}>
            <div className="fgrid">
              <label>Тип документа
                <select className="inp" value={settings.typeId} onChange={(e) => setSettings({ ...settings, typeId: e.target.value })}>
                  {!types.data?.items.some((t) => t.id === d.type.id) && <option value={d.type.id}>{d.type.value}</option>}
                  {types.data?.items.map((t) => <option key={t.id} value={t.id}>{t.value}</option>)}
                </select>
              </label>
              <label>Владелец
                <select className="inp" value={settings.ownerId} onChange={(e) => setSettings({ ...settings, ownerId: e.target.value })}>
                  {!people.data?.items.some((p) => p.id === d.owner.id) && <option value={d.owner.id}>{d.owner.fullName}</option>}
                  {people.data?.items.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
                </select>
              </label>
              <label>Цикл пересмотра, мес.
                <input className="inp" type="number" min={1} max={60} required value={settings.reviewMonths} onChange={(e) => setSettings({ ...settings, reviewMonths: Number(e.target.value) })} />
              </label>
            </div>
            <div className="row">
              <button className="btn primary" type="submit" disabled={busy}>Сохранить</button>
              <button className="btn" type="button" onClick={() => setMode('view')}>Отмена</button>
            </div>
          </form>
        )}

        {d.versions.length > 0 && (
          <div>
            <div className="eyebrow">Версии</div>
            <div className="hist">
              {d.versions.map((v) => (
                <div key={v.no} className="hist-item">
                  <div>
                    <a href={v.onlyofficeUrl} target="_blank" rel="noopener noreferrer">Версия {versionLabel(v)}</a>
                    {' · '}{v.approvedAt ? `утверждена ${formatDate(v.approvedAt.slice(0, 10))}` : 'в работе'}
                  </div>
                  {v.changeNote && <div className="m">{v.changeNote}</div>}
                </div>
              ))}
            </div>
          </div>
        )}

        {d.history.length > 0 && (
          <div>
            <div className="eyebrow">История согласования</div>
            <div className="hist">
              {d.history.map((h) => (
                <div key={h.id} className={`hist-item${h.decision === 'returned' ? ' returned' : ''}`}>
                  {formatDateTime(h.at)} · {h.actor}: {historyText(h)}
                </div>
              ))}
            </div>
          </div>
        )}

        {d.can.manage && mode === 'view' && (
          <div className="row dr-actions">
            {!d.archived && (
              <button className="btn sm" type="button" disabled={busy} onClick={() => { setSettings({ typeId: d.type.id, ownerId: d.owner.id, reviewMonths: d.reviewMonths }); setMode('settings'); }}>
                Тип, владелец, цикл
              </button>
            )}
            <button className="btn sm" type="button" disabled={busy} onClick={() => archive.mutate()}>{d.archived ? 'Вернуть из архива' : 'В архив'}</button>
          </div>
        )}
        <div className="hint">За 30 дней до даты пересмотра владельцу ставится задача «Пересмотреть документ».</div>
      </div>
    </>
  );
}
