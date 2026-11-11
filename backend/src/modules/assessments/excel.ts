// Самооценка (этап Д4, docs/self-assessment.md, раздел 9): импорт Excel и выгрузка таблиц для анализа.
// Импорт — как у реестров: файл телом запроса, без multipart и токена, файл не сохраняется. Предпросмотр
// (dryRun) ничего не пишет; применение — повторный запрос с тем же файлом и версией оценки из предпросмотра:
// файл разбирается заново, всё одной транзакцией; оценку успели изменить — 409 и ничего не записано.
// Импорт — только в черновик; пустой ответ и пустой комментарий не стирают уже выставленное.
// В журнал — баллы «было → стало», без текста комментариев.
import ExcelJS from 'exceljs';
import type { Prisma } from '../../generated/prisma/client.js';
import { parseAssessmentBook, type ParsedProfile } from '../../lib/assessment-excel.js';
import { extraDomains, isInTotal, normalizeScore, score, sectionsOf, type AnswerInput, type Methodology } from '../../lib/assessment-score.js';
import { withTx, type Db } from '../../lib/db.js';
import { badRequest, conflict, notFound, versionConflict } from '../../lib/errors.js';
import { todayIso } from '../../lib/today.js';
import { readWorkbook } from '../registers/excel.service.js';
import { auditSettings, type Actor } from '../settings/common.js';
import { activeMethodology, ENTITY, STATUS_NAMES, type AssessmentStatus, type Profile } from './service.js';

const PROFILE_LABELS: Record<keyof ParsedProfile, string> = {
  organization: 'Организация', assessedOn: 'Дата проведения', respondent: 'Респондент', position: 'Должность', employees: 'Численность сотрудников',
};

/**
 * Импорт в черновик: dryRun — предпросмотр «раздел, было, станет»; иначе — применение (нужна version оценки
 * из предпросмотра). Ошибки строк — применить нельзя.
 */
