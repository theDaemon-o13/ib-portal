import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '../../api/client';
import { chainsApi, tkeys } from '../../api/tasks';
import { useToast } from '../../components/Toast';
import { plural } from './logic';

const n = (k: number, one: string, few: string, many: string) => `${k} ${plural(k, one, few, many)}`;

/**
 * «Системные цепочки реестров» в окне «Найти цепочки среди старых задач» (1.14.0, ADR-0053): автозадачи реестров,
 * созданные до 1.14.0, — в цепочки «Уязвимости · <группа>» и «Реестр · <название>». Предпросмотр: какие цепочки, сколько
 * задач (выполненные и архивные тоже), что не определить. Применение — только после подтверждения; повторный запуск
 * безопасен: задачи с цепочкой и отвязанные вручную пропускаются.
 */
export function SystemDiscoverSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const preview = useQuery({ queryKey: ['tasks', 'chains', 'discover-system'], queryFn: chainsApi.systemDiscoverPreview, staleTime: 0, gcTime: 0 });
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const p = preview.data;
  const created = p ? p.groups.filter((g) => !g.chain).length : 0;

  const apply = async () => {
    if (!p) return;
    if (!confirm) {
      setConfirm(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await chainsApi.systemDiscoverApply(p);
      await qc.invalidateQueries({ queryKey: tkeys.all });
      toast(`Системных цепочек создано: ${r.created}, дополнено: ${r.attached}, задач привязано: ${r.tasks}`);
      setConfirm(false);
      await preview.refetch();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'BULK_CHANGED') {
        setError('Задачи изменились, пока окно было открыто. Предпросмотр обновлён — проверьте и подтвердите ещё раз.');
        setConfirm(false);
        await preview.refetch();
      } else setError(err instanceof Error ? err.message : 'Не удалось применить');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sys-discover" aria-label="Системные цепочки реестров" data-testid="system-discover">
      <h3>Системные цепочки реестров</h3>
      <p className="hint">
        Задачи автоматизаций реестров, созданные до обновления, — в цепочки «Уязвимости · группа» и «Реестр · название», как новые.
        Выполненные и архивные тоже. Задачи, которые кто-то уже отвязывал или переносил, не трогаются.
      </p>
      {preview.isPending && <p className="hint">Ищем…</p>}
      {preview.isError && <p className="form-error">{preview.error.message}</p>}
      {p && p.groups.length === 0 && <div className="note" role="status">Собирать нечего: автозадачи уже в цепочках.</div>}
      {p && p.groups.length > 0 && (
        <ul className="discover-list" aria-label="Системные цепочки">
          {p.groups.map((g) => (
            <li key={`${g.sourceType}:${g.sourceId}`} data-group={g.title}>
              <b>{g.title}</b>
              <span className="hint">
                {' '}· {g.chain ? `добавить в цепочку #${g.chain.number}` : 'новая цепочка'}
                {' '}· {n(g.tasks, 'задача', 'задачи', 'задач')}{g.completed ? `, выполнено ${g.completed}` : ''}{g.archived ? `, в архиве ${g.archived}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      {p && p.unknownTotal > 0 && (
        <details className="sys-unknown" data-testid="system-discover-unknown">
          <summary>Источник не определён: {n(p.unknownTotal, 'задача', 'задачи', 'задач')} — останутся без цепочки</summary>
          <ul>
            {p.unknown.map((u) => <li key={u.id}><b>#{u.number}</b> {u.title} <span className="hint">— {u.reasonLabel}</span></li>)}
            {p.unknownTotal > p.unknown.length && <li className="hint">… и ещё {p.unknownTotal - p.unknown.length}</li>}
          </ul>
        </details>
      )}
      {p && p.skippedManual > 0 && <p className="hint">Пропущено: {n(p.skippedManual, 'задача', 'задачи', 'задач')} — их цепочку менял человек.</p>}
      {confirm && p && (
        <div className="note" role="status" data-testid="system-discover-confirm">
          Будет создано цепочек: {created}, дополнено: {p.groups.length - created}, задач привязано: {p.tasks}. Подтвердите.
        </div>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      {p && p.groups.length > 0 && (
        <div className="row end">
          {confirm && <button className="btn" type="button" disabled={busy} onClick={() => setConfirm(false)}>Отмена</button>}
          <button className="btn primary" type="button" disabled={busy} onClick={() => void apply()}>
            {busy ? 'Выполняется…' : confirm ? 'Подтвердить' : `Собрать системные цепочки (${p.groups.length})`}
          </button>
        </div>
      )}
    </section>
  );
}
