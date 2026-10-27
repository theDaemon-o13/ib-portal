import { useId, useState } from 'react';
import { ACCEPT, filesApi, formatSize, precheck, type FileInfo } from '../../api/files';

/**
 * Выбор и загрузка файлов: каждый файл сразу уходит на backend (проверка типа по содержимому), в форму
 * возвращаются id загруженных. Ошибка по файлу показывается рядом, остальные файлы загружаются.
 */
export function FileUpload({ label, accept = ACCEPT, allowed, multiple = true, value, onChange, required }: {
  label: string;
  accept?: string;
  /** Разрешённые расширения (подсказка до отправки), например ['pdf']. */
  allowed?: readonly string[];
  multiple?: boolean;
  value: FileInfo[];
  onChange: (files: FileInfo[]) => void;
  required?: boolean;
}) {
  const id = useId();
  const [busy, setBusy] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);

  const pick = async (list: FileList | null) => {
    if (!list?.length) return;
    const picked = [...list];
    const problems: string[] = [];
    let next = multiple ? [...value] : [];
    setBusy(picked.length);
    for (const f of picked) {
      const pre = precheck(f, allowed);
      if (pre) {
        problems.push(pre);
      } else {
        try {
          const up = await filesApi.upload(f);
          next = multiple ? [...next, up] : [up];
        } catch (e) {
          problems.push(`«${f.name}»: ${e instanceof Error ? e.message : 'не загружен'}`);
        }
      }
      setBusy((n) => n - 1);
    }
    setErrors(problems);
    onChange(next);
  };

  return (
    <div className="upload">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="inp"
        type="file"
        accept={accept}
        multiple={multiple}
        required={required && value.length === 0}
        disabled={busy > 0}
        onChange={(e) => {
          void pick(e.target.files);
          e.target.value = '';
        }}
      />
      {busy > 0 && <div className="hint">Загрузка… осталось {busy}</div>}
      {value.length > 0 && (
        <div className="file-list">
          {value.map((f) => (
            <span key={f.id} className="file" data-file={f.name}>
              <span className="fn">{f.name}</span>
              <span className="hint">{formatSize(f.size)}</span>
              <button type="button" className="btn ghost sm" aria-label={`Убрать ${f.name}`} onClick={() => onChange(value.filter((x) => x.id !== f.id))}>×</button>
            </span>
          ))}
        </div>
      )}
      {errors.map((e) => <div key={e} className="form-error" role="alert">{e}</div>)}
    </div>
  );
}
