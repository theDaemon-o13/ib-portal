// Слайды экрана мониторинга (релиз 1.1.0, задача 6, ADR-0019). Одна настройка на все настенные мониторы:
// правит settings.manage, киоск только читает (GET /monitor). Слайд — вид, название, секунды, фильтр,
// «пропускать пустой». Данные каждого слайда считаются на сервере с его фильтром.
import type { Prisma } from '../../generated/prisma/client.js';
import { withTx, type Db } from '../../lib/db.js';
import { badRequest, notFound, versionConflict } from '../../lib/errors.js';
import type { Values } from '../../lib/register-values.js';
import { todayIso } from '../../lib/today.js';
import { auditSettings, type Actor } from '../settings/common.js';
import { computeKpis, KPI_KEYS, systemRegister, widgetData, type Kpi, type KpiKey, type WidgetData } from '../dashboard/service.js';
import { VULN_REGISTER_KEY } from '../vulns/definition.js';
import { documentItems, evidenceItems, riskItems, taskItems, vulnsBlock, type MonitorData, type MonitorItem } from './service.js';

export const SLIDE_KINDS = ['kpis', 'vulns', 'tasks', 'documents', 'risks', 'evidence', 'dlp'] as const;
export type SlideKind = (typeof SLIDE_KINDS)[number];

export const SLIDE_KIND_NAMES: Record<SlideKind, string> = {
  kpis: 'Ключевые показатели', vulns: 'Уязвимости по срокам', tasks: 'Задачи', documents: 'Документы: срок пересмотра',
  risks: 'Решения ОУР: пересмотр', evidence: 'Доказательства: срок действия', dlp: 'Доступ без основания (DLP)',
};

/** KPI на стене по умолчанию — как на прежнем экране. */
export const WALL_KPIS: KpiKey[] = ['vulns_open', 'vulns_overdue', 'vulns_soon', 'incidents_30d', 'tasks_overdue', 'docs_review', 'risks_no_decision', 'evidence_expiring'];

/** Фильтр слайда. period: all — все сроки, overdue — только просроченные, within — просроченные и до N дней. */
export interface SlideFilter {
  period?: 'all' | 'overdue' | 'within';
  days?: number;
  kpis?: string[];
  crit?: string[];
  departments?: string[];
  systems?: string[];
  categories?: string[];
  types?: string[];
  registerId?: string;
}

export const SLIDE_SECONDS = { min: 5, max: 300, default: 12 } as const;

export interface SlideInput {
  kind: SlideKind;
  title: string;
  seconds: number;
  filter: SlideFilter;
  enabled: boolean;
  skipEmpty: boolean;
}

export type SlideData =
  | { kind: 'kpis'; items: Kpi[] }
  | { kind: 'vulns'; vulns: NonNullable<MonitorData['vulns']> | null }
  | { kind: 'items'; items: MonitorItem[] }
  | { kind: 'dlp'; widget: WidgetData | null };

const daysPick = (f: SlideFilter) => (days: number | null): boolean =>
  f.period === 'overdue' ? days !== null && days < 0 : f.period === 'within' ? days !== null && days <= (f.days ?? 7) : true;

