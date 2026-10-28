import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { dashboardApi, dashkeys, type MonitorSlide, type SlideConfig, type SlideInput, type SlideOptions } from '../../api/dashboard';
import { Overlay } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { rowsPerPage } from '../dashboard/logic';
import { SlideView } from '../monitor/SlideView';

type Kind = SlideInput['kind'];
type Filter = SlideInput['filter'];

const DEFAULT_TITLES: Record<Kind, string> = {
  kpis: 'Ключевые показатели', vulns: 'Уязвимости: дни до срока', tasks: 'Задачи: сроки', documents: 'Документы: срок пересмотра',
  risks: 'Решения ОУР: пересмотр', evidence: 'Доказательства: срок действия', dlp: 'Доступ без основания',
};
const blank = (kind: Kind = 'tasks'): SlideInput => ({ kind, title: DEFAULT_TITLES[kind], seconds: 12, filter: kind === 'kpis' || kind === 'dlp' ? {} : { period: 'all' }, enabled: true, skipEmpty: false });

/** Отметки значений: критичность, отделы, категории и т. п. Пусто — все. */
function Pick({ label, options, value, onChange }: { label: string; options: { id: string; label: string }[]; value: string[] | undefined; onChange: (v: string[]) => void }) {
  if (!options.length) return null;
  const set = new Set(value ?? []);
  return (
    <fieldset className="slide-pick">
      <legend>{label} <span className="hint">— ничего не отмечено: все</span></legend>
      {options.map((o) => (
        <label key={o.id} className="check">
          <input type="checkbox" checked={set.has(o.id)} onChange={() => {
            const n = new Set(set);
            if (n.has(o.id)) n.delete(o.id);
            else n.add(o.id);
            onChange([...n]);
          }} /> {o.label}
        </label>
      ))}
    </fieldset>
  );
}

