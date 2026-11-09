import { useEffect, useState, type FormEvent } from 'react';
import { registersApi, type RegisterDetail } from '../../api/registers';
import { Overlay } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Select } from '../../components/Select';

/**
 * Выгрузка для проверки (этап 8б): записи за период по полю-дате (с архивными) в Excel и все файлы полей «Файл»
 * одним zip. Имена файлов — «<№ документа>_<хосты>»; в книге — лист «Файлы» с sha256.
 */
export function ExportZipDialog({ reg, onClose }: { reg: RegisterDetail; onClose: () => void }) {
  const toast = useToast();
  const live = reg.fields.filter((f) => !f.archived);
  const dates = live.filter((f) => f.type === 'date');
  // По умолчанию — дата, от которой ограничен срок («Дата документа»), иначе первая дата.
  const anchorId = live.map((f) => f.settings.date?.notAfterYearEndOfFieldId).find(Boolean);
  const texts = live.filter((f) => f.type === 'text');
  const links = live.filter((f) => f.type === 'link');
  const year = new Date().getFullYear();
  const [dateFieldId, setDateFieldId] = useState(anchorId ?? dates[0]?.id ?? '');
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(`${year}-12-31`);
  const [nameFieldId, setNameFieldId] = useState(texts.find((f) => f.label.trim().startsWith('№'))?.id ?? texts.find((f) => f.isTitle)?.id ?? '');
  const [linkFieldId, setLinkFieldId] = useState(links[0]?.id ?? '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { blob, fileName } = await registersApi.exportZip(reg.id, {
        dateFieldId, from: from || undefined, to: to || undefined, nameFieldId: nameFieldId || undefined, linkFieldId: linkFieldId || undefined,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast(`Выгружено: ${fileName}`);
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Не удалось выгрузить', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Overlay>
      <div className="backdrop" role="presentation">
        <form className="modal panel" role="dialog" aria-modal="true" aria-labelledby="zip-title" onSubmit={(e) => void submit(e)}>
          <h2 id="zip-title">Выгрузка для проверки</h2>
          <div className="grid-gap">
            <p className="hint">Записи за период (и из архива) — в Excel, все приложенные файлы — в папке files. Имена файлов: «№ документа_хост.pdf». На листе «Файлы» — sha256 для сверки с оригиналами.</p>
            {dates.length === 0 ? <div className="form-error">В реестре нет поля-даты — выгрузить за период нельзя.</div> : (
              <>
                <label>Период по полю
                  <Select className="inp" value={dateFieldId} onChange={(e) => setDateFieldId(e.target.value)}>
                    {dates.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                  </Select>
                </label>
                <div className="row nowrap">
                  <label>С<input className="inp" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
                  <label>По<input className="inp" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
                </div>
                <label>Номер в имени файла
                  <Select className="inp" value={nameFieldId} onChange={(e) => setNameFieldId(e.target.value)}>
                    {texts.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                  </Select>
                </label>
                {links.length > 0 && (
                  <label>Хосты в имени файла
                    <Select className="inp" value={linkFieldId} onChange={(e) => setLinkFieldId(e.target.value)}>
                      {links.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                    </Select>
                  </label>
                )}
              </>
            )}
            <div className="row">
              <button className="btn primary" type="submit" disabled={busy || !dateFieldId}>{busy ? 'Собираем архив…' : 'Скачать zip'}</button>
              <button className="btn" type="button" onClick={onClose} disabled={busy}>Отмена</button>
            </div>
          </div>
        </form>
      </div>
    </Overlay>
  );
}
