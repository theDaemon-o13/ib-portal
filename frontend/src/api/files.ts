// Файлы портала (этап 7): загрузка телом запроса, содержимое — blob для предпросмотра и сохранения.
// Тип файла окончательно проверяет backend по содержимому; здесь — только подсказка до отправки.
import { ApiError, request, type JsonOf } from './client';
import type { paths } from './generated/schema';

export type FileInfo = JsonOf<paths['/api/v1/files']['post']['responses'][201]>;
export type FileMeta = JsonOf<paths['/api/v1/files/{id}']['get']['responses'][200]>;

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const ALLOWED_EXT = ['pdf', 'png', 'jpg', 'jpeg', 'txt', 'csv', 'xlsx', 'docx'] as const;
export const ACCEPT = ALLOWED_EXT.map((e) => `.${e}`).join(',');

/** Проверка до отправки: расширение и размер. null — можно загружать. */
export function precheck(file: { name: string; size: number }, allowed: readonly string[] = ALLOWED_EXT): string | null {
  const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? '';
  if (!allowed.includes(ext)) return `«${file.name}»: такой тип файла загрузить нельзя. Можно: ${allowed.filter((e) => e !== 'jpeg').map((e) => e.toUpperCase()).join(', ')}`;
  if (file.size === 0) return `«${file.name}»: файл пустой`;
  if (file.size > MAX_FILE_BYTES) return `«${file.name}»: файл больше 25 МБ`;
  return null;
}

async function errorOf(res: Response): Promise<ApiError> {
  const data = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  return new ApiError(res.status, data?.error?.code ?? 'UNKNOWN', data?.error?.message ?? 'Не удалось выполнить запрос');
}

export type PreviewKind = 'image' | 'pdf' | 'text' | 'none';

export function previewKind(mime: string): PreviewKind {
  if (mime === 'image/png' || mime === 'image/jpeg') return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'text/plain' || mime === 'text/csv') return 'text';
  return 'none';
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
}

export const filesApi = {
  /** Загрузить один файл. Несколько — несколькими запросами. */
  async upload(file: File): Promise<FileInfo> {
    let res: Response;
    try {
      res = await fetch('/api/v1/files', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
        body: file,
      });
    } catch {
      throw new ApiError(0, 'NETWORK', 'Нет связи с сервером. Проверьте сеть и попробуйте ещё раз');
    }
    if (!res.ok) throw await errorOf(res);
    return (await res.json()) as FileInfo;
  },
  meta: (id: string) => request<FileMeta>('GET', `/api/v1/files/${id}`),
  /** Содержимое для предпросмотра: blob. Ответ backend всегда attachment, в окне браузера он не открывается. */
  async content(id: string): Promise<Blob> {
    const res = await fetch(`/api/v1/files/${id}/content`, { credentials: 'same-origin' });
    if (!res.ok) throw await errorOf(res);
    return res.blob();
  },
  /** Сохранить файл на компьютер под исходным именем. */
  async save(id: string, name: string): Promise<void> {
    const blob = await filesApi.content(id);
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  },
};

export const fkeys = {
  content: (id: string) => ['files', 'content', id] as const,
};
