// Глобальный поиск (этап 8б): записи реестров, доказательства и файлы, в том числе текст PDF; цепочки задач (1.7.0). Результаты — по правам.
import { request, type JsonOf } from './client';
import type { paths } from './generated/schema';

export type SearchResult = JsonOf<paths['/api/v1/search']['get']['responses'][200]>;
export type SearchKind = 'records' | 'files' | 'evidence' | 'chains';
export type SearchHit = SearchResult['records']['items'][number];

export const searchApi = {
  search: (q: string, kind?: SearchKind, cursor?: string) => {
    const p = new URLSearchParams({ q, limit: kind ? '30' : '10' });
    if (kind) p.set('kind', kind);
    if (cursor) p.set('cursor', cursor);
    return request<SearchResult>('GET', `/api/v1/search?${p.toString()}`);
  },
};

/** Фрагмент с совпадениями в [[ ]] → части для подсветки (без HTML от сервера). */
export function snippetParts(s: string): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = [];
  const re = /\[\[(.*?)\]\]/g;
  let last = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > last) out.push({ text: s.slice(last, m.index), hit: false });
    out.push({ text: m[1] ?? '', hit: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last), hit: false });
  return out;
}
