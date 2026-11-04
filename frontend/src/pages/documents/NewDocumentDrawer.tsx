import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { docsApi, dkeys } from '../../api/documents';
import { settingsApi } from '../../api/settings';
import { DetailPanel } from '../../components/DetailPanel';
import { useToast } from '../../components/Toast';

export function NewDocumentDrawer({ meId, onClose, onCreated }: { meId: string; onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const types = useQuery({ queryKey: dkeys.types, queryFn: () => settingsApi.items('document_types', false) });
  const people = useQuery({ queryKey: ['settings', 'userOptions'], queryFn: settingsApi.userOptions });
  const [form, setForm] = useState({ title: '', typeId: '', ownerId: meId, onlyofficeUrl: '', edition: '', reviewMonths: 12 });
  const typeId = form.typeId || types.data?.items[0]?.id || '';


  const create = useMutation({
    mutationFn: () => docsApi.create({ ...form, typeId }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: dkeys.all });
      toast(`Документ #${r.document?.number ?? ''} создан: версия 1, черновик`);
      if (r.document) onCreated(r.document.id);
      else onClose();
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Не удалось создать документ', 'error'),
  });
  const submit = (e: FormEvent) => { e.preventDefault(); create.mutate(); };

  return (
    <DetailPanel label="Новый документ" onClose={onClose} eyebrow="Документ начнёт маршрут с драфта" title="Новый документ">
          <form className="task-form" onSubmit={submit}>
            <label>Название<input className="inp" required maxLength={300} placeholder="например, Политика информационной безопасности" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
            <div className="fgrid">
              <label>Тип документа
                <select className="inp" required value={typeId} onChange={(e) => setForm({ ...form, typeId: e.target.value })}>
                  {types.data?.items.map((t) => <option key={t.id} value={t.id}>{t.value}</option>)}
                </select>
              </label>
              <label>Владелец
                <select className="inp" required value={form.ownerId} onChange={(e) => setForm({ ...form, ownerId: e.target.value })}>
                  {people.data?.items.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
                </select>
              </label>
              <label>Редакция<input className="inp" maxLength={20} placeholder="например, 1.0" value={form.edition} onChange={(e) => setForm({ ...form, edition: e.target.value })} /></label>
              <label>Цикл пересмотра, мес.
                <input className="inp" type="number" min={1} max={60} required value={form.reviewMonths} onChange={(e) => setForm({ ...form, reviewMonths: Number(e.target.value) })} />
              </label>
            </div>
            <label>Ссылка на файл в OnlyOffice
              <input className="inp" type="url" required maxLength={2000} placeholder="https://" value={form.onlyofficeUrl} onChange={(e) => setForm({ ...form, onlyofficeUrl: e.target.value })} />
            </label>
            <div className="hint">Файл остаётся в OnlyOffice. Владелец — сотрудник ИБ: ему придут задачи на доработку и пересмотр. Номер версии портал ставит сам, редакция — для отображения.</div>
            <div className="row">
              <button className="btn primary" type="submit" disabled={create.isPending || !typeId}>Создать черновик</button>
              <button className="btn" type="button" onClick={onClose}>Отмена</button>
            </div>
          </form>
    </DetailPanel>
  );
}
