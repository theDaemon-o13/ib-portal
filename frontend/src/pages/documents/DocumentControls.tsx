// Вкладка «Механизмы контроля» карточки утверждённого документа (1.11.0, ADR-0043). Решает backend: canManage —
// владелец, начальник ИБ (отметка), «Документы: управление»; остальные сотрудники ИБ только читают.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '../../api/client';
import { controlsApi, dkeys, type DocControl, type DocControlFields } from '../../api/documents';
import { useToast } from '../../components/Toast';

type Fields = Required<{ [K in keyof DocControlFields]: string }>;
const EMPTY: Fields = { clause: '', requirement: '', mechanism: '', checkMethod: '', expectedEvidence: '', executorUnit: '' };
const fieldsOf = (c: DocControl): Fields => ({
  clause: c.clause, requirement: c.requirement, mechanism: c.mechanism, checkMethod: c.checkMethod, expectedEvidence: c.expectedEvidence, executorUnit: c.executorUnit,
});

function ControlForm({ value, onChange, label }: { value: Fields; onChange: (v: Fields) => void; label: string }) {
  const set = (k: keyof Fields) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value });
  return (
    <>
      <div className="fgrid">
        <label>Пункт или раздел документа<input className="inp" maxLength={300} placeholder="например, п. 4.2" value={value.clause} onChange={set('clause')} /></label>
        <label>Подразделение-исполнитель<input className="inp" maxLength={300} value={value.executorUnit} onChange={set('executorUnit')} /></label>
      </div>
      <label>Требование<input className="inp" required maxLength={2000} aria-label={`${label}: требование`} value={value.requirement} onChange={set('requirement')} /></label>
      <label>Механизм контроля со стороны ИБ<textarea className="inp" required maxLength={4000} value={value.mechanism} onChange={set('mechanism')} /></label>
      <label>Способ проверки<textarea className="inp" maxLength={4000} value={value.checkMethod} onChange={set('checkMethod')} /></label>
      <label>Ожидаемое доказательство<textarea className="inp" maxLength={4000} value={value.expectedEvidence} onChange={set('expectedEvidence')} /></label>
    </>
  );
}

export function DocumentControls({ docId }: { docId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: dkeys.controls(docId), queryFn: () => controlsApi.list(docId) });
  const [mode, setMode] = useState<{ kind: 'add' } | { kind: 'edit'; c: DocControl } | null>(null);
  const [form, setForm] = useState<Fields>(EMPTY);
  const [stale, setStale] = useState<string | null>(null);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: dkeys.controls(docId) }), qc.invalidateQueries({ queryKey: ['documents', 'list'] })]);
  const close = () => { setMode(null); setForm(EMPTY); };
  const onError = (e: unknown) => {
    if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') { setStale(e.message); return; }
    toast(e instanceof Error ? e.message : 'Не удалось сохранить', 'error');
  };
  const create = useMutation({ mutationFn: () => controlsApi.create(docId, form), onSuccess: async () => { close(); await refresh(); toast('Механизм контроля добавлен'); }, onError });
  const update = useMutation({
    mutationFn: (x: { c: DocControl; patch: Partial<Fields> & { active?: boolean } }) => controlsApi.update(docId, x.c.id, { version: x.c.version, ...x.patch }),
    onSuccess: async (_r, x) => { close(); await refresh(); toast(x.patch.active === false ? 'Механизм отключён' : x.patch.active === true ? 'Механизм включён' : 'Механизм контроля сохранён'); },
    onError,
  });
  const busy = create.isPending || update.isPending;

  if (list.isError) return <div className="form-error">{list.error.message}</div>;
  if (!list.data) return <div className="hint">Загружаем механизмы контроля</div>;
  const { items, canManage } = list.data;

  return (
    <div aria-label="Механизмы контроля" data-testid="doc-controls">
      {stale && (
        <div className="note conflict" role="alert">
          {stale}
          <div className="row mt6"><button className="btn sm primary" type="button" onClick={() => { setStale(null); close(); void refresh(); }}>Перечитать</button></div>
        </div>
      )}
      {items.length === 0 && <div className="hint">Механизмов контроля пока нет. {canManage ? 'Добавьте требование документа и то, как ИБ проверяет его выполнение.' : ''}</div>}
      <div className="hist">
        {items.map((c) => (
          <div key={c.id} className={`hist-item${c.active ? '' : ' muted'}`} data-control={c.position}>
            <div className="row">
              <b>{c.position}. {c.requirement}</b>
              {c.clause && <span className="hint">{c.clause}</span>}
              {!c.active && <span className="chip">отключён</span>}
            </div>
            <div className="m">{c.mechanism}</div>
            {c.checkMethod && <div className="hint">Способ проверки: {c.checkMethod}</div>}
            {c.expectedEvidence && <div className="hint">Доказательство: {c.expectedEvidence}</div>}
            {c.executorUnit && <div className="hint">Исполнитель требования: {c.executorUnit}</div>}
            {canManage && !mode && (
              <div className="row">
                <button type="button" className="btn ghost sm" disabled={busy} onClick={() => { setForm(fieldsOf(c)); setMode({ kind: 'edit', c }); }}>Изменить</button>
                <button type="button" className="btn ghost sm" disabled={busy} onClick={() => update.mutate({ c, patch: { active: !c.active } })}>{c.active ? 'Отключить' : 'Включить'}</button>
              </div>
            )}
          </div>
        ))}
      </div>
      {canManage && !mode && <div className="row"><button type="button" className="btn sm" onClick={() => { setForm(EMPTY); setMode({ kind: 'add' }); }}>Добавить механизм контроля</button></div>}
      {mode && (
        <form className="task-form" aria-label={mode.kind === 'add' ? 'Новый механизм контроля' : 'Механизм контроля'}
          onSubmit={(e) => { e.preventDefault(); if (mode.kind === 'add') create.mutate(); else update.mutate({ c: mode.c, patch: form }); }}>
          <ControlForm value={form} onChange={setForm} label={mode.kind === 'add' ? 'Новый механизм' : 'Механизм'} />
          <div className="row">
            <button className="btn primary" type="submit" disabled={busy || !form.requirement.trim() || !form.mechanism.trim()}>{mode.kind === 'add' ? 'Добавить' : 'Сохранить'}</button>
            <button className="btn" type="button" onClick={close}>Отмена</button>
          </div>
        </form>
      )}
    </div>
  );
}
