// «Настройки → Параметры портала» (релиз 1.6.0): ключи app_settings этого релиза. Проверяет значение backend, по схеме ключа.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { settingsApi, type PortalParam, type PortalParamOptions } from '../../api/settings';
import { useAction } from './useAction';

const paramsKey = ['settings', 'portal-params'] as const;
type Assets = { significantLevelOptionIds: string[]; dlpRegisterId: string | null };
type Vulns = { scanMaxAgeDays: number; profileAliases: Record<string, string[]> };
type Option = { id: string; label: string };
type StageDays = Record<'21' | '21h' | '22h' | '23' | '24', number>;

/**
 * Сроки задач этапов документа (маршрут 1.11.0, ключ documents.stageDays.v3). «Согласования» (22) нет — его срок
 * берётся из сроков ответственных лиц; у «Перевода» с языками — из сроков языков.
 */
const STAGE_DAY_FIELDS: { key: keyof StageDays; label: string }[] = [
  { key: '21', label: 'Драфт (документ заведён за другого владельца)' },
  { key: '21h', label: 'Проверка начальника ИБ' },
  { key: '22h', label: 'Повторная проверка начальника ИБ' },
  { key: '23', label: 'Перевод (языков нет)' },
  { key: '24', label: 'Утверждение' },
];

function StageDaysForm({ value, onChange }: { value: StageDays; onChange: (v: StageDays) => void }) {
  return (
    <div className="fgrid">
      {STAGE_DAY_FIELDS.map((f) => (
        <label key={f.key} className="fd-label">{f.label}, рабочих дней
          <input className="inp" type="number" min={1} max={60} aria-label={`Срок: ${f.label}`} value={Number.isNaN(value[f.key]) ? '' : value[f.key]}
            onChange={(e) => onChange({ ...value, [f.key]: e.target.valueAsNumber })} />
        </label>
      ))}
    </div>
  );
}

type Grades = { excellent: number; good: number; satisfactory: number; retakeBelow: number };
const GRADE_FIELDS: { key: keyof Grades; label: string }[] = [
  { key: 'excellent', label: '«Отлично» — от' },
  { key: 'good', label: '«Хорошо» — от' },
  { key: 'satisfactory', label: '«Удовлетворительно» — от' },
  { key: 'retakeBelow', label: '«На пересдачу» — ниже' },
];

/** Пороги оценки INDIGO (1.8.0): проценты; ниже «Удовлетворительно» — «Провал». Пересдача — свой порог. */
function GradesForm({ value, onChange }: { value: Grades; onChange: (v: Grades) => void }) {
  return (
    <div className="fgrid">
      {GRADE_FIELDS.map((f) => (
        <label key={f.key} className="fd-label">{f.label}, %
          <input className="inp" type="number" min={0} max={100} step={0.1} aria-label={`Порог: ${f.label}`} value={Number.isNaN(value[f.key]) ? '' : value[f.key]}
            onChange={(e) => onChange({ ...value, [f.key]: e.target.valueAsNumber })} />
        </label>
      ))}
    </div>
  );
}

