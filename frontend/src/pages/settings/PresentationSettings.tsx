// «Настройки → Презентация» (этап Д5): строка «Спроектировано» в правом нижнем углу слайдов самооценки.
// Право «Настройки»; изменение — в журнале. «Подготовил» в презентации — всегда ФИО того, кто её открыл.
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { settingsApi } from '../../api/settings';
import { keys, useAction } from './useAction';

const presentationKey = ['settings', 'presentation'] as const;

export function PresentationSettings() {
  const q = useQuery({ queryKey: presentationKey, queryFn: settingsApi.presentation });
  const [draft, setDraft] = useState<string | null>(null);
  const save = useAction(settingsApi.setPresentation, {
    invalidate: [presentationKey, ['assessments', 'presentation'], keys.journal],
    success: () => 'Подпись сохранена',
    onDone: () => setDraft(null),
  });
  if (q.isPending) return <div className="panel panel-b hint">Загрузка…</div>;
  if (q.isError) return <div className="panel panel-b hint">Не удалось загрузить: {q.error.message}</div>;
  const value = draft ?? q.data.signature;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ signature: value, version: q.data.version });
  };
  return (
    <div className="panel">
      <div className="panel-h"><h3>Презентация самооценки</h3></div>
      <form className="panel-b form" onSubmit={submit}>
        <p className="hint">
          Первая строка подписи в правом нижнем углу каждого слайда. Вторая — «Подготовил: …» — имя того, кто открыл презентацию,
          её ввести нельзя. Владелец раздела подпись не меняет.
        </p>
        <label className="fd-label">Спроектировано
          <input className="inp" required maxLength={200} value={value} onChange={(e) => setDraft(e.target.value)} />
        </label>
        <div className="sa-sign-preview hint" aria-label="Как будет на слайде">
          <div>Спроектировано: {value.trim() || '…'}</div>
          <div>Подготовил: &lt;ФИО того, кто открыл презентацию&gt;</div>
        </div>
        <div className="row">
          <button className="btn primary" type="submit" disabled={save.isPending || draft === null || !value.trim()}>Сохранить</button>
        </div>
      </form>
    </div>
  );
}
