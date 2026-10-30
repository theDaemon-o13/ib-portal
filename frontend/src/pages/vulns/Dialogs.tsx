// Окна раздела «Уязвимости»: группа, тип систем, передача ИКТ, перенос записей.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import type { FileInfo } from '../../api/files';
import { settingsApi } from '../../api/settings';
import { vkeys, vulnsApi, type TransferResult, type VulnGroup } from '../../api/vulns';
import { FileUpload } from '../../components/files/FileUpload';
import { Overlay } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { formatDate } from '../registers/logic';
import { useTodayIso } from './today';

export function Modal({ title, sub, wide, onClose, children, footer }: {
  title: string; sub?: ReactNode; wide?: boolean; onClose: () => void; children: ReactNode; footer: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <Overlay>
      <div className="backdrop" role="presentation">
        <div className={`modal panel${wide ? ' wide-modal' : ''} v-modal`} role="dialog" aria-modal="true" aria-label={title}>
          <h2>{title}</h2>
          {sub && <p className="hint">{sub}</p>}
          {children}
          <div className="row end">{footer}</div>
        </div>
      </div>
    </Overlay>
  );
}

function useSystemTypes() {
  return useQuery({ queryKey: vkeys.systemTypes, queryFn: () => settingsApi.items('system_types', false) });
}

export function GroupDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (g: VulnGroup) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const types = useSystemTypes();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'service' | 'department'>('service');
  const [picked, setPicked] = useState<string[]>([]);
  const create = useMutation({
    mutationFn: () => vulnsApi.createGroup({ name, kind, systemTypeIds: picked }),
    onSuccess: async (g) => {
      await qc.invalidateQueries({ queryKey: vkeys.all });
      toast(`Группа «${g.name}» создана`);
      onCreated(g);
    },
  });
  return (
    <Modal title="Создать группу" sub="Группа — сервис или подразделение. Внутри неё отмечаются типы систем, у каждого свой реестр." onClose={onClose}
      footer={<>
        <button className="btn" type="button" onClick={onClose}>Отмена</button>
        <button className="btn primary" type="button" disabled={!name.trim() || !picked.length || create.isPending} onClick={() => create.mutate()}>Создать</button>
      </>}>
      <label className="fd-label">Название
        <input className="inp" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} placeholder="Например, Хумо Онлайн" aria-label="Название группы" autoFocus />
      </label>
      <div className="fd-label">Вид
        <div className="row">
          {([['service', 'Сервис'], ['department', 'Подразделение']] as const).map(([k, t]) => (
            <label key={k} className="check"><input type="radio" name="group-kind" checked={kind === k} onChange={() => setKind(k)} /> {t}</label>
          ))}
        </div>
      </div>
      <TypeChecks items={types.data?.items ?? []} picked={picked} setPicked={setPicked} />
      <span className="hint">Список берётся из справочника «Типы систем».</span>
      {create.error && <p className="form-error" role="alert">{create.error.message}</p>}
    </Modal>
  );
}

function TypeChecks({ items, picked, setPicked }: { items: { id: string; value: string }[]; picked: string[]; setPicked: (v: string[]) => void }) {
  return (
    <div className="fd-label">Типы систем
      <div className="row">
        {items.map((t) => (
          <label key={t.id} className="check">
            <input type="checkbox" checked={picked.includes(t.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, t.id] : picked.filter((x) => x !== t.id))} /> {t.value}
          </label>
        ))}
      </div>
    </div>
  );
}

export function AddTypeDialog({ group, onClose }: { group: VulnGroup; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const types = useSystemTypes();
  const [picked, setPicked] = useState<string[]>([]);
  const rest = (types.data?.items ?? []).filter((t) => !group.nodes.some((n) => n.systemType?.id === t.id));
  const add = useMutation({
    mutationFn: () => vulnsApi.addNodes(group.id, picked),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: vkeys.all });
      toast('Тип добавлен');
      onClose();
    },
  });
  return (
    <Modal title="Добавить тип систем" sub={group.name} onClose={onClose}
      footer={<>
        <button className="btn" type="button" onClick={onClose}>Отмена</button>
        <button className="btn primary" type="button" disabled={!picked.length || add.isPending} onClick={() => add.mutate()}>Добавить</button>
      </>}>
      {types.isSuccess && !rest.length && <p className="hint">Все типы из справочника уже есть в этой группе.</p>}
      <TypeChecks items={rest} picked={picked} setPicked={setPicked} />
      {add.error && <p className="form-error" role="alert">{add.error.message}</p>}
    </Modal>
  );
}

