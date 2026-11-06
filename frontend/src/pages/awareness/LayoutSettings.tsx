// «Настройки → Оформление писем» (1.12.0, ADR-0044; docs/specs/awareness.md, раздел 22): логотип, отдел, адрес ИБ,
// прощание, подвал, метки по типу письма, подсказка о таджикском тексте. Вкладка — при settings.manage и ib.work;
// служебная учётная запись её не видит. «Подпись ИБ» (1.9.0) — ниже на этой же вкладке. Данные банка — только здесь.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { awarenessApi, awarenessKeys, type Layout } from '../../api/awareness';
import { filesApi } from '../../api/files';
import { useToast } from '../../components/Toast';
import { ruDateTime } from './logic';

type Fields = Pick<Layout, 'deptRu' | 'deptTj' | 'email' | 'closingRu' | 'closingTj' | 'footerRu' | 'footerTj'
  | 'labelUrgentRu' | 'labelUrgentTj' | 'labelPlannedRu' | 'labelPlannedTj' | 'tjHint'>;
const KEYS: (keyof Fields)[] = ['deptRu', 'deptTj', 'email', 'closingRu', 'closingTj', 'footerRu', 'footerTj', 'labelUrgentRu', 'labelUrgentTj', 'labelPlannedRu', 'labelPlannedTj', 'tjHint'];
const pick = (l: Layout): Fields => Object.fromEntries(KEYS.map((k) => [k, l[k]])) as Fields;
const LOGO_MAX = 100 * 1024;

export function LayoutSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: awarenessKeys.layout, queryFn: awarenessApi.layout });
  const [f, setF] = useState<Fields | null>(null);
  const [logo, setLogo] = useState<{ id: string; name: string } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [uploading, setUploading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const reset = (l: Layout) => {
    setF(pick(l));
    setLogo(l.logo ? { id: l.logo.id, name: l.logo.name } : null);
    setConflict(false);
  };
  useEffect(() => {
    if (q.data) reset(q.data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data?.version]);

  const save = useMutation({
    mutationFn: () => awarenessApi.saveLayout({ ...(f as Fields), logoFileId: logo?.id ?? null, version: q.data?.version ?? 0 }),
    onSuccess: (r) => {
      qc.setQueryData(awarenessKeys.layout, r);
      reset(r);
      toast('Оформление писем сохранено — предпросмотр и выгрузка писем в работе покажут его сразу');
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') setConflict(true);
      else toast(err instanceof Error ? err.message : 'Не удалось сохранить оформление', 'error');
    },
  });

  const upload = async (file: File) => {
    if (!/\.png$/i.test(file.name) || file.type !== 'image/png') return toast('Логотип — только PNG', 'error');
    if (file.size > LOGO_MAX) return toast(`Логотип ${Math.ceil(file.size / 1024)} КБ — больше 100 КБ. Уменьшите его`, 'error');
    setUploading(true);
    try {
      const r = await filesApi.upload(file);
      setLogo({ id: r.id, name: r.name });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Не удалось загрузить логотип', 'error');
    } finally {
      setUploading(false);
    }
    return undefined;
  };

  const l = q.data;
  const dirty = !!l && !!f && (KEYS.some((k) => f[k] !== l[k]) || (logo?.id ?? null) !== (l.logo?.id ?? null));
  const field = (k: keyof Fields, label: string, opts: { area?: boolean; placeholder?: string; hint?: string } = {}) => (
    <label>{label}
      {opts.area
        ? <textarea className="inp" rows={2} maxLength={1000} value={f?.[k] ?? ''} disabled={!l?.canEdit || conflict} placeholder={opts.placeholder}
          onChange={(e) => setF((x) => (x ? { ...x, [k]: e.target.value } : x))} />
        : <input className="inp" maxLength={200} value={f?.[k] ?? ''} disabled={!l?.canEdit || conflict} placeholder={opts.placeholder}
          onChange={(e) => setF((x) => (x ? { ...x, [k]: e.target.value } : x))} />}
      {opts.hint && <span className="hint">{opts.hint}</span>}
    </label>
  );

  return (
    <section className="panel" data-testid="layout-settings">
      <div className="panel-h">
        <div>
          <h3>Оформление писем</h3>
          <span className="sub">Шапка, подпись и подвал учебных писем: так письмо выглядит в предпросмотре и в файле для Outlook. Отправленные письма сохраняют оформление на дату отправки.</span>
        </div>
      </div>
      <div className="panel-b aw-letter">
        {q.isError && <div className="form-error">{q.error.message}</div>}
        {conflict && (
          <div className="note conflict" role="alert">
            Оформление изменил другой пользователь — ваши изменения не сохранены.
            <div className="row mt6"><button className="btn sm primary" type="button" onClick={() => void q.refetch().then((r) => r.data && reset(r.data))}>Перечитать</button></div>
          </div>
        )}
        {l && f && (
          <>
            <div className="row gap6">
              <b>Логотип</b>
              {logo ? <span className="hint" data-testid="layout-logo">{logo.name}</span> : <span className="hint">не загружен — в шапке будет название отдела</span>}
              <span className="grow" />
              {l.canEdit && (
                <>
                  <button className="btn sm" type="button" disabled={uploading || conflict} onClick={() => input.current?.click()}>{logo ? 'Заменить' : 'Загрузить PNG'}</button>
                  {logo && <button className="btn sm ghost" type="button" disabled={conflict} onClick={() => setLogo(null)}>Убрать</button>}
                  <input ref={input} type="file" hidden accept=".png,image/png" aria-label="Файл логотипа"
                    onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void upload(file); }} />
                </>
              )}
            </div>
            <p className="hint">PNG до 100 КБ, в шапке — 238 пикселей по ширине на тёмно-синем фоне. Подпись «alt» — название отдела.</p>
            <div className="fgrid">
              {field('deptRu', 'Название отдела (RU)')}
              {field('deptTj', 'Название отдела (TJ)')}
            </div>
            {field('email', 'Адрес ИБ', { placeholder: 'name@example.org', hint: 'В подписи письма — ссылкой mailto:' })}
            <div className="fgrid">
              {field('closingRu', 'Прощание (RU)', { placeholder: 'С уважением,' })}
              {field('closingTj', 'Прощание (TJ)', { placeholder: 'Бо эҳтиром,' })}
            </div>
            <div className="fgrid">
              {field('footerRu', 'Подвал (RU), необязательно', { area: true, hint: 'Мелкий серый текст внизу карточки письма' })}
              {field('footerTj', 'Подвал (TJ), необязательно', { area: true })}
            </div>
            <div className="fgrid">
              {field('labelUrgentRu', 'Метка срочного (RU)')}
              {field('labelUrgentTj', 'Метка срочного (TJ)')}
              {field('labelPlannedRu', 'Метка планового (RU)')}
              {field('labelPlannedTj', 'Метка планового (TJ)')}
            </div>
            {field('tjHint', 'Подсказка о таджикском тексте', { hint: 'Ссылка над русской частью письма RU+TJ' })}
            <div className="row">
              {l.canEdit && <button className="btn primary" type="button" disabled={!dirty || save.isPending || conflict} onClick={() => save.mutate()}>Сохранить оформление</button>}
              {dirty && <button className="btn" type="button" onClick={() => reset(l)}>Отменить изменения</button>}
              <span className="grow" />
              {l.updatedBy && l.updatedAt && <span className="hint">Изменено {ruDateTime(l.updatedAt)}, {l.updatedBy.fullName}</span>}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