/** Проверка фильтра: только поля своего вида, id — существующие значения; лишнее отбрасывается. */
async function checkFilter(db: Db, kind: SlideKind, f: SlideFilter): Promise<SlideFilter> {
  const out: SlideFilter = {};
  const usesPeriod = kind !== 'kpis' && kind !== 'dlp';
  if (usesPeriod) {
    out.period = f.period ?? 'all';
    if (out.period === 'within') {
      if (!Number.isInteger(f.days) || (f.days ?? 0) < 1 || (f.days ?? 0) > 365) throw badRequest('BAD_SLIDE', 'Срок: от 1 до 365 дней');
      out.days = f.days;
    }
  }
  const ids = async (list: string[] | undefined, valid: () => Promise<Set<string>>, what: string) => {
    if (!list?.length) return undefined;
    const ok = await valid();
    if (list.some((id) => !ok.has(id))) throw badRequest('BAD_SLIDE', `${what}: значение не найдено. Обновите страницу`);
    return [...new Set(list)];
  };
  const vulnField = async (key: string) => {
    const reg = await systemRegister(db, VULN_REGISTER_KEY);
    return new Set(reg?.fields.find((x) => x.systemKey === key)?.options.map((o) => o.id) ?? []);
  };
  const catalog = async (code: string) => new Set((await db.catalogItem.findMany({ where: { catalogCode: code, deletedAt: null }, select: { id: true } })).map((i) => i.id));
  if (kind === 'kpis') {
    const kpis = f.kpis?.filter((k) => (KPI_KEYS as readonly string[]).includes(k));
    if (f.kpis && kpis?.length !== f.kpis.length) throw badRequest('BAD_SLIDE', 'Нет такого показателя');
    if (kpis?.length) out.kpis = [...new Set(kpis)];
  }
  if (kind === 'vulns') {
    out.crit = await ids(f.crit, () => vulnField('crit'), 'Критичность');
    out.departments = await ids(f.departments, () => vulnField('department'), 'Отдел');
    out.systems = await ids(f.systems, () => vulnField('system'), 'Система');
  }
  if (kind === 'tasks') out.categories = await ids(f.categories, () => catalog('task_categories'), 'Категория');
  if (kind === 'documents') out.types = await ids(f.types, () => catalog('document_types'), 'Тип документа');
  if (kind === 'dlp') {
    const basis = await db.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT g.id::text FROM register_fields f JOIN registers g ON g.id = f.register_id
      WHERE f.deleted_at IS NULL AND g.archived_at IS NULL AND g.deleted_at IS NULL AND f.calc_rule ->> 'kind' = 'link_basis'`;
    if (!f.registerId || !basis.some((b) => b.id === f.registerId)) throw badRequest('BAD_SLIDE', 'Выберите реестр со статусом основания (сверка с DLP)');
    out.registerId = f.registerId;
  }
  return JSON.parse(JSON.stringify(out)) as SlideFilter; // без undefined
}

function checkInput(i: SlideInput) {
  if (!(SLIDE_KINDS as readonly string[]).includes(i.kind)) throw badRequest('BAD_SLIDE', 'Неизвестный вид слайда');
  if (!i.title.trim() || i.title.trim().length > 120) throw badRequest('BAD_SLIDE', 'Название слайда — от 1 до 120 символов');
  if (!Number.isInteger(i.seconds) || i.seconds < SLIDE_SECONDS.min || i.seconds > SLIDE_SECONDS.max) {
    throw badRequest('BAD_SLIDE', `Время показа — от ${SLIDE_SECONDS.min} до ${SLIDE_SECONDS.max} секунд`);
  }
}

/** Данные слайда с его фильтром; empty — показать текст «Нет …» или пропустить слайд. */
export async function slideData(db: Db, kind: SlideKind, filter: SlideFilter, kpis: () => Promise<Kpi[]>): Promise<{ data: SlideData; empty: boolean }> {
  const today = todayIso();
  const keep = daysPick(filter);
  const items = (list: MonitorItem[]) => {
    const out = list.filter((i) => keep(i.days)).sort((a, b) => a.days - b.days || a.title.localeCompare(b.title, 'ru'));
    return { data: { kind: 'items' as const, items: out }, empty: out.length === 0 };
  };
  switch (kind) {
    case 'kpis': {
      const want = filter.kpis?.length ? filter.kpis : WALL_KPIS;
      const all = await kpis();
      return { data: { kind: 'kpis', items: want.map((k) => all.find((x) => x.key === k)).filter((k): k is Kpi => !!k) }, empty: false };
    }
    case 'vulns': {
      const reg = await systemRegister(db, VULN_REGISTER_KEY);
      if (!reg) return { data: { kind: 'vulns', vulns: null }, empty: true };
      const field = (key: string) => reg.fields.find((f) => f.systemKey === key)?.id;
      const conds: [string | undefined, string[] | undefined][] = [[field('crit'), filter.crit], [field('department'), filter.departments], [field('system'), filter.systems]];
      const where = (v: Values) => conds.every(([fid, list]) => !list?.length || (!!fid && list.includes(String(v[fid] ?? ''))));
      const vulns = await vulnsBlock(db, reg, today, { where, days: keep });
      return { data: { kind: 'vulns', vulns }, empty: vulns.total === 0 };
    }
    case 'tasks': return items(await taskItems(db, today, filter.categories));
    case 'documents': return items(await documentItems(db, today, filter.types));
    case 'risks': return items(await riskItems(db, today));
    case 'evidence': return items(await evidenceItems(db, today));
    case 'dlp': {
      try {
        const widget = await widgetData(db, `basis:${filter.registerId}`);
        return { data: { kind: 'dlp', widget }, empty: !widget.total };
      } catch {
        return { data: { kind: 'dlp', widget: null }, empty: true };
      }
    }
  }
}

export interface SlideDto extends SlideInput {
  id: string;
  sortOrder: number;
  version: number;
}

const toDto = (r: { id: string; kind: string; title: string; seconds: number; filter: Prisma.JsonValue; enabled: boolean; skipEmpty: boolean; sortOrder: number; version: number }): SlideDto => ({
  id: r.id, kind: r.kind as SlideKind, title: r.title, seconds: r.seconds, filter: (r.filter ?? {}) as SlideFilter,
  enabled: r.enabled, skipEmpty: r.skipEmpty, sortOrder: r.sortOrder, version: r.version,
});

export async function listSlides(db: Db): Promise<SlideDto[]> {
  return (await db.monitorSlide.findMany({ where: { deletedAt: null }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] })).map(toDto);
}

/** Экран: включённые слайды по порядку с данными; signature меняется, когда меняется набор (для смены без перезагрузки). */
export async function monitorScreen(db: Db) {
  const slides = (await listSlides(db)).filter((s) => s.enabled);
  let kpiCache: Promise<Kpi[]> | null = null;
  const kpis = () => (kpiCache ??= computeKpis(db));
  const out = [];
  for (const s of slides) out.push({ ...s, ...(await slideData(db, s.kind, s.filter, kpis)) });
  const signature = slides.map((s) => `${s.id}:${s.version}`).join('|');
  return { signature, slides: out };
}

export async function previewSlide(db: Db, input: SlideInput) {
  checkInput(input);
  const filter = await checkFilter(db, input.kind, input.filter);
  return { id: 'preview', ...input, filter, sortOrder: 0, version: 0, ...(await slideData(db, input.kind, filter, () => computeKpis(db))) };
}

const describe = (s: { kind: string; title: string; seconds: number; enabled: boolean }) =>
  `«${s.title}» (${SLIDE_KIND_NAMES[s.kind as SlideKind] ?? s.kind}, ${s.seconds} с${s.enabled ? '' : ', выключен'})`;

export async function createSlide(db: Db, actor: Actor, input: SlideInput): Promise<SlideDto> {
  checkInput(input);
  const filter = await checkFilter(db, input.kind, input.filter);
  return withTx(db, async (tx) => {
    const max = await tx.monitorSlide.aggregate({ where: { deletedAt: null }, _max: { sortOrder: true } });
    const r = await tx.monitorSlide.create({
      data: { ...input, title: input.title.trim(), filter: filter as Prisma.InputJsonValue, sortOrder: (max._max.sortOrder ?? 0) + 1, createdBy: actor.id },
    });
    await auditSettings(tx, actor, { action: 'monitor.slide.created', entity: 'monitor_slide', entityId: r.id, summary: `Экран мониторинга: добавлен слайд ${describe(r)}`, after: { ...input, filter } });
    return toDto(r);
  });
}

export async function updateSlide(db: Db, actor: Actor, id: string, version: number, input: SlideInput): Promise<SlideDto> {
  checkInput(input);
  const filter = await checkFilter(db, input.kind, input.filter);
  return withTx(db, async (tx) => {
    const before = await tx.monitorSlide.findFirst({ where: { id, deletedAt: null } });
    if (!before) throw notFound('Слайд');
    const res = await tx.monitorSlide.updateMany({
      where: { id, version, deletedAt: null },
      data: { kind: input.kind, title: input.title.trim(), seconds: input.seconds, filter: filter as Prisma.InputJsonValue, enabled: input.enabled, skipEmpty: input.skipEmpty, version: { increment: 1 } },
    });
    if (!res.count) throw versionConflict();
    const after = await tx.monitorSlide.findUniqueOrThrow({ where: { id } });
    await auditSettings(tx, actor, {
      action: 'monitor.slide.updated', entity: 'monitor_slide', entityId: id, summary: `Экран мониторинга: слайд ${describe(before)} → ${describe(after)}`,
      before: toDto(before) as unknown as Record<string, unknown>, after: toDto(after) as unknown as Record<string, unknown>,
    });
    return toDto(after);
  });
}

export async function moveSlide(db: Db, actor: Actor, id: string, direction: 'up' | 'down'): Promise<SlideDto[]> {
  return withTx(db, async (tx) => {
    const list = await listSlides(tx);
    const i = list.findIndex((s) => s.id === id);
    if (i < 0) throw notFound('Слайд');
    const j = direction === 'up' ? i - 1 : i + 1;
    const a = list[i];
    const b = list[j];
    if (!a || !b) return list;
    // Порядок — по позиции в списке (sort_order может совпадать у старых строк): переписываем пару.
    await tx.monitorSlide.update({ where: { id: a.id }, data: { sortOrder: j + 1, version: { increment: 1 } } });
    await tx.monitorSlide.update({ where: { id: b.id }, data: { sortOrder: i + 1, version: { increment: 1 } } });
    for (const [n, s] of list.entries()) if (n !== i && n !== j && s.sortOrder !== n + 1) await tx.monitorSlide.update({ where: { id: s.id }, data: { sortOrder: n + 1 } });
    await auditSettings(tx, actor, { action: 'monitor.slide.moved', entity: 'monitor_slide', entityId: id, summary: `Экран мониторинга: слайд «${a.title}» ${direction === 'up' ? 'выше' : 'ниже'}` });
    return listSlides(tx);
  });
}

export async function deleteSlide(db: Db, actor: Actor, id: string, version: number): Promise<void> {
  await withTx(db, async (tx) => {
    const before = await tx.monitorSlide.findFirst({ where: { id, deletedAt: null } });
    if (!before) throw notFound('Слайд');
    const res = await tx.monitorSlide.updateMany({ where: { id, version, deletedAt: null }, data: { deletedAt: new Date(), version: { increment: 1 } } });
    if (!res.count) throw versionConflict();
    await auditSettings(tx, actor, { action: 'monitor.slide.deleted', entity: 'monitor_slide', entityId: id, summary: `Экран мониторинга: удалён слайд ${describe(before)}`, before: toDto(before) as unknown as Record<string, unknown> });
  });
}

/** Значения для формы слайда: показатели, критичность, отделы, системы, категории задач, типы документов, реестры DLP. */
export async function slideOptions(db: Db) {
  const reg = await systemRegister(db, VULN_REGISTER_KEY);
  const opts = (key: string) => reg?.fields.find((f) => f.systemKey === key)?.options.filter((o) => !o.archived).map((o) => ({ id: o.id, label: o.label })) ?? [];
  const catalog = async (code: string) => (await db.catalogItem.findMany({ where: { catalogCode: code, deletedAt: null, archivedAt: null }, orderBy: [{ sortOrder: 'asc' }, { value: 'asc' }] }))
    .map((i) => ({ id: i.id, label: i.value }));
  const kpis = await computeKpis(db);
  const basis = await db.$queryRaw<{ id: string; name: string }[]>`
    SELECT DISTINCT g.id::text, g.name FROM register_fields f JOIN registers g ON g.id = f.register_id
    WHERE f.deleted_at IS NULL AND f.archived_at IS NULL AND g.archived_at IS NULL AND g.deleted_at IS NULL AND f.calc_rule ->> 'kind' = 'link_basis' ORDER BY g.name`;
  return {
    kinds: SLIDE_KINDS.map((k) => ({ kind: k, label: SLIDE_KIND_NAMES[k] })),
    kpis: kpis.map((k) => ({ id: k.key, label: k.label })),
    crit: opts('crit'), departments: opts('department'), systems: opts('system'),
    categories: await catalog('task_categories'), types: await catalog('document_types'),
    registers: basis.map((b) => ({ id: b.id, label: b.name })),
    seconds: SLIDE_SECONDS,
  };
}