export async function importAssessment(db: Db, actor: Actor, id: string, buffer: Buffer,
  opts: { dryRun: boolean; version?: number; sourceId?: string | null }) {
  if (!buffer.length) throw badRequest('BAD_FILE', 'Файл пустой');
  const wb = await readWorkbook(buffer);
  return withTx(db, async (tx) => {
    const r = await tx.assessment.findUnique({ where: { id }, include: { answers: true } });
    if (!r) throw notFound('Оценка');
    if (r.status !== 'draft') throw conflict('NOT_DRAFT', 'Импорт — только в черновик. Верните оценку в черновик или создайте новую');
    const m = r.methodologySnapshot as unknown as Methodology;
    const parsed = parseAssessmentBook(wb, m, { targetId: id, sourceId: opts.sourceId });
    const names = new Map(sectionsOf(m).map((s) => [s.code, s.name]));
    const current = new Map(r.answers.map((a) => [a.sectionCode, a]));

    const changes = parsed.answers.flatMap((p) => {
      const a = current.get(p.code);
      if (!a) return [];
      // Пустой ответ («Выбрать ответ») и пустой комментарий не стирают то, что уже есть (как импорт реестров).
      const to = p.level ?? a.level;
      const comment = p.comment !== '' && p.comment !== a.comment;
      if (to === a.level && !comment) return [];
      return [{ code: p.code, name: names.get(p.code) ?? p.code, from: a.level, to, comment, answerId: a.id, newComment: p.comment }];
    });
    const profile = r.profile as Profile;
    const profileChanges = (Object.keys(PROFILE_LABELS) as (keyof ParsedProfile)[]).flatMap((k) => {
      const next = parsed.profile[k];
      if (next === undefined) return [];
      const prev = k === 'assessedOn' ? r.assessedOn.toISOString().slice(0, 10) : profile[k as keyof Profile];
      return String(prev ?? '') === String(next) ? [] : [{ field: k, label: PROFILE_LABELS[k], from: prev == null ? '' : String(prev), to: String(next) }];
    });
    // Итог после импорта — тем же расчётом, что у черновика.
    const after = new Map<string, AnswerInput>(r.answers.map((a) => [a.sectionCode, { level: a.level, target: a.targetLevel }]));
    for (const c of changes) after.set(c.code, { level: c.to, target: after.get(c.code)?.target ?? null });
    const result = score(m, after);
    const preview = {
      format: parsed.format,
      version: r.version,
      found: parsed.answers.length,
      answered: parsed.answers.filter((a) => a.level !== null).length,
      changes: changes.map(({ code, name, from, to, comment }) => ({ code, name, from, to, comment })),
      profile: profileChanges.map(({ label, from, to }) => ({ label, from, to })),
      errors: parsed.errors,
      notes: parsed.notes,
      sources: parsed.sources ?? [],
      sourceId: parsed.sourceId ?? null,
      total: result.total, max: result.max, level: result.level, preliminary: result.preliminary,
      applied: false,
    };
    if (opts.dryRun) return preview;

    if (opts.version === undefined || opts.version !== r.version) throw versionConflict();
    if (parsed.errors.length) throw badRequest('IMPORT_ERRORS', `В файле ошибки строк (${parsed.errors.length}): исправьте файл и загрузите снова`);
    if (!changes.length && !profileChanges.length) return { ...preview, applied: true };
    const now = new Date();
    for (const c of changes) {
      const data: Prisma.AssessmentAnswerUncheckedUpdateManyInput = { level: c.to, updatedBy: actor.id, updatedAt: now, version: { increment: 1 } };
      if (c.comment) data.comment = c.newComment;
      await tx.assessmentAnswer.updateMany({ where: { id: c.answerId }, data });
    }
    const data: Prisma.AssessmentUpdateManyMutationInput = { version: { increment: 1 } };
    if (profileChanges.length) {
      const next: Profile = { ...profile };
      for (const p of profileChanges) {
        if (p.field === 'assessedOn') data.assessedOn = new Date(`${p.to}T00:00:00Z`);
        else if (p.field === 'employees') next.employees = Number(p.to);
        else next[p.field] = p.to;
      }
      data.profile = next as Prisma.InputJsonValue;
    }
    const res = await tx.assessment.updateMany({ where: { id, version: opts.version }, data });
    if (res.count === 0) throw versionConflict();
    await auditSettings(tx, actor, {
      action: 'assessment.imported', entity: ENTITY, entityId: id,
      summary: `Самооценка «${r.title}»: импорт из Excel — разделов изменено ${changes.length}${profileChanges.length ? ', профиль обновлён' : ''}; итог ${result.total} из ${result.max}`,
      // Комментарии — только признак «изменён», без текста (ADR-0026).
      after: {
        format: parsed.format,
        changes: changes.map((c) => ({ code: c.code, from: c.from, to: c.to, commentChanged: c.comment })),
        profile: profileChanges.map((p) => p.label),
      },
    });
    return { ...preview, version: r.version + 1, applied: true };
  });
}

// ---------------------------------------------------------------- выгрузка: таблицы для анализа

type Cell = string | number | Date | null;
interface SheetSpec { name: string; columns: { header: string; width: number; date?: boolean }[]; rows: Cell[][] }

const yesNo = (v: boolean) => (v ? 'да' : 'нет');
const day = (d: Date | null | undefined) => (d ? new Date(`${d.toISOString().slice(0, 10)}T00:00:00Z`) : null);

function addSheet(wb: ExcelJS.Workbook, spec: SheetSpec) {
  const ws = wb.addWorksheet(spec.name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = spec.columns.map((c) => ({ header: c.header, width: c.width, ...(c.date ? { style: { numFmt: 'dd.mm.yyyy' } } : {}) }));
  ws.getRow(1).font = { bold: true };
  for (const r of spec.rows) ws.addRow(r);
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: spec.columns.length } };
}

