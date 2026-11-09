// «Осведомлённость → Письма» (1.9.0; docs/specs/awareness.md, раздел 12): список с фильтрами (статус, тип, архив,
// поиск по названию и номеру), карточка письма — выезжающая панель (?letter=, шаг истории), «Новое письмо»,
// «Срочная рассылка».
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { awarenessApi, awarenessKeys, type LetterItem, type LetterKind, type LetterStatus } from '../../api/awareness';
import { ChipScroller } from '../../components/ChipScroller';
import { useToast } from '../../components/Toast';
import { FormDialog } from './FormDialog';
import { FromTemplateDialog } from './FromTemplateDialog';
import { KIND_NAME, letterMarks, newLetterStep, ruDateTime, STATUS_NAME, STATUS_TONE, type NewLetterStep } from './logic';
import { LetterPanel } from './LetterPanel';
import { TemplatePicker } from './TemplatePicker';

const STATUSES: LetterStatus[] = ['draft', 'review', 'approved', 'sent'];

type NewForm = { open: null | 'new' | 'urgent'; title: string; kind: LetterKind; reason: string; templateId: string };
const EMPTY: NewForm = { open: null, title: '', kind: 'planned', reason: '', templateId: '' };

export function LettersTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const selected = params.get('letter');
  const status = (params.get('status') as LetterStatus | null) ?? undefined;
  const kind = (params.get('kind') as LetterKind | null) ?? undefined;
  const archived = params.get('archive') === '1';
  const [search, setSearch] = useState('');
  const [nf, setNf] = useState<NewForm>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  // «Новое письмо» с выбранным шаблоном (1.13.2) — дальше «Письмо из шаблона» с ним.
  const [fromTpl, setFromTpl] = useState<Extract<NewLetterStep, { kind: 'fromTemplate' }> | null>(null);

  const list = useQuery({
    queryKey: [...awarenessKeys.letters, { status, kind, archived, search }],
    queryFn: () => awarenessApi.letters({ scope: archived ? 'archived' : 'active', status, kind, q: search.trim() || undefined }),
  });
  const templates = useQuery({ queryKey: awarenessKeys.templates, queryFn: () => awarenessApi.templates(), enabled: nf.open !== null });

  const setParam = useCallback((patch: Record<string, string | null>) => {
    setParams((p) => {
      const n = new URLSearchParams(p);
      for (const [k, v] of Object.entries(patch)) if (v === null) n.delete(k); else n.set(k, v);
      return n;
    }, { replace: true });
  }, [setParams]);
  // Выбор письма — шаг истории: «Назад» закрывает карточку.
  const select = useCallback((id: string | null) => {
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (id === null) n.delete('letter'); else n.set('letter', id);
      return n;
    }, { preventScrollReset: true });
  }, [setParams]);

  const create = useMutation({
    mutationFn: () => (nf.open === 'urgent'
      ? awarenessApi.urgent({ title: nf.title, reason: nf.reason, templateId: nf.templateId || null })
      : awarenessApi.createLetter({ title: nf.title, kind: nf.kind, ...(nf.kind === 'urgent' ? { reason: nf.reason } : {}) })),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: awarenessKeys.letters });
      await qc.invalidateQueries({ queryKey: ['tasks'] });
      toast(nf.open === 'urgent' ? `Письмо № ${r.letter.number} и задача «Срочная рассылка» созданы` : `Создано письмо № ${r.letter.number}`);
      r.warnings.forEach((w) => toast(w, 'warn'));
      setNf(EMPTY);
      select(r.letter.id);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Не удалось создать письмо'),
  });

  const items = list.data?.items ?? [];
  const open = (o: 'new' | 'urgent') => { setError(null); setNf({ ...EMPTY, open: o, kind: o === 'urgent' ? 'urgent' : 'planned' }); };

  const row = (l: LetterItem) => (
    <tr key={l.id} className={l.id === selected ? 'sel' : undefined} tabIndex={0} aria-selected={l.id === selected} data-letter={l.number}
      onClick={() => select(l.id)} onKeyDown={(e) => { if (e.key === 'Enter') select(l.id); }}>
      <td className="mono">№ {l.number}</td>
      <td>
        <div className="w500">{l.title}</div>
        <div className="row gap6 wrap">
          {letterMarks(l).map((m) => <span key={m} className="chip high">{m}</span>)}
          {l.template && <span className="hint">шаблон «{l.template.title}»</span>}
          {l.task && <span className="hint">задача #{l.task.number}</span>}
        </div>
      </td>
      <td><span className={`chip${l.kind === 'urgent' ? ' crit' : ''}`}>{KIND_NAME[l.kind]}</span></td>
      <td><span className={`chip ${STATUS_TONE[l.status]}`}>{STATUS_NAME[l.status]}</span></td>
      <td className="mono">{l.versionNo ?? '—'}</td>
      <td><div>{l.createdBy.fullName}</div><div className="hint">{ruDateTime(l.updatedAt)}</div></td>
    </tr>
  );

  return (
    <>
      <div className="row docs-bar">
        <ChipScroller label="Фильтр писем" className="toolbar-grow">
          <button type="button" aria-pressed={!status && !archived} onClick={() => setParam({ status: null, archive: null })}>Все</button>
          {STATUSES.map((s) => (
            <button key={s} type="button" aria-pressed={status === s && !archived} onClick={() => setParam({ status: s, archive: null })}>{STATUS_NAME[s]}</button>
          ))}
          <button type="button" className="arch-btn" aria-pressed={archived} onClick={() => setParam({ archive: archived ? null : '1', status: null })}>Архив</button>
        </ChipScroller>
        <select className="inp" aria-label="Тип письма" value={kind ?? ''} onChange={(e) => setParam({ kind: e.target.value || null })}>
          <option value="">Все типы</option>
          <option value="planned">Плановые</option>
          <option value="urgent">Срочные</option>
        </select>
        <input className="inp docs-search" type="search" placeholder="Название или номер" aria-label="Поиск писем" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button className="btn" type="button" onClick={() => open('urgent')}>Срочная рассылка</button>
        <button className="btn primary" type="button" onClick={() => open('new')}>Новое письмо</button>
      </div>

      {list.isError && <div className="form-error">{list.error.message}</div>}
      <section className="panel">
        <div className="tbl-wrap">
          <table className="docs-tbl aw-letters" data-testid="letters-table">
            <thead><tr><th>№</th><th>Письмо</th><th>Тип</th><th>Статус</th><th>Версия</th><th>Автор, изменено</th></tr></thead>
            <tbody>
              {items.map(row)}
              {list.isSuccess && items.length === 0 && (
                <tr><td colSpan={6} className="hint">{search || status || kind || archived ? 'Ничего не найдено' : 'Писем пока нет. Создайте письмо или правило расписания'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {selected && <LetterPanel key={selected} id={selected} onClose={() => select(null)} onOpen={(id) => select(id)} />}

      {nf.open && (
        <FormDialog title={nf.open === 'urgent' ? 'Срочная рассылка' : 'Новое письмо'} submit={nf.open === 'new' && nf.templateId ? 'Далее' : 'Создать'} busy={create.isPending} error={error}
          disabled={!nf.title.trim() || ((nf.open === 'urgent' || nf.kind === 'urgent') && !nf.reason.trim())}
          onClose={() => setNf(EMPTY)} testId="new-letter-dialog"
          onSubmit={() => {
            setError(null);
            const step = nf.open === 'new' ? newLetterStep(nf) : { kind: 'create' as const };
            if (step.kind === 'fromTemplate') { setNf(EMPTY); setFromTpl(step); } else create.mutate();
          }}>
          <label>Название (для списков, в письмо не входит)
            <input className="inp" required autoFocus maxLength={200} value={nf.title} onChange={(e) => setNf({ ...nf, title: e.target.value })} />
          </label>
          {nf.open === 'new' && (
            <label>Тип
              <select className="inp" value={nf.kind} onChange={(e) => setNf({ ...nf, kind: e.target.value as LetterKind })}>
                <option value="planned">Плановое</option>
                <option value="urgent">Срочное</option>
              </select>
            </label>
          )}
          {(nf.open === 'urgent' || nf.kind === 'urgent') && (
            <label>Повод
              <textarea className="inp" rows={2} required maxLength={1000} placeholder="Инцидент, новая схема мошенничества, предупреждение регулятора"
                value={nf.reason} onChange={(e) => setNf({ ...nf, reason: e.target.value })} />
            </label>
          )}
          <TemplatePicker label="Шаблон (необязательно)" optional items={templates.data?.items} loading={templates.isLoading}
            value={nf.templateId} onChange={(id) => setNf({ ...nf, templateId: id })} onLeave={() => setNf(EMPTY)} />
          {nf.open === 'new' && nf.templateId && <p className="hint">«Далее» — заполнить переменные шаблона; письмо создастся из него.</p>}
          {nf.open === 'urgent' && (
            <>
              <p className="hint">Будет создано срочное письмо и задача «Срочная рассылка» вам — срок 1 рабочий день, приоритет «Высокий». Срочное письмо можно отметить отправленным без согласования, указав причину.</p>
            </>
          )}
        </FormDialog>
      )}
      {fromTpl && (
        <FromTemplateDialog templateId={fromTpl.templateId} defaultTitle={fromTpl.title} defaultKind={fromTpl.letterKind} defaultReason={fromTpl.reason}
          onClose={() => setFromTpl(null)} onCreated={(r) => { setFromTpl(null); select(r.letter.id); }} />
      )}
    </>
  );
}