export function RenameGroupDialog({ group, onClose }: { group: VulnGroup; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(group.name);
  const rename = useMutation({
    mutationFn: () => vulnsApi.renameGroup(group.id, { name, version: group.version }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: vkeys.all });
      toast('Группа переименована');
      onClose();
    },
  });
  return (
    <Modal title="Переименовать группу" onClose={onClose}
      footer={<>
        <button className="btn" type="button" onClick={onClose}>Отмена</button>
        <button className="btn primary" type="button" disabled={!name.trim() || name.trim() === group.name || rename.isPending} onClick={() => rename.mutate()}>Переименовать</button>
      </>}>
      <label className="fd-label">Название
        <input className="inp" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} aria-label="Название группы" autoFocus />
      </label>
      {rename.error && <p className="form-error" role="alert">{rename.error.message}</p>}
    </Modal>
  );
}

export function HandoverDialog({ scan, count, onClose }: { scan: { id: string; scanDate: string }; count: number; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const today = useTodayIso();
  const [date, setDate] = useState(today);
  const [to, setTo] = useState('ОИКТ');
  const [file, setFile] = useState<FileInfo[]>([]);
  const bad = !date || date < scan.scanDate || date > today;
  const send = useMutation({
    mutationFn: () => vulnsApi.handover(scan.id, { date, to, fileId: file[0]?.id ?? null }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: vkeys.all });
      toast(`Передано ИКТ: срок начался у записей — ${r.started}`);
      onClose();
    },
  });
  return (
    <Modal title="Передать ИКТ" sub={`Скан от ${formatDate(scan.scanDate)}. От этой даты пойдёт срок записей скана${count ? ` (${count})` : ''}. Повторная передача и правка даты не предусмотрены.`} onClose={onClose}
      footer={<>
        <button className="btn" type="button" onClick={onClose}>Отмена</button>
        <button className="btn primary" type="button" disabled={bad || !to.trim() || send.isPending} onClick={() => send.mutate()}>Передать ИКТ</button>
      </>}>
      <label className="fd-label">Дата передачи
        <input className="inp" type="date" value={date} min={scan.scanDate} max={today} onChange={(e) => setDate(e.target.value)} aria-label="Дата передачи" />
      </label>
      <label className="fd-label">Кому
        <input className="inp" value={to} maxLength={200} onChange={(e) => setTo(e.target.value)} aria-label="Кому" />
      </label>
      <FileUpload label="Письмо или служебка (по желанию)" multiple={false} value={file} onChange={setFile} />
      {bad && <p className="form-error" role="alert">Дата передачи — от даты скана до сегодня.</p>}
      {send.error && <p className="form-error" role="alert">{send.error.message}</p>}
    </Modal>
  );
}

export function TransferDialog({ recordIds, groups, onClose, onDone }: { recordIds: string[]; groups: VulnGroup[]; onClose: () => void; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const options = groups.filter((g) => !g.system).flatMap((g) => g.nodes.map((n) => ({ id: n.id, label: `${g.name} / ${n.label}` })));
  const [nodeId, setNodeId] = useState('');
  const [result, setResult] = useState<TransferResult | null>(null);
  const move = useMutation({
    mutationFn: () => vulnsApi.transfer(recordIds, nodeId),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: vkeys.all });
      toast(`Перенесено записей: ${r.moved.length}`);
      if (r.rejected.length) setResult(r);
      else onDone();
    },
  });
  return (
    <Modal title={recordIds.length === 1 ? 'Перенести запись' : `Перенести записи: ${recordIds.length}`} sub="Срок из прежнего реестра сохраняется. Ключ «Пакет + Идентификатор», который в узле уже есть, не переносится." onClose={result ? onDone : onClose}
      footer={result
        ? <button className="btn primary" type="button" onClick={onDone}>Закрыть</button>
        : <>
          <button className="btn" type="button" onClick={onClose}>Отмена</button>
          <button className="btn primary" type="button" disabled={!nodeId || move.isPending} onClick={() => move.mutate()}>Перенести</button>
        </>}>
      {!result && (
        <label className="fd-label">Куда
          <select className="inp" value={nodeId} onChange={(e) => setNodeId(e.target.value)} aria-label="Узел">
            <option value="">— выберите группу и тип</option>
            {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </label>
      )}
      {!result && !options.length && <p className="hint">Групп пока нет: сначала создайте группу.</p>}
      {result && (
        <>
          <p>Перенесено: {result.moved.length}. Не перенесено: {result.rejected.length}.</p>
          <ul className="warn-list">
            {result.rejected.map((r) => <li key={r.id}>{r.number ? `#${r.number}` : ''} {r.title}: {r.reason}</li>)}
          </ul>
        </>
      )}
      {move.error && <p className="form-error" role="alert">{move.error.message}</p>}
    </Modal>
  );
}
