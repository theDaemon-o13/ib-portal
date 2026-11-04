import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, type FormEvent } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import type { Me } from '../../api/client';
import { docsApi } from '../../api/documents';
import { evidenceApi, ekeys, type EvidenceQuery, type EvidenceState, type NewEvidence } from '../../api/evidence';
import type { FileInfo } from '../../api/files';
import { registersApi } from '../../api/registers';
import { settingsApi } from '../../api/settings';
import { FileUpload } from '../../components/files/FileUpload';
import { ChipScroller } from '../../components/ChipScroller';
import { useToast } from '../../components/Toast';
import { formatDate } from '../registers/logic';
import { EvidenceDrawer } from './EvidenceDrawer';
import { liveCheck, requirementText, resultText, STATE_FILTERS, STATE_TONE, validText } from './logic';

type ObjectType = NewEvidence['object']['type'];

/** Выбор объекта доказательства: система из справочника, документ или запись реестра. */
function ObjectPicker({ type, setType, id, setId }: { type: ObjectType; setType: (t: ObjectType) => void; id: string; setId: (id: string) => void }) {
  const [registerId, setRegisterId] = useState('');
  const [q, setQ] = useState('');
  const systems = useQuery({ queryKey: ['settings', 'items', 'systems'], queryFn: () => settingsApi.items('systems', false), enabled: type === 'system' });
  const docs = useQuery({ queryKey: ['documents', 'list', { archived: false }], queryFn: () => docsApi.list({ archived: false }), enabled: type === 'document' });
  const regs = useQuery({ queryKey: ['registers', 'list', false], queryFn: () => registersApi.list(false), enabled: type === 'record' });
  const reg = useQuery({ queryKey: ['registers', 'detail', registerId], queryFn: () => registersApi.get(registerId), enabled: type === 'record' && !!registerId });
  const recs = useQuery({ queryKey: ['registers', registerId, 'records', 'pick', q], queryFn: () => registersApi.records(registerId, { q }), enabled: type === 'record' && !!registerId });
  const title = reg.data?.fields.find((f) => f.isTitle)?.id ?? '';
  return (
    <>
      <label>Объект
        <select className="inp" value={type} onChange={(e) => { setType(e.target.value as ObjectType); setId(''); }}>
          <option value="system">Система</option>
          <option value="document">Документ</option>
          <option value="record">Запись реестра</option>
        </select>
      </label>
      {type === 'system' && (
        <label>Система
          <select className="inp" required value={id} onChange={(e) => setId(e.target.value)}>
            <option value="">—</option>
            {systems.data?.items.map((s) => <option key={s.id} value={s.id}>{s.value}</option>)}
          </select>
        </label>
      )}
      {type === 'document' && (
        <label>Документ
          <select className="inp" required value={id} onChange={(e) => setId(e.target.value)}>
            <option value="">—</option>
            {docs.data?.items.map((d) => <option key={d.id} value={d.id}>#{d.number} {d.title}</option>)}
          </select>
        </label>
      )}
      {type === 'record' && (
        <>
          <label>Реестр
            <select className="inp" required value={registerId} onChange={(e) => { setRegisterId(e.target.value); setId(''); }}>
              <option value="">—</option>
              {regs.data?.items.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
          {registerId && (
            <>
              <input className="inp" type="search" placeholder="Поиск записи" aria-label="Поиск записи" value={q} onChange={(e) => setQ(e.target.value)} />
              <label>Запись
                <select className="inp" required value={id} onChange={(e) => setId(e.target.value)}>
                  <option value="">—</option>
                  {recs.data?.items.map((r) => <option key={r.id} value={r.id}>#{r.number} {r.display[title] ?? ''}</option>)}
                </select>
              </label>
            </>
          )}
        </>
      )}
    </>
  );
}

/** «Загрузить»: форма подтверждения по шаблону (поля со сверкой требований) или просто файл. */
function UploadPanel({ meId, onCreated }: { meId: string; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const templates = useQuery({ queryKey: ['settings', 'templates', false], queryFn: () => settingsApi.templates(false) });
  const people = useQuery({ queryKey: ['settings', 'userOptions'], queryFn: settingsApi.userOptions });
  const [kind, setKind] = useState<'form' | 'file'>('form');
  const [templateId, setTemplateId] = useState('');
  const [type, setType] = useState<ObjectType>('system');
  const [objectId, setObjectId] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [title, setTitle] = useState('');
  const [confirmedBy, setConfirmedBy] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [ownerId, setOwnerId] = useState(meId);
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const tpl = templates.data?.items.find((t) => t.id === (templateId || templates.data.items[0]?.id));
  const cover = useQuery({ queryKey: ekeys.coverage(tpl?.id ?? ''), queryFn: () => evidenceApi.coverage(tpl?.id ?? ''), enabled: !!tpl });

  const create = useMutation({
    mutationFn: () => evidenceApi.create({
      kind,
      object: { type, id: objectId },
      ...(kind === 'form' ? { templateId: tpl?.id, values } : { title, validUntil: validUntil || null }),
      confirmedBy,
      ownerId,
      fileIds: files.map((f) => f.id),
    }),
    onSuccess: async (r) => {
      setValues({});
      setFiles([]);
      setTitle('');
      setError(null);
      await qc.invalidateQueries({ queryKey: ekeys.all });
      toast(`Доказательство #${r.number} загружено и ждёт проверки ИБ`);
      onCreated(r.id);
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Не удалось загрузить'),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    create.mutate();
  };

  return (
    <section className="panel w4">
      <div className="panel-h"><h3>Загрузить</h3><span className="sub">форма заполняется вместе с ДИКТ</span></div>
      <div className="panel-b">
        {kind === 'form' && tpl && cover.data && (
          <>
            <div className="eyebrow mb6">Покрытие: {cover.data.template.basis || cover.data.template.name}</div>
            <div className="cover mb12">
              {cover.data.items.map((c) => (
                <span key={c.system.id} className={`chip ${c.state ? STATE_TONE[c.state] : 'crit'}`}>{c.system.value}: {c.stateName.toLowerCase()}</span>
              ))}
            </div>
          </>
        )}
        <form className="evform" onSubmit={submit} aria-label="Загрузить доказательство">
          <div className="seg" role="group" aria-label="Что загружаем">
            <button type="button" aria-pressed={kind === 'form'} onClick={() => setKind('form')}>Форма подтверждения</button>
            <button type="button" aria-pressed={kind === 'file'} onClick={() => setKind('file')}>Файл</button>
          </div>
          {kind === 'form' && (
            <label>Шаблон формы
              <select className="inp" value={tpl?.id ?? ''} onChange={(e) => { setTemplateId(e.target.value); setValues({}); }}>
                {templates.data?.items.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
          )}
          <ObjectPicker type={type} setType={setType} id={objectId} setId={setObjectId} />
          {kind === 'form' && tpl && (
            <div>
              {tpl.fields.map((f) => {
                const mark = liveCheck(f, values[f.id] ?? '');
                const set = (v: string) => setValues({ ...values, [f.id]: v });
                return (
                  <div key={f.id} className="req">
                    <div>{f.label}<small>требование: {requirementText(f)}</small></div>
                    {f.checkKind === 'yes' ? (
                      <select className="inp" aria-label={f.label} required value={values[f.id] ?? ''} onChange={(e) => set(e.target.value)}>
                        <option value="">—</option><option>да</option><option>нет</option>
                      </select>
                    ) : (
                      <input className="inp" aria-label={f.label} required inputMode={f.checkKind === 'text' ? undefined : 'decimal'} value={values[f.id] ?? ''} onChange={(e) => set(e.target.value)} />
                    )}
                    <span className={`mark${mark === null ? '' : mark ? ' ok' : ' no'}`} aria-hidden="true">{mark === null ? '' : mark ? '✓' : '✕'}</span>
                  </div>
                );
              })}
              {tpl.fields.length === 0 && <div className="hint">В шаблоне нет полей. Добавьте их в «Настройки → Шаблоны форм».</div>}
              <div className="hint mt6">Действует {tpl.validMonths} мес. с даты загрузки. Поля и требования настраиваются в «Настройки → Шаблоны форм»; загруженная форма их больше не меняет.</div>
            </div>
          )}
          {kind === 'file' && (
            <>
              <label>Что подтверждает<input className="inp" required maxLength={300} placeholder="Протокол пересмотра прав доступа, скриншот настроек…" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
              <label>Действует до (необязательно)<input className="inp" type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} /></label>
            </>
          )}
          <FileUpload label={kind === 'form' ? 'Скриншот или выгрузка настроек' : 'Файлы'} value={files} onChange={setFiles} required />
          <label>Подтвердил со стороны ДИКТ<input className="inp" required={kind === 'form'} maxLength={300} placeholder="ФИО и должность администратора" value={confirmedBy} onChange={(e) => setConfirmedBy(e.target.value)} /></label>
          <label>Ответственный за продление
            <select className="inp" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
              {people.data?.items.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
            </select>
          </label>
          {error && <div className="form-error" role="alert">{error}</div>}
          <button className="btn primary" type="submit" disabled={create.isPending || !objectId || files.length === 0}>Загрузить на проверку</button>
        </form>
      </div>
    </section>
  );
}

export function EvidencePage() {
  const me = useOutletContext<Me>();
  const [params, setParams] = useSearchParams();
  const filter = params.get('filter') ?? '';
  const archived = filter === 'archive';
  const [search, setSearch] = useState('');
  const query: EvidenceQuery = {
    archived,
    state: STATE_FILTERS.some((s) => s.key === filter) ? (filter as EvidenceState) : undefined,
    q: search,
  };
  const list = useQuery({ queryKey: ekeys.list(query), queryFn: () => evidenceApi.list(query) });
  const all = useQuery({ queryKey: ekeys.list({ archived: false }), queryFn: () => evidenceApi.list({ archived: false }) });
  const items = list.data?.items ?? [];
  const open = params.get('ev');
  const setParam = useCallback((patch: Record<string, string | null>) => {
    setParams((p) => {
      const n = new URLSearchParams(p);
      for (const [k, v] of Object.entries(patch)) if (v === null) n.delete(k); else n.set(k, v);
      return n;
    }, { replace: true });
  }, [setParams]);
  // Открытая карточка — шаг истории (1.6.5): «Назад» закрывает её, список не прокручивается.
  const openEv = useCallback((id: string | null) => setParams((p) => {
    const n = new URLSearchParams(p);
    if (id) n.set('ev', id); else n.delete('ev');
    return n;
  }, { preventScrollReset: true }), [setParams]);

  return (
    <>
      <div className="head">
        <div>
          <h1>Доказательная база</h1>
          <p>Здесь собрано всё, что подтверждает выполнение требований: решения ОУР по рискам, формы подтверждения, протоколы, скриншоты настроек. Каждое доказательство привязано к объекту и проходит проверку у сотрудника ИБ.</p>
        </div>
      </div>
      <div className="row docs-bar">
        <ChipScroller label="Фильтр доказательств" className="toolbar-grow">
          <button type="button" aria-pressed={!filter} onClick={() => setParam({ filter: null })}>Все <span className="mono">{all.data?.total ?? 0}</span></button>
          {STATE_FILTERS.map((s) => (
            <button key={s.key} type="button" aria-pressed={filter === s.key} onClick={() => setParam({ filter: s.key })}>
              {s.title} <span className="mono">{all.data?.counts[s.key] ?? 0}</span>
            </button>
          ))}
          <button type="button" className="arch-btn" aria-pressed={archived} onClick={() => setParam({ filter: archived ? null : 'archive' })}>Архив</button>
        </ChipScroller>
        <input className="inp docs-search" type="search" placeholder="Поиск: объект, название, файл" aria-label="Поиск доказательств" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {list.isError && <div className="form-error">{list.error.message}</div>}
      <div className="dash">
        <section className="panel w8">
          <div className="panel-h"><h3>Реестр доказательств</h3><span className="sub">{list.data?.total ?? 0} шт.</span></div>
          <div className="tbl-wrap">
            <table className="ev-tbl">
              <thead><tr><th>Объект</th><th>Тип</th><th>Файл</th><th>Загрузил</th><th>Дата</th><th>Действует до</th><th>Результат</th><th>Проверка ИБ</th></tr></thead>
              <tbody>
                {items.map((e) => (
                  <tr key={e.id} data-ev={e.number} className={`click${open === e.id ? ' sel' : ''}`} aria-current={open === e.id || undefined} tabIndex={0} title="Открыть карточку"
                    onClick={() => openEv(e.id)} onKeyDown={(k) => { if (k.key === 'Enter') openEv(e.id); }}>
                    <td><div className="w500">{e.title}</div><div className="hint">{e.object.label}{e.confirmedBy ? ` · подтвердил: ${e.confirmedBy}` : ''}</div></td>
                    <td>{e.kindName}</td>
                    <td><span className="clip">{e.files[0]?.name ?? '—'}{e.files.length > 1 ? ` +${e.files.length - 1}` : ''}</span></td>
                    <td className="nowrap">{e.uploadedBy.fullName}</td>
                    <td className="mono">{formatDate(e.createdAt.slice(0, 10))}</td>
                    <td className={`mono${e.state === 'expired' ? ' late-t' : ''}`}>{validText(e)}</td>
                    <td>{e.result ? <span className={`chip ${e.result.fails.length ? 'crit' : 'low'}`} title={e.result.fails.join('; ')}>{resultText(e)}</span> : <span className="hint">—</span>}</td>
                    <td><span className={`chip ${STATE_TONE[e.state]}`}>{e.stateName}</span></td>
                  </tr>
                ))}
                {list.isSuccess && items.length === 0 && <tr><td colSpan={8} className="hint">{search ? 'Ничего не найдено' : 'Доказательств пока нет'}</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
        <UploadPanel meId={me.id} onCreated={(id) => setParam({ ev: id, filter: null })} />
      </div>
      {open && <EvidenceDrawer key={open} id={open} onClose={() => openEv(null)} />}
    </>
  );
}