function FilterEditor({ kind, filter, options, onChange }: { kind: Kind; filter: Filter; options: SlideOptions; onChange: (f: Filter) => void }) {
  const set = (patch: Partial<Filter>) => onChange({ ...filter, ...patch });
  const period = kind !== 'kpis' && kind !== 'dlp';
  return (
    <div className="grid-gap">
      {period && (
        <div className="row">
          <label className="fd-label">Сроки
            <select className="inp" value={filter.period ?? 'all'} onChange={(e) => set({ period: e.target.value as Filter['period'], ...(e.target.value === 'within' && !filter.days ? { days: 7 } : {}) })} aria-label="Сроки">
              <option value="all">все</option>
              <option value="overdue">только просроченные</option>
              <option value="within">просроченные и в ближайшие N дней</option>
            </select>
          </label>
          {filter.period === 'within' && (
            <label className="fd-label">Дней
              <input className="inp sm-inp" type="number" min={1} max={365} value={filter.days ?? 7} onChange={(e) => set({ days: Number(e.target.value) })} aria-label="Дней" />
            </label>
          )}
        </div>
      )}
      {kind === 'kpis' && <Pick label="Показатели" options={options.kpis} value={filter.kpis} onChange={(kpis) => set({ kpis })} />}
      {kind === 'vulns' && (
        <>
          <Pick label="Критичность" options={options.crit} value={filter.crit} onChange={(crit) => set({ crit })} />
          <Pick label="Отдел" options={options.departments} value={filter.departments} onChange={(departments) => set({ departments })} />
          <Pick label="Система" options={options.systems} value={filter.systems} onChange={(systems) => set({ systems })} />
        </>
      )}
      {kind === 'tasks' && <Pick label="Категории" options={options.categories} value={filter.categories} onChange={(categories) => set({ categories })} />}
      {kind === 'documents' && <Pick label="Типы документов" options={options.types} value={filter.types} onChange={(types) => set({ types })} />}
      {kind === 'dlp' && (
        <label className="fd-label">Реестр со статусом основания
          <select className="inp" value={filter.registerId ?? ''} onChange={(e) => set({ registerId: e.target.value || undefined })} aria-label="Реестр DLP">
            <option value="">— выберите</option>
            {options.registers.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
        </label>
      )}
    </div>
  );
}

/** Предпросмотр: слайд так, как он будет на мониторе (тёмная стена, пропорции 16:9). */
function Preview({ slide, onClose }: { slide: MonitorSlide; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <Overlay>
      <div className="backdrop" role="presentation" onClick={onClose}>
        <div className="slide-preview wall-dark" role="dialog" aria-modal="true" aria-label="Предпросмотр слайда" onClick={(e) => e.stopPropagation()}>
          <div className="mon mon-preview">
            <SlideView slide={slide} page={0} per={rowsPerPage(1080, 1920)} />
            <div className="mon-foot"><span>Предпросмотр · {slide.seconds} с{slide.empty && slide.skipEmpty ? ' · пустой — на мониторе будет пропущен' : ''}</span><span>Esc — закрыть</span></div>
          </div>
        </div>
      </div>
    </Overlay>
  );
}

/**
 * «Настройки → Экран мониторинга» (релиз 1.1.0, ADR-0019): слайды по порядку, время показа, фильтры,
 * «пропускать пустой», предпросмотр. Одна настройка на все настенные мониторы; правка — settings.manage.
 */
export function MonitorSlides() {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: dashkeys.slides, queryFn: dashboardApi.slides });
  const options = useQuery({ queryKey: dashkeys.slideOptions, queryFn: dashboardApi.slideOptions });
  const [edit, setEdit] = useState<{ id: string | null; version: number; input: SlideInput } | null>(null);
  const [preview, setPreview] = useState<MonitorSlide | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async <T,>(fn: () => Promise<T>, ok: string, done?: (v: T) => void) => {
    setBusy(true);
    try {
      const v = await fn();
      await qc.invalidateQueries({ queryKey: dashkeys.slides });
      await qc.invalidateQueries({ queryKey: dashkeys.monitor });
      toast(ok);
      done?.(v);
    } catch (e) {
      toast(e instanceof ApiError && e.code === 'VERSION_CONFLICT' ? 'Слайд уже изменили — откройте его заново' : e instanceof Error ? e.message : 'Не удалось сохранить', 'error');
    } finally {
      setBusy(false);
    }
  };
  const open = (s: SlideConfig) => setEdit({ id: s.id, version: s.version, input: { kind: s.kind, title: s.title, seconds: s.seconds, filter: s.filter, enabled: s.enabled, skipEmpty: s.skipEmpty } });
  const save = () => edit && void run(
    () => (edit.id ? dashboardApi.updateSlide(edit.id, edit.version, edit.input) : dashboardApi.createSlide(edit.input)),
    edit.id ? 'Слайд сохранён — мониторы покажут его со следующего обновления' : 'Слайд добавлен', () => setEdit(null),
  );
  const toggle = (s: SlideConfig) => void run(() => dashboardApi.updateSlide(s.id, s.version, { kind: s.kind, title: s.title, seconds: s.seconds, filter: s.filter, enabled: !s.enabled, skipEmpty: s.skipEmpty }), s.enabled ? 'Слайд выключен' : 'Слайд включён');
  const showPreview = (input: SlideInput) => void dashboardApi.previewSlide(input).then(setPreview, (e: unknown) => toast(e instanceof Error ? e.message : 'Не удалось показать', 'error'));
  const items = list.data?.items ?? [];
  const opts = options.data;
  const kindName = (k: Kind) => opts?.kinds.find((x) => x.kind === k)?.label ?? k;

  return (
    <div className="stack">
      <div className="panel">
        <div className="panel-h">
          <h3>Слайды экрана мониторинга</h3>
          <span className="row">
            <a className="btn sm" href="/monitor" target="_blank" rel="noreferrer">Открыть мониторинг</a>
            <button className="btn primary sm" type="button" onClick={() => setEdit({ id: null, version: 0, input: blank() })}>Добавить слайд</button>
          </span>
        </div>
        <div className="panel-b hint">Одна настройка на все настенные мониторы. Слайды показываются по порядку, каждый — своё время; длинный список делится на страницы. Изменения мониторы подхватывают сами в течение 1–2 минут, на границе слайда.</div>
        <div className="tbl-wrap">
          <table className="cat-tbl slides-tbl">
            <thead><tr><th>№</th><th>Слайд</th><th>Вид</th><th>Время</th><th>Пустой</th><th /></tr></thead>
            <tbody>
              {list.isSuccess && items.length === 0 && <tr><td colSpan={6} className="hint">Слайдов нет — монитор покажет подсказку</td></tr>}
              {items.map((s, i) => (
                <tr key={s.id} className={s.enabled ? undefined : 'archived'} data-slide-id={s.id}>
                  <td className="mono">{i + 1}</td>
                  <td><b>{s.title}</b>{!s.enabled && <> <span className="chip">выключен</span></>}</td>
                  <td>{kindName(s.kind)}</td>
                  <td className="mono">{s.seconds} с</td>
                  <td>{s.skipEmpty ? 'пропускать' : 'показывать текст'}</td>
                  <td>
                    <span className="row nowrap act">
                      <button className="btn ghost sm" type="button" aria-label={`«${s.title}» выше`} disabled={busy || i === 0} onClick={() => void run(() => dashboardApi.moveSlide(s.id, 'up'), 'Порядок изменён')}>↑</button>
                      <button className="btn ghost sm" type="button" aria-label={`«${s.title}» ниже`} disabled={busy || i === items.length - 1} onClick={() => void run(() => dashboardApi.moveSlide(s.id, 'down'), 'Порядок изменён')}>↓</button>
                      <button className="btn ghost sm" type="button" onClick={() => showPreview({ kind: s.kind, title: s.title, seconds: s.seconds, filter: s.filter, enabled: s.enabled, skipEmpty: s.skipEmpty })}>Предпросмотр</button>
                      <button className="btn ghost sm" type="button" disabled={busy} onClick={() => toggle(s)}>{s.enabled ? 'Выключить' : 'Включить'}</button>
                      <button className="btn ghost sm" type="button" onClick={() => open(s)}>Изменить</button>
                      <button className="btn ghost sm danger-t" type="button" disabled={busy} onClick={() => { if (window.confirm(`Удалить слайд «${s.title}»?`)) void run(() => dashboardApi.deleteSlide(s.id, s.version), 'Слайд удалён'); }}>Удалить</button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {edit && opts && (
        <div className="panel slide-form" aria-label={edit.id ? 'Слайд' : 'Новый слайд'}>
          <div className="panel-h"><h3>{edit.id ? 'Слайд' : 'Новый слайд'}</h3></div>
          <div className="panel-b grid-gap">
            <div className="row">
              <label className="fd-label">Вид
                <select className="inp" value={edit.input.kind} disabled={!!edit.id} aria-label="Вид слайда"
                  onChange={(e) => setEdit({ ...edit, input: blank(e.target.value as Kind) })}>
                  {opts.kinds.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
                </select>
              </label>
              <label className="fd-label">Название
                <input className="inp" value={edit.input.title} maxLength={120} onChange={(e) => setEdit({ ...edit, input: { ...edit.input, title: e.target.value } })} aria-label="Название слайда" />
              </label>
              <label className="fd-label">Секунд
                <input className="inp sm-inp" type="number" min={opts.seconds.min} max={opts.seconds.max} value={edit.input.seconds}
                  onChange={(e) => setEdit({ ...edit, input: { ...edit.input, seconds: Number(e.target.value) } })} aria-label="Секунд на слайд" />
              </label>
            </div>
            <FilterEditor kind={edit.input.kind} filter={edit.input.filter} options={opts} onChange={(filter) => setEdit({ ...edit, input: { ...edit.input, filter } })} />
            <div className="row">
              <label className="check"><input type="checkbox" checked={edit.input.enabled} onChange={(e) => setEdit({ ...edit, input: { ...edit.input, enabled: e.target.checked } })} /> Показывать на мониторе</label>
              <label className="check"><input type="checkbox" checked={edit.input.skipEmpty} onChange={(e) => setEdit({ ...edit, input: { ...edit.input, skipEmpty: e.target.checked } })} /> Пропускать, если данных нет</label>
            </div>
            <div className="row">
              <button className="btn" type="button" onClick={() => showPreview(edit.input)}>Предпросмотр</button>
              <button className="btn" type="button" onClick={() => setEdit(null)} disabled={busy}>Отмена</button>
              <button className="btn primary" type="button" onClick={save} disabled={busy}>{edit.id ? 'Сохранить' : 'Добавить'}</button>
            </div>
          </div>
        </div>
      )}
      {preview && <Preview slide={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}