function Checks({ title, options, value, onChange }: { title: string; options: Option[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="fd-label">{title}
      {options.length === 0 && <span className="hint">В списке пока нет значений</span>}
      <div className="row">
        {options.map((o) => (
          <label key={o.id} className="check">
            <input type="checkbox" checked={value.includes(o.id)} onChange={(e) => onChange(e.target.checked ? [...value, o.id] : value.filter((id) => id !== o.id))} /> {o.label}
          </label>
        ))}
      </div>
    </div>
  );
}

function AssetsForm({ value, onChange, options }: { value: Assets; onChange: (v: Assets) => void; options: PortalParamOptions }) {
  return (
    <>
      <Checks title="Значимые категории" options={options.levels} value={value.significantLevelOptionIds} onChange={(significantLevelOptionIds) => onChange({ ...value, significantLevelOptionIds })} />
      <label className="fd-label">Реестр устройств DLP
        <select className="inp" value={value.dlpRegisterId ?? ''} onChange={(e) => onChange({ ...value, dlpRegisterId: e.target.value || null })}>
          <option value="">— не задан</option>
          {options.registers.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
      </label>
    </>
  );
}

function VulnsForm({ value, onChange, options }: { value: Vulns; onChange: (v: Vulns) => void; options: PortalParamOptions }) {
  const setAliases = (id: string, text: string) => {
    const list = text.split(',').map((s) => s.trim());
    const rest = Object.fromEntries(Object.entries(value.profileAliases).filter(([k]) => k !== id));
    onChange({ ...value, profileAliases: text.trim() ? { ...rest, [id]: list } : rest });
  };
  return (
    <>
      <label className="fd-label">Порог, дней
        <input className="inp" type="number" aria-label="Порог, дней" value={value.scanMaxAgeDays} onChange={(e) => onChange({ ...value, scanMaxAgeDays: e.target.valueAsNumber })} />
      </label>
      <div className="fd-label">Синонимы профилей, через запятую
        {options.systemTypes.map((t) => (
          <label key={t.id} className="row nowrap">
            <span className="hint">{t.label}</span>
            <input className="inp" aria-label={`Синонимы: ${t.label}`} value={(value.profileAliases[t.id] ?? []).join(', ')} onChange={(e) => setAliases(t.id, e.target.value)} />
          </label>
        ))}
      </div>
    </>
  );
}

/** Значение формы → значение ключа. JSON не разобрался — сообщение на месте, запрос не уходит. */
function parseDraft(form: PortalParam['form'], draft: unknown): { value: unknown } | { error: string } {
  if (form === 'lines') return { value: String(draft).split('\n').map((s) => s.trim()).filter(Boolean) };
  if (form !== 'json') return { value: draft };
  try {
    return { value: JSON.parse(String(draft)) };
  } catch {
    return { error: 'Это не JSON: проверьте кавычки и запятые' };
  }
}

function initialDraft(p: PortalParam): unknown {
  if (p.form === 'json') return JSON.stringify(p.value, null, 2);
  if (p.form === 'lines') return (p.value as string[]).join('\n');
  return p.value;
}

const shownDefault = (p: PortalParam) => (p.form === 'text' && !p.defaultValue ? 'пусто' : JSON.stringify(p.defaultValue));

function ParamPanel({ param, options }: { param: PortalParam; options: PortalParamOptions }) {
  const [draft, setDraft] = useState<unknown>(() => initialDraft(param));
  const [error, setError] = useState<string | null>(null);
  const save = useAction(settingsApi.setPortalParam, { invalidate: [paramsKey], success: () => `Сохранено: ${param.title}`, handle: (err) => { setError(err instanceof Error ? err.message : 'Не удалось сохранить'); return false; } });
  const reset = useAction(settingsApi.resetPortalParam, { invalidate: [paramsKey], success: () => `Сброшено к умолчанию: ${param.title}` });
  const submit = () => {
    setError(null);
    const parsed = parseDraft(param.form, draft);
    if ('error' in parsed) setError(parsed.error);
    else save.mutate({ key: param.key, value: parsed.value, version: param.version });
  };
  return (
    <section className="panel" data-param={param.key}>
      <div className="panel-h">
        <h3>{param.title}</h3>
        <span className={param.isDefault ? 'chip' : 'chip acc'}>{param.isDefault ? 'По умолчанию' : 'Изменено'}</span>
      </div>
      <div className="panel-b form">
        <p className="hint">{param.description}</p>
        {param.form === 'vulns' && <VulnsForm value={draft as Vulns} onChange={setDraft} options={options} />}
        {param.form === 'assets' && <AssetsForm value={draft as Assets} onChange={setDraft} options={options} />}
        {param.form === 'stageDays' && <StageDaysForm value={draft as StageDays} onChange={setDraft} />}
        {param.form === 'grades' && <GradesForm value={draft as Grades} onChange={setDraft} />}
        {param.form === 'reviewRole' && (
          <label className="fd-label">Роль
            <select className="inp" aria-label="Роль проверки сотрудниками" value={(draft as { roleId: string | null }).roleId ?? ''}
              onChange={(e) => setDraft({ roleId: e.target.value || null })}>
              <option value="">— все сотрудники ИБ</option>
              {options.roles.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </label>
        )}
        {param.form === 'text' && <input className="inp" aria-label={param.title} value={String(draft)} onChange={(e) => setDraft(e.target.value)} />}
        {(param.form === 'lines' || param.form === 'json') && <textarea className="inp mono" rows={param.form === 'json' ? 8 : 4} aria-label={param.title} value={String(draft)} onChange={(e) => setDraft(e.target.value)} />}
        <details><summary className="hint">Значение по умолчанию</summary><pre className="hint">{shownDefault(param)}</pre></details>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="row">
          <button className="btn primary" type="button" disabled={save.isPending} onClick={submit}>Сохранить</button>
          <button className="btn" type="button" disabled={param.isDefault || reset.isPending} onClick={() => reset.mutate({ key: param.key, version: param.version })}>Сбросить к умолчанию</button>
        </div>
      </div>
    </section>
  );
}

export function PortalParams() {
  const q = useQuery({ queryKey: paramsKey, queryFn: settingsApi.portalParams });
  if (q.isPending) return <div className="panel panel-b hint">Загрузка…</div>;
  if (q.isError) return <div className="panel panel-b hint">Не удалось загрузить: {q.error.message}</div>;
  return (
    <div className="stack">
      {/* key — версия: после сохранения и сброса форма показывает значение с сервера. */}
      {q.data.items.map((p) => <ParamPanel key={`${p.key}:${p.version}:${p.isDefault}`} param={p} options={q.data.options} />)}
    </div>
  );
}
