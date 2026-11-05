// «Письмо из шаблона» (1.9.0; docs/specs/awareness.md, раздел 17.2): форма — по полю на переменную, плюс название,
// тип и повод. Значения — простой текст (backend экранирует), пустая переменная — 400 со списком, письмо не создаётся.
// Из задачи рассылки (taskId) — письмо плановое и привязывается к задаче и запуску.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { awarenessApi, awarenessKeys, type LetterKind, type LetterSave } from '../../api/awareness';
import { useToast } from '../../components/Toast';
import { FormDialog } from './FormDialog';

export function FromTemplateDialog({ templateId: fixed, taskId, defaultTitle = '', onClose, onCreated }: {
  templateId?: string;
  taskId?: string;
  defaultTitle?: string;
  onClose: () => void;
  onCreated: (r: LetterSave) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [templateId, setTemplateId] = useState(fixed ?? '');
  const [title, setTitle] = useState(defaultTitle);
  const [kind, setKind] = useState<LetterKind>('planned');
  const [reason, setReason] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const list = useQuery({ queryKey: awarenessKeys.templates, queryFn: () => awarenessApi.templates(), enabled: !fixed });
  const t = useQuery({ queryKey: awarenessKeys.template(templateId), queryFn: () => awarenessApi.template(templateId), enabled: !!templateId });
  useEffect(() => {
    if (t.data && !title) setTitle(t.data.title);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.data]);

  const create = useMutation({
    mutationFn: () => (taskId
      ? awarenessApi.fromTask(taskId, { title, templateId, values })
      : awarenessApi.fromTemplate(templateId, { title, kind, ...(kind === 'urgent' ? { reason } : {}), values })),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: awarenessKeys.letters });
      await qc.invalidateQueries({ queryKey: ['tasks'] });
      toast(`Создано письмо № ${r.letter.number} из шаблона`);
      r.warnings.forEach((w) => toast(w, 'warn'));
      onCreated(r);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Не удалось создать письмо'),
  });

  const vars = t.data?.variables ?? [];
  const missing = vars.filter((v) => !(values[v.key] ?? '').trim());
  return (
    <FormDialog title="Письмо из шаблона" submit="Создать письмо" busy={create.isPending} error={error} testId="from-template-dialog"
      disabled={!templateId || !t.data || !title.trim() || missing.length > 0 || (kind === 'urgent' && !reason.trim())}
      onClose={onClose} onSubmit={() => { setError(null); create.mutate(); }}>
      {!fixed && (
        <label>Шаблон
          <select className="inp" required value={templateId} onChange={(e) => { setTemplateId(e.target.value); setValues({}); setTitle(''); }}>
            <option value="" disabled>Выберите шаблон…</option>
            {list.data?.items.map((x) => <option key={x.id} value={x.id}>{x.title}{x.tooLarge ? ' — больше лимита' : ''}</option>)}
          </select>
        </label>
      )}
      {t.data?.tooLarge && <div className="note aw-warn" role="status">Шаблон больше текущего лимита: {t.data.tooLarge}</div>}
      <label>Название письма (для списков)
        <input className="inp" required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      {!taskId && (
        <div className="fgrid">
          <label>Тип
            <select className="inp" value={kind} onChange={(e) => setKind(e.target.value as LetterKind)}>
              <option value="planned">Плановое</option>
              <option value="urgent">Срочное</option>
            </select>
          </label>
          {kind === 'urgent' && (
            <label>Повод<input className="inp" required maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          )}
        </div>
      )}
      {vars.length > 0 && (
        <fieldset className="aw-vars">
          <legend>Переменные шаблона — простой текст</legend>
          {vars.map((v, i) => (
            <label key={v.key}>{v.label}
              <input className="inp" maxLength={1000} required autoFocus={i === 0} value={values[v.key] ?? ''}
                onChange={(e) => setValues({ ...values, [v.key]: e.target.value })} />
            </label>
          ))}
        </fieldset>
      )}
      {t.data && vars.length === 0 && <p className="hint">В шаблоне нет переменных — письмо будет копией шаблона.</p>}
      {missing.length > 0 && t.data && <p className="hint">Заполните: {missing.map((v) => `«${v.label}»`).join(', ')}</p>}
    </FormDialog>
  );
}
