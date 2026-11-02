// «Настройки → Корзина» (1.6.1, ADR-0033): события удаления — что, кто, когда, причина, сколько скрыто.
// Просмотр — сотрудник ИБ, восстановление целым событием — супер-администратор. Адрес: ?scope=vulns&nodeId=…&id=…
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { rkeys } from '../registers/keys';
import { trashApi, trashKeys, type Deletion, type DeletionEntity, type TrashQuery } from '../../api/trash';
import { vkeys } from '../../api/vulns';
import { useToast } from '../../components/Toast';
import { formatDate } from '../registers/logic';
import { formatDateTime } from './logic';
import { deletionCounts, deletionReason } from './trash';

const ENTITY_FILTERS: { value: '' | DeletionEntity | 'vulns'; label: string }[] = [
  { value: '', label: 'Всё' },
  { value: 'vulns', label: 'Раздел «Уязвимости»' },
  { value: 'register', label: 'Реестры' },
  { value: 'vuln_group', label: 'Группы уязвимостей' },
  { value: 'vuln_node', label: 'Типы систем в группах' },
  { value: 'register_records', label: 'Записи' },
];

function TrashRow({ d, focus, canRestore }: { d: Deletion; focus: boolean; canRestore: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [newName, setNewName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const restore = useMutation({
    mutationFn: () => trashApi.restore(d.id, newName ?? undefined),
    onSuccess: async () => {
      toast(`Восстановлено: ${d.entityLabel.toLowerCase()} «${d.title}»`);
      setError(null);
      await Promise.all([trashKeys.all, vkeys.all, rkeys.list].map((queryKey) => qc.invalidateQueries({ queryKey })));
    },
    onError: (err) => {
      // Название занято, пока объект был в корзине: восстановить под другим.
      if (err instanceof ApiError && err.code === 'NAME_TAKEN') setNewName(newName ?? `${d.title} (восстановлено)`);
      setError(err instanceof Error ? err.message : 'Не удалось восстановить');
    },
  });
  const restored = d.restoredAt !== null;
  return (
    <div className={`trash-row${restored ? ' restored' : ''}${focus ? ' focus' : ''}`} data-testid="trash-row">
      <div className="min0">
        <div><b>{d.entityLabel}: «{d.title}»</b>{d.path && <span className="hint"> · {d.path}</span>}</div>
        <div>{deletionCounts(d)}{d.openRecords > 0 && <span className="v-over"> · открытых на момент удаления: {d.openRecords}</span>}</div>
        <div>Причина: {deletionReason(d)}</div>
        {d.items.length > 0 && (
          <ul className="trash-items">
            {d.items.map((i) => (
              <li key={i.number}>
                #{i.number} {i.title}{i.status ? ` · ${i.status}` : ''}{i.due ? ` · срок ${formatDate(i.due)}` : ''}
              </li>
            ))}
            {(d.counts.records ?? 0) > d.items.length && <li>…и ещё {(d.counts.records ?? 0) - d.items.length}</li>}
          </ul>
        )}
        <div className="trash-meta">
          Удалено {formatDateTime(d.deletedAt)} · {d.deletedBy}
          {restored && <> · восстановлено {formatDateTime(d.restoredAt ?? '')} · {d.restoredBy}</>}
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
      {!restored && canRestore && (
        <div className="row nowrap">
          {newName !== null && <input className="inp" value={newName} onChange={(e) => setNewName(e.target.value)} aria-label="Новое название" />}
          <button className="btn sm" type="button" disabled={restore.isPending || newName === ''} onClick={() => restore.mutate()}>
            {restore.isPending ? 'Восстанавливаем…' : 'Восстановить'}
          </button>
        </div>
      )}
    </div>
  );
}

export function TrashTab({ canRestore }: { canRestore: boolean }) {
  const [params, setParams] = useSearchParams();
  const entityParam = params.get('entity') as DeletionEntity | null;
  const scope = params.get('scope') === 'vulns' ? 'vulns' : undefined;
  const [showRestored, setShowRestored] = useState(false);
  const q: TrashQuery = {
    ...(entityParam ? { entity: entityParam } : {}),
    ...(scope ? { scope } : {}),
    ...(params.get('nodeId') ? { nodeId: params.get('nodeId') ?? undefined } : {}),
    ...(params.get('groupId') ? { groupId: params.get('groupId') ?? undefined } : {}),
    ...(showRestored ? {} : { restored: false }),
  };
  const focus = params.get('id');
  const list = useInfiniteQuery({
    queryKey: trashKeys.list(q),
    queryFn: ({ pageParam }) => trashApi.list({ ...q, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const filterValue = scope ?? entityParam ?? '';
  const pickFilter = (v: string) => setParams(v === '' ? {} : v === 'vulns' ? { scope: 'vulns' } : { entity: v }, { replace: true });
  return (
    <section className="panel" data-testid="trash">
      <div className="panel-h">
        <h3>Корзина</h3>
        <span className="hint">Удалённое не стирается: реестры, группы, типы систем и записи скрыты вместе со всем, что скрыло это удаление. {canRestore ? 'Восстановление возвращает всё событие целиком.' : 'Восстановить может супер-администратор.'}</span>
      </div>
      <div className="trash-filters">
        <select className="inp" value={filterValue} aria-label="Что удалено" onChange={(e) => pickFilter(e.target.value)}>
          {ENTITY_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
        {(params.get('nodeId') || params.get('groupId')) && <span className="chip">только выбранная группа или тип <button className="btn sm ghost" type="button" onClick={() => pickFilter('vulns')}>×</button></span>}
        <label className="check"><input type="checkbox" checked={showRestored} onChange={(e) => setShowRestored(e.target.checked)} /> Показать восстановленные</label>
      </div>
      {list.isError && <div className="panel-b form-error">{list.error.message}</div>}
      {list.isSuccess && items.length === 0 && <div className="panel-b hint">Корзина пуста.</div>}
      {items.map((d) => <TrashRow key={d.id} d={d} focus={d.id === focus} canRestore={canRestore} />)}
      {list.hasNextPage && (
        <div className="panel-b"><button className="btn sm" type="button" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>Показать ещё</button></div>
      )}
    </section>
  );
}
