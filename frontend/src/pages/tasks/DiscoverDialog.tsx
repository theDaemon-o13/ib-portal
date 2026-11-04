import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { chainsApi, tkeys, type DiscoverGroup } from '../../api/tasks';
import { Overlay } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { plural } from './logic';

/**
 * «Найти цепочки среди старых задач» (1.7.0, ADR-0035): предпросмотр групп задач без цепочки с одинаковой темой
 * (от двух задач, включая выполненные и архивные), выбор групп, применение — только после подтверждения.
 * Повторный запуск безопасен: задачи с цепочкой в поиск не попадают.
 */
export function DiscoverDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const preview = useQuery({ queryKey: ['tasks', 'chains', 'discover'], queryFn: chainsApi.discoverPreview, staleTime: 0, gcTime: 0 });
  const groups = preview.data?.groups ?? [];
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picked = groups.filter((g) => !off.has(g.key));
  const created = picked.filter((g) => !g.target).length;
  const attached = picked.length - created;
  const tasks = picked.reduce((s, g) => s + g.tasks.length, 0);
  const toggle = (g: DiscoverGroup) => {
    setConfirm(false);
    setOff((s) => { const n = new Set(s); if (n.has(g.key)) n.delete(g.key); else n.add(g.key); return n; });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!confirm) {
      setConfirm(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await chainsApi.discoverApply({
        groups: picked.map((g) => ({ key: g.key, title: g.title, tasks: g.tasks.map((t) => ({ id: t.id, version: t.version })), chainId: g.target?.id ?? null })),
      });
      await qc.invalidateQueries({ queryKey: tkeys.all });
      toast(`Цепочек создано: ${r.created}, дополнено: ${r.attached}, задач привязано: ${r.tasks}`);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'BULK_CHANGED') {
        setError('Задачи изменились, пока окно было открыто. Предпросмотр обновлён — проверьте и подтвердите ещё раз.');
        setConfirm(false);
        setOff(new Set());
        await preview.refetch();
      } else setError(err instanceof Error ? err.message : 'Не удалось применить');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Overlay>
      <div className="backdrop" role="presentation">
        <form className="modal panel discover-dialog" role="dialog" aria-modal="true" aria-labelledby="dc-title" onSubmit={(e) => void submit(e)}>
          <h2 id="dc-title">Найти цепочки среди старых задач</h2>
          <p className="hint">Задачи без цепочки с одинаковой темой («RE: тема» и «тема»), от двух задач, в том числе выполненные и архивные. Системные задачи (документы, автоматизации, доказательства) не участвуют. Ничего не меняется, пока вы не подтвердите.</p>
          {preview.isPending && <p className="hint">Ищем…</p>}
          {preview.isError && <p className="form-error">{preview.error.message}</p>}
          {preview.isSuccess && groups.length === 0 && <div className="note" role="status">Совпадений нет: все задачи с одинаковой темой уже в цепочках.</div>}
          {groups.length > 0 && (
            <>
              <div className="row">
                <b>Найдено групп: {preview.data?.total}</b>
                {preview.data && preview.data.total > groups.length && <span className="hint">показаны {groups.length} самых больших</span>}
                <button className="btn ghost sm" type="button" onClick={() => { setConfirm(false); setOff(new Set()); }}>Выбрать все</button>
                <button className="btn ghost sm" type="button" onClick={() => { setConfirm(false); setOff(new Set(groups.map((g) => g.key))); }}>Снять все</button>
              </div>
              <ul className="discover-list" aria-label="Группы задач">
                {groups.map((g) => (
                  <li key={g.key} data-group={g.title}>
                    <label className="check">
                      <input type="checkbox" checked={!off.has(g.key)} onChange={() => toggle(g)} aria-label={`Объединить: ${g.title}`} />
                      <span className="dg-t">
                        <b>{g.title}</b>
                        <span className="hint">
                          {' '}· {g.target ? `добавить в цепочку #${g.target.number} «${g.target.title}»` : 'новая цепочка'}
                          {' '}· {g.tasks.length} {plural(g.tasks.length, 'задача', 'задачи', 'задач')}: {g.tasks.slice(0, 6).map((t) => `#${t.number}${t.completed ? ' (выполнена)' : ''}${t.archived ? ' (в архиве)' : ''}`).join(', ')}{g.tasks.length > 6 ? '…' : ''}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
          {confirm && (
            <div className="note" role="status" data-testid="discover-confirm">
              Будет создано цепочек: {created}, дополнено: {attached}, задач привязано: {tasks}. Подтвердите.
            </div>
          )}
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="row end">
            <button className="btn" type="button" onClick={onClose} disabled={busy}>Отмена</button>
            <button className="btn primary" type="submit" disabled={!picked.length || busy || !preview.isSuccess}>
              {busy ? 'Выполняется…' : confirm ? 'Подтвердить' : `Объединить выбранные (${picked.length})`}
            </button>
          </div>
        </form>
      </div>
    </Overlay>
  );
}
