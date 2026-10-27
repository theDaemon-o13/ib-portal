// Имена файлов в архиве выгрузки для проверки (этап 8б): «<№ документа>_<хост>.pdf».
// Несколько хостов — через «_»; длиннее 120 символов — «<№>_<хост1>_и_ещё_N»; недопустимые в именах символы
// заменяются на «-»; совпадающие имена получают «_2», «_3». Чистая функция — проверяется модульными тестами.

export const NAME_MAX = 120;

export interface ZipEntryName {
  docNumber: string;
  hosts: readonly string[];
  /** Расширение без точки: pdf, png, jpg… */
  ext: string;
}

/** Символы, недопустимые в именах файлов Windows и архивов, управляющие символы и пробелы по краям. */
export function safePart(s: string): string {
  // eslint-disable-next-line no-control-regex -- управляющие символы в именах файлов заменяются намеренно
  return s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '');
}

function baseName(e: ZipEntryName): string {
  const doc = safePart(e.docNumber) || 'без номера';
  const hosts = e.hosts.map(safePart).filter(Boolean);
  const full = [doc, ...hosts].join('_');
  if (full.length <= NAME_MAX) return full;
  if (hosts.length > 1) {
    const short = `${doc}_${hosts[0]}_и_ещё_${hosts.length - 1}`;
    if (short.length <= NAME_MAX) return short;
  }
  return full.slice(0, NAME_MAX).replace(/[_ .]+$/, '');
}

/** Имена по порядку записей; совпадения (без учёта регистра) — с суффиксом _2, _3. */
export function zipNames(entries: readonly ZipEntryName[]): string[] {
  const used = new Set<string>();
  return entries.map((e) => {
    const base = baseName(e);
    const ext = safePart(e.ext).toLowerCase() || 'bin';
    let name = `${base}.${ext}`;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base}_${n}.${ext}`;
    used.add(name.toLowerCase());
    return name;
  });
}

const EXT_OF_MIME: Record<string, string> = {
  'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'text/plain': 'txt', 'text/csv': 'csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

export function extOf(mime: string, originalName: string): string {
  return EXT_OF_MIME[mime] ?? (/\.([a-z0-9]{1,8})$/i.exec(originalName)?.[1] ?? 'bin');
}
