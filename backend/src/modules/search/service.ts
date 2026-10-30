// Глобальный поиск (этап 8б, ADR-0013): одна строка по записям всех реестров, доказательствам и файлам.
// Полнотекстовый поиск PostgreSQL с русской морфологией (search_tsv записей, tsv текста PDF) плюс подстрока —
// для имён хостов, номеров документов и имён файлов, которые словарь разбирает на части.
// Права: с ib.work — записи, доказательства и все приложенные файлы; без него — только PDF версий документов,
// которые пользователь видит (та же проверка, что при скачивании файла).
import { Prisma } from '../../generated/prisma/client.js';
import type { Db } from '../../lib/db.js';
import { accessOf, versionVisible } from '../documents/service.js';

export const SEARCH_KINDS = ['records', 'files', 'evidence'] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];
export const Q_MIN = 2;
export const Q_MAX = 200;

/** Подсветка совпадений во фрагменте: «…» — границы, совпадения в [[ ]] (frontend выделяет их сам, без HTML). */
const HEADLINE = 'StartSel=[[, StopSel=]], MaxWords=24, MinWords=8, MaxFragments=2, FragmentDelimiter=" … "';

/** Карточка записи: /registers?record=<id>#<реестр>/records (RecordsTab открывает её по параметру). */
export const recordLink = (registerId: string, recordId: string) => `/registers?record=${recordId}#${registerId}/records`;

const likeOf = (q: string) => `%${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export interface SearchHit {
  kind: SearchKind;
  id: string;
  title: string;
  /** Где найдено: реестр, «Доказательство», к чему приложен файл. */
  context: string;
  snippet: string;
  /** Ссылка во frontend. */
  link: string;
  archived: boolean;
}

interface Section {
  items: SearchHit[];
  total: number;
  nextCursor: string | null;
}

export interface SearchResult {
  q: string;
  records: Section;
  files: Section;
  evidence: Section;
  /** Файлы без текстового слоя (сканы) среди доступных: по ним поиск только по имени и полям записи. */
  noTextFiles: number;
  /** Файлы, текст которых ещё извлекается. */
  pendingFiles: number;
}

const empty = (): Section => ({ items: [], total: 0, nextCursor: null });

async function searchRecords(db: Db, q: string, limit: number, offset: number): Promise<Section> {
  const where = Prisma.sql`r.deleted_at IS NULL AND g.archived_at IS NULL
    AND (r.search_tsv @@ websearch_to_tsquery('russian', ${q}) OR r.search_text LIKE ${likeOf(q)})`;
  const rows = await db.$queryRaw<{ id: string; number: number; register_id: string; register: string; title: string | null; archived: boolean; snippet: string }[]>`
    SELECT r.id::text, r.number, r.register_id::text, g.name AS register, r.archived_at IS NOT NULL AS archived,
      r."values" ->> (SELECT f.id::text FROM register_fields f WHERE f.register_id = r.register_id AND f.is_title AND f.deleted_at IS NULL LIMIT 1) AS title,
      ts_headline('russian', r.search_text, websearch_to_tsquery('russian', ${q}), ${HEADLINE}) AS snippet
    FROM register_records r JOIN registers g ON g.id = r.register_id
    WHERE ${where}
    ORDER BY ts_rank(r.search_tsv, websearch_to_tsquery('russian', ${q})) DESC, r.updated_at DESC
    LIMIT ${limit + 1} OFFSET ${offset}`;
  const [count] = await db.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM register_records r JOIN registers g ON g.id = r.register_id WHERE ${where}`;
  return {
    items: rows.slice(0, limit).map((r) => ({
      kind: 'records', id: r.id, title: `#${r.number}${r.title ? ` ${r.title}` : ''}`, context: r.register, snippet: r.snippet,
      link: recordLink(r.register_id, r.id), archived: r.archived,
    })),
    total: Number(count?.n ?? 0),
    nextCursor: rows.length > limit ? String(offset + limit) : null,
  };
}

async function searchEvidence(db: Db, q: string, limit: number, offset: number): Promise<Section> {
  const like = likeOf(q);
  const where = Prisma.sql`e.deleted_at IS NULL AND (lower(e.title) LIKE ${like} OR lower(e.confirmed_by) LIKE ${like}
    OR lower(e.review_comment) LIKE ${like} OR ('#' || e.number) = ${q.trim()}
    OR to_tsvector('russian', e.title || ' ' || e.confirmed_by) @@ websearch_to_tsquery('russian', ${q}))`;
  const rows = await db.$queryRaw<{ id: string; number: number; title: string; archived: boolean }[]>`
    SELECT e.id::text, e.number, e.title, e.archived_at IS NOT NULL AS archived FROM evidence e
    WHERE ${where} ORDER BY e.updated_at DESC LIMIT ${limit + 1} OFFSET ${offset}`;
  const [count] = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM evidence e WHERE ${where}`;
  return {
    items: rows.slice(0, limit).map((r) => ({
      kind: 'evidence', id: r.id, title: `#${r.number} ${r.title}`, context: 'Доказательство', snippet: '', link: `/evidence?ev=${r.id}`, archived: r.archived,
    })),
    total: Number(count?.n ?? 0),
    nextCursor: rows.length > limit ? String(offset + limit) : null,
  };
}

/** Файлы с действующими ссылками; ref — первая ссылка: запись реестра, доказательство, решение или версия документа. */
type FileRow = {
  id: string; name: string; snippet: string | null;
  record_id: string | null; record_register_id: string | null; record_register: string | null; record_number: number | null; record_field: string | null;
  evidence_id: string | null; evidence_number: number | null;
  decision_record: string | null; decision_register: string | null;
  version_id: string | null; document_id: string | null; document_title: string | null;
};

