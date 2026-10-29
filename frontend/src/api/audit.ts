// Раздел «Журнал» (релиз 1.2.0, ADR-0021): действия пользователей из журнала аудита, по праву audit.view.
import { ApiError, request, type JsonOf } from './client';
import type { paths } from './generated/schema';

export type AuditPage = JsonOf<paths['/api/v1/audit']['get']['responses'][200]>;
export type AuditEntry = AuditPage['items'][number];
export type AuditFacets = JsonOf<paths['/api/v1/audit/facets']['get']['responses'][200]>;

/** Фильтр — те же имена, что в адресе страницы и в API. from и to — даты YYYY-MM-DD (to включительно). */
export const AUDIT_FILTERS = ['from', 'to', 'userId', 'action', 'entity', 'ip', 'q'] as const;
export type AuditFilter = Partial<Record<(typeof AUDIT_FILTERS)[number], string>>;

/** Даты страницы → границы в API: начало дня from и начало дня после to в часовом поясе браузера. */
export function toApiQuery(f: AuditFilter): URLSearchParams {
  const p = new URLSearchParams();
  for (const k of AUDIT_FILTERS) {
    const v = f[k]?.trim();
    if (!v) continue;
    if (k === 'from') p.set('from', new Date(`${v}T00:00:00`).toISOString());
    else if (k === 'to') {
      const d = new Date(`${v}T00:00:00`);
      d.setDate(d.getDate() + 1);
      p.set('to', d.toISOString());
    } else p.set(k, v);
  }
  return p;
}

function fileNameFrom(header: string | null, fallback: string): string {
  const m = header ? /filename\*=UTF-8''([^;]+)/i.exec(header) : null;
  try {
    return m?.[1] ? decodeURIComponent(m[1]) : fallback;
  } catch {
    return fallback;
  }
}

export const auditApi = {
  list: (f: AuditFilter, cursor?: string) => {
    const p = toApiQuery(f);
    p.set('limit', '50');
    if (cursor) p.set('cursor', cursor);
    return request<AuditPage>('GET', `/api/v1/audit?${p.toString()}`);
  },
  facets: () => request<AuditFacets>('GET', '/api/v1/audit/facets'),
  async exportFile(f: AuditFilter): Promise<{ blob: Blob; fileName: string }> {
    const res = await fetch(`/api/v1/audit/export?${toApiQuery(f).toString()}`, { credentials: 'same-origin' });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
      throw new ApiError(res.status, data?.error?.code ?? 'UNKNOWN', data?.error?.message ?? 'Не удалось выгрузить журнал');
    }
    return { blob: await res.blob(), fileName: fileNameFrom(res.headers.get('Content-Disposition'), 'журнал.xlsx') };
  },
};
