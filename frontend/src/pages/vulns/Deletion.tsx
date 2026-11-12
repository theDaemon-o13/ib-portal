// Удаление в разделе «Уязвимости» (1.6.1, ADR-0033): группа и тип систем — мягко, только без открытых записей;
// счётчик «Удалено записей» за период по причинам со ссылкой на корзину.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { trashKeys } from '../../api/trash';
import { vkeys, vulnsApi, type VulnGroup, type VulnNode } from '../../api/vulns';
import { DeleteDialog } from '../../components/DeleteDialog';
import { Overlay } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { plural } from '../registers/compare';
import { vulnDeleteBlock, vulnDeleteLines } from '../settings/trash';
import { useTodayIso } from './today';
import { Select } from '../../components/Select';

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
      <Select className="inp sm" value={days} aria-label="Период удалений" onChange={(e) => setDays(Number(e.target.value) as typeof days)}>
        {PERIODS.map((d) => <option key={d} value={d}>{d} дн.</option>)}
      </Select>
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

/**
 * «Аннулировать скан» (1.13.12, ADR-0052): причина из списка («Другое» — с текстом), прямое предупреждение, что изменения
 * реестра не откатываются. Скан уходит в корзину; восстановить может супер-администратор.
 */
const ANNUL_REASONS = [
  { code: 'reupload', label: 'Повторная загрузка' },
  { code: 'wrong_file', label: 'Ошибочный файл' },
  { code: 'other', label: 'Другое' },
] as const;

export function AnnulScanDialog({ scan, onClose }: { scan: { id: string; nodeId: string; scanDate: string; fileName: string }; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState<(typeof ANNUL_REASONS)[number]['code']>('reupload');
  const [comment, setComment] = useState('');
  const annul = useMutation({
    mutationFn: () => vulnsApi.annulScan(scan.id, { reason, comment: comment.trim() || null }),
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: vkeys.all }), qc.invalidateQueries({ queryKey: trashKeys.all })]);
      toast('Скан аннулирован');
      onClose();
    },
  });
  const ready = !annul.isPending && (reason !== 'other' || comment.trim() !== '');
  return (
    <Overlay>
      <div className="backdrop" role="presentation">
        <form className="modal panel delete-dialog" role="dialog" aria-modal="true" aria-labelledby="annul-title" data-testid="annul-dialog"
          onSubmit={(e) => { e.preventDefault(); if (ready) annul.mutate(); }}>
          <h2 id="annul-title">Аннулировать скан {scan.scanDate.split('-').reverse().join('.')}</h2>
          <p className="note v-warn">Изменения, которые этот скан внёс в реестр, не откатываются. Скан остаётся в истории с отметкой «Аннулирован».</p>
          <p className="hint">Скан пропадёт из дерева, из «Сканы ждут передачи ИКТ» и не будет «прошлым» для следующего импорта. Файл, находки и сравнение сохраняются. Восстановить может супер-администратор в корзине.</p>
          <label>Причина
            <Select className="inp" value={reason} onChange={(e) => setReason(e.target.value as typeof reason)} aria-label="Причина">
              {ANNUL_REASONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
            </Select>
          </label>
          <label>{reason === 'other' ? 'Опишите причину' : 'Комментарий (необязательно)'}
            <textarea className="inp" maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} aria-label="Комментарий" required={reason === 'other'} />
          </label>
          {annul.error && <p className="form-error" role="alert">{annul.error.message}</p>}
          <div className="row end">
            <button className="btn" type="button" onClick={onClose} disabled={annul.isPending}>Отмена</button>
            <button className="btn danger" type="submit" disabled={!ready}>{annul.isPending ? 'Аннулируем…' : 'Аннулировать'}</button>
          </div>
        </form>
      </div>
    </Overlay>
  );
}
