import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { dashboardApi, dashkeys, type Tile } from '../../api/dashboard';
import { registersApi } from '../../api/registers';
import { DetailPanel } from '../../components/DetailPanel';
import { useToast } from '../../components/Toast';

const TILE_TYPES = new Set(['select', 'catalog']);
const empty = { registerId: '', fieldId: '', optionIds: [] as string[], title: '' };

/** Плитки-счётчики: добавить, изменить, удалить, порядок. Право «Реестры: создание и настройка полей». */
export function TilesDrawer({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const tiles = useQuery({ queryKey: dashkeys.tiles, queryFn: dashboardApi.tiles });
  const regs = useQuery({ queryKey: ['registers', 'list', false], queryFn: () => registersApi.list(false) });
  const [form, setForm] = useState(empty);
  const [editing, setEditing] = useState<Tile | null>(null);
  const reg = useQuery({ queryKey: ['registers', 'detail', form.registerId], queryFn: () => registersApi.get(form.registerId), enabled: !!form.registerId });
  const fields = (reg.data?.fields ?? []).filter((f) => TILE_TYPES.has(f.type) && !f.archived);
  const field = fields.find((f) => f.id === form.fieldId);
  // Закрытые статусы плитка не считает — их и не предлагаем.
  const options = (field?.options ?? []).filter((o) => !o.archived && !(field?.isStatus && o.isClosed));


  const refresh = () => qc.invalidateQueries({ queryKey: dashkeys.all });
  const fail = (e: unknown) => toast(e instanceof Error ? e.message : 'Не удалось сохранить', 'error');
  const save = useMutation({
    mutationFn: () => (editing
      ? dashboardApi.updateTile(editing.id, { version: editing.version, title: form.title, optionIds: form.optionIds })
      : dashboardApi.createTile(form)),
    onSuccess: async (t) => {
      await refresh();
      toast(editing ? `Плитка «${t.title}» изменена` : `Плитка «${t.title}» добавлена на дашборд`);
      setForm(empty);
      setEditing(null);
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (t: Tile) => dashboardApi.deleteTile(t.id, t.version),
    onSuccess: async (_r, t) => { await refresh(); toast(`Плитка «${t.title}» удалена`); },
    onError: fail,
  });
  const move = useMutation({
    mutationFn: ({ t, other }: { t: Tile; other: Tile }) =>
      dashboardApi.updateTile(t.id, { version: t.version, sortOrder: other.sortOrder })
        .then(() => dashboardApi.updateTile(other.id, { version: other.version, sortOrder: t.sortOrder })),
    onSettled: refresh,
    onError: fail,
  });

  const edit = (t: Tile) => {
    setEditing(t);
    setForm({ registerId: t.register.id, fieldId: t.field.id, optionIds: t.options.map((o) => o.id), title: t.title });
  };
  const toggle = (id: string) => setForm((f) => ({ ...f, optionIds: f.optionIds.includes(id) ? f.optionIds.filter((x) => x !== id) : [...f.optionIds, id] }));
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(); };
  const list = tiles.data?.items ?? [];

  return (
    <DetailPanel label="Плитки дашборда" onClose={onClose} eyebrow="Свои счётчики на дашборде" title="Плитки-счётчики">
          <p className="hint">Плитка считает записи реестра, где поле принимает выбранные значения. Закрытые записи и архив не считаются.</p>
          <div className="list">
            {list.length === 0 && <div className="hint">Плиток пока нет</div>}
            {list.map((t, i) => (
              <div key={t.id} className="li">
                <div className="min0">
                  <div className="ellipsis">{t.title}{t.broken && <span className="chip crit tile-broken">не считается: {t.broken}</span>}</div>
                  <div className="m ellipsis">{t.register.name} · {t.field.label}: {t.options.map((o) => o.label).join(', ')}</div>
                </div>
                <div className="row gap6">
                  <button className="btn ghost sm" type="button" aria-label="Выше" disabled={i === 0 || move.isPending} onClick={() => move.mutate({ t, other: list[i - 1] as Tile })}>↑</button>
                  <button className="btn ghost sm" type="button" aria-label="Ниже" disabled={i === list.length - 1 || move.isPending} onClick={() => move.mutate({ t, other: list[i + 1] as Tile })}>↓</button>
                  <button className="btn ghost sm" type="button" disabled={!!t.broken} onClick={() => edit(t)}>Изменить</button>
                  <button className="btn ghost sm" type="button" disabled={remove.isPending} onClick={() => { if (window.confirm(`Удалить плитку «${t.title}»?`)) remove.mutate(t); }}>Удалить</button>
                </div>
              </div>
            ))}
          </div>

          <form className="task-form tile-form" onSubmit={submit} aria-label={editing ? 'Изменить плитку' : 'Новая плитка'}>
            <b>{editing ? `Изменить «${editing.title}»` : 'Новая плитка'}</b>
            <label>Реестр
              <select className="inp" required disabled={!!editing} value={form.registerId} onChange={(e) => setForm({ ...empty, registerId: e.target.value, title: form.title })}>
                <option value="">Выберите реестр</option>
                {regs.data?.items.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </label>
            <label>Поле
              <select className="inp" required disabled={!!editing || !form.registerId} value={form.fieldId} onChange={(e) => setForm({ ...form, fieldId: e.target.value, optionIds: [] })}>
                <option value="">{form.registerId && reg.isSuccess && fields.length === 0 ? 'В реестре нет полей-списков' : 'Выберите поле-список'}</option>
                {fields.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
              </select>
            </label>
            {field && (
              <fieldset className="opts">
                <legend>Значения</legend>
                {options.map((o) => (
                  <label key={o.id} className="check">
                    <input type="checkbox" checked={form.optionIds.includes(o.id)} onChange={() => toggle(o.id)} /> {o.label}
                  </label>
                ))}
              </fieldset>
            )}
            <label>Название плитки<input className="inp" required maxLength={120} placeholder="например, Доступ к соцсетям" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
            <div className="row gap6">
              <button className="btn primary" type="submit" disabled={save.isPending || !form.fieldId || form.optionIds.length === 0}>{editing ? 'Сохранить' : 'Добавить плитку'}</button>
              {editing && <button className="btn" type="button" onClick={() => { setEditing(null); setForm(empty); }}>Отмена</button>}
            </div>
          </form>
    </DetailPanel>
  );
}