const fileLink = (r: FileRow): { context: string; link: string } => {
  if (r.record_id && r.record_register_id) {
    return { context: `«${r.record_register}», запись #${r.record_number}: ${r.record_field}`, link: recordLink(r.record_register_id, r.record_id) };
  }
  if (r.evidence_id) return { context: `Доказательство #${r.evidence_number}`, link: `/evidence?ev=${r.evidence_id}` };
  if (r.decision_record && r.decision_register) return { context: 'Решение другого отдела', link: recordLink(r.decision_register, r.decision_record) };
  return { context: `Документ «${r.document_title}»`, link: `/documents?doc=${r.document_id}` };
};

async function searchFiles(db: Db, q: string, limit: number, offset: number, docVersions: ((versionId: string) => Promise<boolean>) | null): Promise<Section> {
  const like = likeOf(q);
  const query = Prisma.sql`websearch_to_tsquery('russian', ${q})`;
  const rows = await db.$queryRaw<FileRow[]>`
    SELECT f.id::text, f.original_name AS name,
      CASE WHEN t.tsv @@ ${query} THEN ts_headline('russian', left(t.content, 200000), ${query}, ${HEADLINE}) END AS snippet,
      rf.record_id::text, rr.register_id::text AS record_register_id, rg.name AS record_register, rr.number AS record_number, fl.label AS record_field,
      ef.evidence_id::text, ev.number AS evidence_number,
      dc.record_id::text AS decision_record, dr.register_id::text AS decision_register,
      dv.id::text AS version_id, dv.document_id::text, dv.title AS document_title
    FROM files f
    LEFT JOIN file_texts t ON t.file_id = f.id
    LEFT JOIN LATERAL (SELECT x.record_id, x.field_id FROM register_record_files x WHERE x.file_id = f.id AND x.removed_at IS NULL LIMIT 1) rf ON true
    LEFT JOIN register_records rr ON rr.id = rf.record_id
    LEFT JOIN registers rg ON rg.id = rr.register_id
    LEFT JOIN register_fields fl ON fl.id = rf.field_id
    LEFT JOIN LATERAL (SELECT x.evidence_id FROM evidence_files x WHERE x.file_id = f.id AND x.removed_at IS NULL LIMIT 1) ef ON true
    LEFT JOIN evidence ev ON ev.id = ef.evidence_id
    LEFT JOIN LATERAL (SELECT x.record_id FROM register_decisions x WHERE x.file_id = f.id LIMIT 1) dc ON true
    LEFT JOIN register_records dr ON dr.id = dc.record_id
    LEFT JOIN LATERAL (
      SELECT x.id, x.document_id, x.title FROM document_versions x JOIN documents dd ON dd.id = x.document_id AND dd.deleted_at IS NULL
      WHERE x.pdf_file_id = f.id ORDER BY x.no DESC LIMIT 1) dv ON true
    WHERE f.deleted_at IS NULL
      AND (rf.record_id IS NOT NULL OR ef.evidence_id IS NOT NULL OR dc.record_id IS NOT NULL OR dv.id IS NOT NULL)
      ${docVersions ? Prisma.sql`AND dv.id IS NOT NULL` : Prisma.empty}
      AND (lower(f.original_name) LIKE ${like} OR t.tsv @@ ${query} OR lower(t.content) LIKE ${like})
    ORDER BY ts_rank(t.tsv, ${query}) DESC NULLS LAST, f.uploaded_at DESC`;
  // Права на версии документов проверяются по одной (как при скачивании), поэтому пагинация — после фильтра.
  const visible: typeof rows = [];
  for (const r of rows) {
    if (docVersions && !(r.version_id && (await docVersions(r.version_id)))) continue;
    visible.push(r);
  }
  return {
    items: visible.slice(offset, offset + limit).map((r) => ({ kind: 'files' as const, id: r.id, title: r.name, ...fileLink(r), snippet: r.snippet ?? '', archived: false })),
    total: visible.length,
    nextCursor: visible.length > offset + limit ? String(offset + limit) : null,
  };
}

/** Счётчики файлов без текста и в очереди — среди тех, что пользователь может найти. */
async function textCounters(db: Db, ibWork: boolean): Promise<{ noTextFiles: number; pendingFiles: number }> {
  if (!ibWork) return { noTextFiles: 0, pendingFiles: 0 };
  const rows = await db.$queryRaw<{ status: string; n: bigint }[]>`
    SELECT t.status, count(*) AS n FROM file_texts t JOIN files f ON f.id = t.file_id
    WHERE f.deleted_at IS NULL AND t.status IN ('no_text', 'pending') AND file_active_refs(f.id) > 0
    GROUP BY t.status`;
  const n = (s: string) => Number(rows.find((r) => r.status === s)?.n ?? 0);
  return { noTextFiles: n('no_text'), pendingFiles: n('pending') };
}

export async function search(db: Db, userId: string, input: { q: string; kind?: SearchKind; limit: number; cursor?: string }): Promise<SearchResult> {
  const q = input.q.trim().replace(/\s+/g, ' ');
  const offset = input.cursor && /^\d+$/.test(input.cursor) ? Number(input.cursor) : 0;
  const access = await accessOf(db, userId);
  const want = (k: SearchKind) => !input.kind || input.kind === k;
  const docVersions = access.ibWork ? null : (versionId: string) => versionVisible(db, access, versionId);
  const [records, files, evidence, counters] = await Promise.all([
    access.ibWork && want('records') ? searchRecords(db, q, input.limit, offset) : empty(),
    want('files') ? searchFiles(db, q, input.limit, offset, docVersions) : empty(),
    access.ibWork && want('evidence') ? searchEvidence(db, q, input.limit, offset) : empty(),
    textCounters(db, access.ibWork),
  ]);
  return { q, records, files, evidence, ...counters };
}