/**
 * Книга: «Оценки», «Ответы», «Домены», «Задачи», «Методика». Без ids — все оценки, кроме архивных.
 * 1.13.8: «В итоге» у доменов и ответов, «ИИ: …» у оценок (домены вне итога); «Методика» — из снимков оценок книги
 * (по группе строк на каждую пару «код + версия»), без оценок — активная.
 */
export async function exportAssessments(db: Db, actor: Actor, ids?: readonly string[]): Promise<{ fileName: string; buffer: Buffer }> {
  const rows = await db.assessment.findMany({
    where: ids?.length ? { id: { in: [...ids] } } : { status: { not: 'archived' } },
    include: { answers: true },
    orderBy: [{ assessedOn: 'asc' }, { createdAt: 'asc' }],
  });
  const links = await db.assessmentLink.findMany({
    where: { entityType: 'task', answer: { assessmentId: { in: rows.map((r) => r.id) } } },
    select: { entityId: true, answer: { select: { assessmentId: true, sectionCode: true } } },
  });
  const tasks = new Map((await db.task.findMany({
    where: { id: { in: links.map((l) => l.entityId) }, deletedAt: null },
    select: { id: true, title: true, dueDate: true, completedAt: true, archivedAt: true, status: { select: { value: true } }, assignee: { select: { fullName: true } } },
  })).map((t) => [t.id, t]));
  const tasksOf = (assessmentId: string, code: string) =>
    links.filter((l) => l.answer.assessmentId === assessmentId && l.answer.sectionCode === code).flatMap((l) => tasks.get(l.entityId) ?? []);

  const assessments: Cell[][] = [];
  const answers: Cell[][] = [];
  const domains: Cell[][] = [];
  const taskRows: Cell[][] = [];
  const snapshots = new Map<string, Methodology>();
  for (const r of rows) {
    const m = r.methodologySnapshot as unknown as Methodology;
    if (!snapshots.has(`${m.code} v${m.version}`)) snapshots.set(`${m.code} v${m.version}`, m);
    const by = new Map(r.answers.map((a) => [a.sectionCode, a]));
    const s = r.result ? normalizeScore(r.result) : score(m, new Map(r.answers.map((a) => [a.sectionCode, { level: a.level, target: a.targetLevel }])));
    const head = [r.id, r.title, day(r.assessedOn)] as Cell[];
    // Домены вне итога («Контроль ИИ»): сумма, максимум, отвечено; у методики без них — пусто.
    const extra = extraDomains(s);
    const ai: Cell[] = extra.length
      ? [extra.reduce((x, d) => x + d.sum, 0), extra.reduce((x, d) => x + d.max, 0), extra.reduce((x, d) => x + d.answered, 0)]
      : [null, null, null];
    assessments.push([...head, STATUS_NAMES[r.status as AssessmentStatus], s.total, s.max, s.answered, s.level.name, yesNo(s.preliminary), day(r.finalizedAt), ...ai]);
    for (const d of m.domains) {
      for (const sec of d.sections) {
        const a = by.get(sec.code);
        const level = a?.level ?? null;
        const target = a?.targetLevel ?? null;
        const ts = tasksOf(r.id, sec.code);
        answers.push([
          ...head, d.no, d.name, yesNo(isInTotal(d)), sec.code, sec.name, yesNo(sec.key === true), level, level ? m.scale.find((x) => x.level === level)?.name ?? '' : '',
          target, level !== null && target !== null && target > level ? target - level : null, a?.comment ?? '', ts.length, ts.filter((t) => t.completedAt).length,
        ]);
        for (const t of ts) {
          taskRows.push([r.id, r.title, sec.code, sec.name, t.title, t.assignee?.fullName ?? '', day(t.dueDate), t.archivedAt ? `${t.status.value} (в архиве)` : t.status.value]);
        }
      }
      const ds = s.domains.find((x) => x.no === d.no);
      domains.push([...head, d.no, d.name, yesNo(isInTotal(d)), ds?.sections ?? d.sections.length, ds?.answered ?? 0, ds?.sum ?? 0, ds?.max ?? 0, ds?.avg ?? null, ds?.targetAvg ?? null]);
    }
  }
  if (!snapshots.size) {
    const active = (await activeMethodology(db)).content as unknown as Methodology;
    snapshots.set(`${active.code} v${active.version}`, active);
  }
  const books = [...snapshots.values()];
  const scale = books[0]?.scale ?? [];
  const methodology: Cell[][] = books.flatMap((m) => m.domains.flatMap((d) => d.sections.map((s) => [
    m.code, m.version, d.no, d.name, yesNo(isInTotal(d)), s.code, s.name, yesNo(s.key === true), s.target, ...scale.map((x) => s.criteria[String(x.level)] ?? ''),
  ])));

  const wb = new ExcelJS.Workbook();
  const base = [{ header: 'ID оценки', width: 38 }, { header: 'Оценка', width: 28 }, { header: 'Дата', width: 12, date: true }];
  addSheet(wb, {
    name: 'Оценки',
    columns: [...base, { header: 'Статус', width: 15 }, { header: 'Итог', width: 8 }, { header: 'Максимум', width: 10 }, { header: 'Заполнено разделов', width: 12 },
      { header: 'Уровень КБ', width: 24 }, { header: 'Итог предварительный', width: 14 }, { header: 'Дата фиксации', width: 14, date: true },
      { header: 'ИИ: сумма', width: 10 }, { header: 'ИИ: максимум', width: 12 }, { header: 'ИИ: заполнено', width: 12 }],
    rows: assessments,
  });
  addSheet(wb, {
    name: 'Ответы',
    columns: [...base, { header: 'Домен №', width: 9 }, { header: 'Домен', width: 30 }, { header: 'В итоге', width: 9 }, { header: 'Код', width: 7 }, { header: 'Раздел', width: 40 },
      { header: 'Ключевой', width: 10 }, { header: 'Балл', width: 7 }, { header: 'Уровень', width: 13 }, { header: 'Целевой балл', width: 9 },
      { header: 'Разрыв', width: 8 }, { header: 'Комментарий', width: 40 }, { header: 'Задач', width: 8 }, { header: 'Задач выполнено', width: 10 }],
    rows: answers,
  });
  addSheet(wb, {
    name: 'Домены',
    columns: [...base, { header: 'Домен №', width: 9 }, { header: 'Домен', width: 30 }, { header: 'В итоге', width: 9 }, { header: 'Разделов', width: 10 }, { header: 'Отвечено', width: 10 },
      { header: 'Сумма', width: 8 }, { header: 'Максимум', width: 10 }, { header: 'Средний балл', width: 10 }, { header: 'Средний целевой', width: 10 }],
    rows: domains,
  });
  addSheet(wb, {
    name: 'Задачи',
    columns: [base[0] as SheetSpec['columns'][number], base[1] as SheetSpec['columns'][number], { header: 'Код', width: 7 }, { header: 'Раздел', width: 40 },
      { header: 'Задача', width: 50 }, { header: 'Исполнитель', width: 26 }, { header: 'Срок', width: 12, date: true }, { header: 'Статус', width: 22 }],
    rows: taskRows,
  });
  addSheet(wb, {
    name: 'Методика',
    columns: [{ header: 'Методика', width: 18 }, { header: 'Версия', width: 8 }, { header: 'Домен №', width: 9 }, { header: 'Домен', width: 30 }, { header: 'В итоге', width: 9 },
      { header: 'Код', width: 7 }, { header: 'Раздел', width: 40 }, { header: 'Ключевой', width: 10 },
      { header: 'Целевое состояние', width: 60 }, ...scale.map((x) => ({ header: `${x.level} ${x.name}`, width: 50 }))],
    rows: methodology,
  });
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  await auditSettings(db, actor, {
    action: 'assessment.exported', entity: ENTITY, entityId: 'export',
    summary: `Самооценка: выгрузка в Excel — оценок ${rows.length}`, after: { ids: rows.map((r) => r.id) },
  });
  return { fileName: `Самооценка_КБ_${todayIso()}.xlsx`, buffer };
}
