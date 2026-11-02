// Удаление в разделе «Уязвимости» (1.6.1, ADR-0033): группа и тип систем — мягко, только без открытых записей;
// счётчик «Удалено записей» за период по причинам со ссылкой на корзину.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { trashKeys } from '../../api/trash';
import { vkeys, vulnsApi, type VulnGroup, type VulnNode } from '../../api/vulns';
import { DeleteDialog } from '../../components/DeleteDialog';
import { useToast } from '../../components/Toast';
import { plural } from '../registers/compare';
import { vulnDeleteBlock, vulnDeleteLines } from '../settings/trash';
import { useTodayIso } from './today';

export function DeleteGroupDialog({ group, onClose, onDeleted }: { group: VulnGroup; onClose: () => void; onDeleted: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const preview = useQuery({ queryKey: ['vulns', 'delete-preview', 'group', group.id], queryFn: () => vulnsApi.deleteGroupPreview(group.id), gcTime: 0 });
  const remove = useMutation({
    mutationFn: (reason: string) => vulnsApi.deleteGroup(group.id, reason, group.name),
    onSuccess: async () => {
      toast(`Группа «${group.name}» удалена — она в корзине`);
      onDeleted();
      await Promise.all([qc.invalidateQueries({ queryKey: vkeys.all }), qc.invalidateQueries({ queryKey: trashKeys.all })]);
    },
  });
  const p = preview.data;
  return (
    <DeleteDialog title={`Удалить группу «${group.name}»`} lines={p ? vulnDeleteLines(p, true) : null} blocked={p ? vulnDeleteBlock(p) : null}
      confirmName={group.name} busy={remove.isPending} error={(preview.error ?? remove.error)?.message ?? null}
      onConfirm={(reason) => remove.mutate(reason)} onClose={onClose} />
  );
}

export function DeleteNodeDialog({ group, node, onClose, onDeleted }: { group: VulnGroup; node: VulnNode; onClose: () => void; onDeleted: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const preview = useQuery({ queryKey: ['vulns', 'delete-preview', 'node', node.id], queryFn: () => vulnsApi.deleteNodePreview(node.id), gcTime: 0 });
  const remove = useMutation({
    mutationFn: (reason: string) => vulnsApi.deleteNode(node.id, reason),
    onSuccess: async () => {
      toast(`Тип «${node.label}» удалён из группы «${group.name}» — он в корзине`);
      onDeleted();
      await Promise.all([qc.invalidateQueries({ queryKey: vkeys.all }), qc.invalidateQueries({ queryKey: trashKeys.all })]);
    },
  });
  const p = preview.data;
  return (
    <DeleteDialog title={`Удалить тип «${node.label}» из группы «${group.name}»`} lines={p ? vulnDeleteLines(p, false) : null} blocked={p ? vulnDeleteBlock(p) : null}
      confirmName={null} busy={remove.isPending} error={(preview.error ?? remove.error)?.message ?? null}
      onConfirm={(reason) => remove.mutate(reason)} onClose={onClose} />
  );
}

const PERIODS = [30, 90, 365] as const;

function minusDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** «Удалено записей» за период по причинам (восстановленные не считаются); ссылка — корзина с тем же охватом. */
export function DeletedStats({ scope }: { scope: { nodeId?: string; groupId?: string } }) {
  const today = useTodayIso();
  const [days, setDays] = useState<(typeof PERIODS)[number]>(30);
  const from = minusDays(today, days);
  const stats = useQuery({ queryKey: vkeys.deletionStats(scope, from, today), queryFn: () => vulnsApi.deletionStats(scope, from, today) });
  const s = stats.data;
  const q = new URLSearchParams({ scope: 'vulns', ...(scope.nodeId ? { nodeId: scope.nodeId } : {}), ...(scope.groupId ? { groupId: scope.groupId } : {}) });
  return (
    <div className="v-deleted row" data-testid="deleted-stats">
      <span>Удалено записей за</span>
      <select className="inp sm" value={days} aria-label="Период удалений" onChange={(e) => setDays(Number(e.target.value) as typeof days)}>
        {PERIODS.map((d) => <option key={d} value={d}>{d} дн.</option>)}
      </select>
      <b>{s?.total ?? '…'}</b>
      {s && s.total > 0 && (
        <span className="hint">
          {s.byReason.map((r) => `${r.label} — ${r.count}`).join(', ')}
          {s.open > 0 && <span className="v-over"> · {plural(s.open, 'была открыта', 'были открыты', 'были открыты')}</span>}
        </span>
      )}
      <Link to={`/settings/trash?${q.toString()}`}>Корзина</Link>
    </div>
  );
}
