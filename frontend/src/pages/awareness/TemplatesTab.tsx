// «Осведомлённость → Шаблоны» (1.9.0; docs/specs/awareness.md, раздел 17): список с переменными, числом правил
// и отметкой «больше текущего лимита»; карточка шаблона (?template=) — тот же редактор, переменные под ним;
// архив вместо удаления; «Письмо из шаблона».
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { awarenessApi, awarenessKeys, type Template, type TemplateItem } from '../../api/awareness';
import { DetailPanel } from '../../components/DetailPanel';
import { useToast } from '../../components/Toast';
import { ConfirmDialog, type ConfirmAsk } from '../settings/ConfirmDialog';
import { BilingualFields, EMPTY_TEXTS, HEAD_KEYS, sameTexts, textsOf, type Texts } from './editor';
import { FromTemplateDialog } from './FromTemplateDialog';
import { MailPreview } from './MailPreview';
import { ruDateTime, templateVariables } from './logic';

const NEW = 'new';

function TemplatePanel({ id, onClose, onOpen }: { id: string; onClose: () => void; onOpen: (id: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const isNew = id === NEW;
  const q = useQuery({ queryKey: awarenessKeys.template(id), queryFn: () => awarenessApi.template(id), enabled: !isNew });
  const sig = useQuery({ queryKey: awarenessKeys.signature, queryFn: awarenessApi.signature, staleTime: 60_000 });
  const t = q.data;
  const [title, setTitle] = useState('');
  const [texts, setTexts] = useState<Texts>(EMPTY_TEXTS);
  const [preview, setPreview] = useState(false);
  const [resetKey, setResetKey] = useState(id);
  const [conflict, setConflict] = useState(false);
  const [ask, setAsk] = useState<ConfirmAsk | null>(null);
  const [fromOpen, setFromOpen] = useState(false);
  const reset = (x: Template) => {
    setTitle(x.title);
    setTexts(textsOf(x.content));
    setResetKey(`${x.id}:${x.version}:${Date.now()}`);
    setConflict(false);
  };
  useEffect(() => {
    if (t) reset(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t?.id, t?.version]);

  const dirty = isNew ? !!(title.trim() || texts.subjectRu || texts.subjectTj || texts.htmlRu || texts.htmlTj || HEAD_KEYS.some((k) => texts[k]))
    : !!t && (title !== t.title || !sameTexts(texts, textsOf(t.content)));
  const vars = useMemo(() => templateVariables([texts.subjectRu, texts.subjectTj, ...HEAD_KEYS.map((k) => texts[k]), texts.htmlRu, texts.htmlTj]), [texts]);
  const editable = isNew || (!!t && !t.archived && !conflict);
  const limits = t?.size.limits ?? { maxImageKb: 1024, maxLetterKb: 2048, warnLetterKb: 1024 };

  const save = useMutation({
    mutationFn: () => (isNew ? awarenessApi.createTemplate({ title, ...texts }) : awarenessApi.saveTemplate(id, { title, ...texts, version: t?.version ?? 0 })),
    onSuccess: async (r) => {
      qc.setQueryData(awarenessKeys.template(r.template.id), r.template);
      await qc.invalidateQueries({ queryKey: awarenessKeys.templates });
      reset(r.template);
      if (r.warnings.length) r.warnings.forEach((w) => toast(w, 'warn'));
      else toast(isNew ? `Шаблон «${r.template.title}» создан` : 'Шаблон сохранён');
      if (isNew) onOpen(r.template.id);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') setConflict(true);
      else toast(err instanceof Error ? err.message : 'Не удалось сохранить шаблон', 'error');
    },
  });
  const archive = useMutation({
    mutationFn: (archived: boolean) => awarenessApi.archiveTemplate(id, t?.version ?? 0, archived),
    onSuccess: async (x) => {
      qc.setQueryData(awarenessKeys.template(id), x);
      await qc.invalidateQueries({ queryKey: awarenessKeys.templates });
      toast(x.archived ? 'Шаблон в архиве' : 'Шаблон возвращён из архива');
    },
    onError: (err) => toast(err instanceof Error ? err.message : 'Не удалось', 'error'),
  });
  const close = () => {
    if (dirty) setAsk({ title: 'Закрыть без сохранения?', text: 'Изменения в шаблоне не сохранены.', confirm: 'Закрыть', run: onClose });
    else onClose();
  };

  const footer = (
    <>
      {editable && <button className="btn primary" type="button" disabled={save.isPending || !dirty || !title.trim()} onClick={() => save.mutate()}>{isNew ? 'Создать шаблон' : 'Сохранить'}</button>}
      {t && !t.archived && <button className="btn" type="button" disabled={dirty} title={dirty ? 'Сначала сохраните изменения' : undefined} onClick={() => setFromOpen(true)}>Письмо из шаблона</button>}
      <span className="grow" />
      {t && !t.archived && (
        <button className="btn ghost" type="button" disabled={archive.isPending}
          onClick={() => setAsk({
            title: 'Отправить шаблон в архив?',
            text: t.rules ? `Шаблон выбран в правилах расписания: ${t.rules}. Они будут создавать задачи без черновика.` : 'Шаблон нельзя будет выбрать для новых писем и правил.',
            confirm: 'В архив', run: () => { setAsk(null); archive.mutate(true); },
          })}>В архив</button>
      )}
      {t?.archived && <button className="btn ghost" type="button" disabled={archive.isPending} onClick={() => archive.mutate(false)}>Из архива</button>}
    </>
  );

  return (
    <DetailPanel label="Шаблон письма" variant="sheet" wide onClose={close} scrollKey={id} testId="template-panel"
      eyebrow={isNew ? 'Новый шаблон' : t ? `Шаблон · изменён ${ruDateTime(t.updatedAt)}, ${t.updatedBy.fullName}` : 'Шаблон'}
      title={title || t?.title || (isNew ? 'Новый шаблон' : 'Загрузка…')}
      badges={t && <>
        {t.archived && <span className="chip">В архиве</span>}
        {t.tooLarge && <span className="chip crit" title={t.tooLarge}>больше текущего лимита</span>}
        {t.rules > 0 && <span className="chip acc">в правилах: {t.rules}</span>}
      </>}
      footer={footer}>
      {q.isError && <div className="form-error">{q.error.message}</div>}
      {conflict && (
        <div className="note conflict" role="alert">
          Шаблон изменил другой пользователь — ваши изменения не сохранены.
          <div className="row mt6"><button className="btn sm primary" type="button" onClick={() => void q.refetch().then((r) => r.data && reset(r.data))}>Перечитать шаблон</button></div>
        </div>
      )}
      {t?.tooLarge && <div className="note conflict" role="status">{t.tooLarge}. По расписанию черновик из такого шаблона не создаётся — уменьшите изображения.</div>}
      {(isNew || t) && (
        <div className="aw-letter">
          <label>Название шаблона
            <input className="inp" required maxLength={200} value={title} disabled={!editable} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <BilingualFields value={texts} resetKey={resetKey} readOnly={!editable} signature={sig.data ?? { htmlRu: '', htmlTj: '' }} limits={limits}
            onWarning={(w) => toast(w, 'warn')} onChange={setTexts}
            subjectHint="Переменные — {{описание}}: «{{название схемы}}». {{подпись}} — блок «Подпись ИБ» (только в тексте)" />
          <div className="aw-varlist" data-testid="template-variables">
            <span className="eyebrow">Переменные</span>
            {vars.length ? vars.map((v) => <span key={v.key} className="chip acc">{v.label}</span>) : <span className="hint">нет — письмо из шаблона будет его копией</span>}
          </div>
          <div className="row">
            <button className="btn" type="button" aria-expanded={preview} onClick={() => setPreview((x) => !x)}>{preview ? 'Скрыть предпросмотр' : 'Предпросмотр как в почте'}</button>
          </div>
          {preview && (
            <MailPreview
              langs={(['both', 'ru', 'tj'] as const).filter((x) => {
                const ru = !!(texts.subjectRu.trim() || texts.htmlRu.replace(/<[^>]+>/g, '').trim());
                const tj = !!(texts.subjectTj.trim() || texts.htmlTj.replace(/<[^>]+>/g, '').trim());
                return x === 'both' ? ru && tj : x === 'ru' ? ru : tj;
              })}
              reloadKey={JSON.stringify(texts)}
              load={async (lang) => {
                const r = await awarenessApi.mailPreview({ ...texts, kind: 'planned', lang });
                return { subject: r.subject, src: `/api/v1/awareness/mail-preview/${r.token}`, warnings: r.warnings };
              }}
            />
          )}
        </div>
      )}
      {ask && <ConfirmDialog ask={ask} busy={archive.isPending} onClose={() => setAsk(null)} />}
      {fromOpen && t && (
        <FromTemplateDialog templateId={t.id} onClose={() => setFromOpen(false)}
          onCreated={(r) => { setFromOpen(false); navigate(`/awareness/letters?letter=${r.letter.id}`); }} />
      )}
    </DetailPanel>
  );
}

export function TemplatesTab() {
  const [params, setParams] = useSearchParams();
  const selected = params.get('template');
  const archived = params.get('archive') === '1';
  const [search, setSearch] = useState('');
  const navigate = useNavigate();
  const [fromOpen, setFromOpen] = useState(false);
  const list = useQuery({
    queryKey: [...awarenessKeys.templates, { archived, search }],
    queryFn: () => awarenessApi.templates({ scope: archived ? 'archived' : 'active', q: search.trim() || undefined }),
  });
  const select = useCallback((id: string | null) => {
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (id === null) n.delete('template'); else n.set('template', id);
      return n;
    }, { preventScrollReset: true });
  }, [setParams]);
  const items = list.data?.items ?? [];

  const row = (t: TemplateItem) => (
    <tr key={t.id} className={t.id === selected ? 'sel' : undefined} tabIndex={0} data-template={t.title}
      onClick={() => select(t.id)} onKeyDown={(e) => { if (e.key === 'Enter') select(t.id); }}>
      <td>
        <div className="w500">{t.title}</div>
        <div className="hint">{t.subjectRu || t.subjectTj || 'без темы'}</div>
      </td>
      <td><div className="row gap6 wrap">{t.variables.length ? t.variables.map((v) => <span key={v.key} className="chip">{v.label}</span>) : <span className="hint">—</span>}</div></td>
      <td className="mono">{t.rules || '—'}</td>
      <td>{t.tooLarge ? <span className="chip crit" title={t.tooLarge} data-testid="template-too-large">больше текущего лимита</span> : t.archived ? <span className="chip">в архиве</span> : null}</td>
      <td><div>{t.updatedBy.fullName}</div><div className="hint">{ruDateTime(t.updatedAt)}</div></td>
    </tr>
  );

  return (
    <>
      <div className="row docs-bar">
        <div className="filters toolbar-grow" role="group" aria-label="Шаблоны">
          <button type="button" aria-pressed={!archived} onClick={() => setParams({}, { replace: true })}>Действующие</button>
          <button type="button" aria-pressed={archived} onClick={() => setParams({ archive: '1' }, { replace: true })}>Архив</button>
        </div>
        <input className="inp docs-search" type="search" placeholder="Название шаблона" aria-label="Поиск шаблонов" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button className="btn" type="button" onClick={() => setFromOpen(true)}>Письмо из шаблона</button>
        <button className="btn primary" type="button" onClick={() => select(NEW)}>Новый шаблон</button>
      </div>
      {list.isError && <div className="form-error">{list.error.message}</div>}
      <section className="panel">
        <div className="tbl-wrap">
          <table className="docs-tbl aw-letters" data-testid="templates-table">
            <thead><tr><th>Шаблон</th><th>Переменные</th><th>Правил</th><th /><th>Изменён</th></tr></thead>
            <tbody>
              {items.map(row)}
              {list.isSuccess && items.length === 0 && <tr><td colSpan={5} className="hint">{search || archived ? 'Ничего не найдено' : 'Шаблонов пока нет'}</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      {selected && <TemplatePanel key={selected} id={selected} onClose={() => select(null)} onOpen={(id) => select(id)} />}
      {fromOpen && (
        <FromTemplateDialog onClose={() => setFromOpen(false)} onCreated={(r) => { setFromOpen(false); navigate(`/awareness/letters?letter=${r.letter.id}`); }} />
      )}
    </>
  );
}

