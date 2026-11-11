// Самооценка уровня кибербезопасности (этап Д, docs/self-assessment.md, ADR-0025, ADR-0026). Личный раздел:
// все маршруты — requirePerm('assessment.manage'), других проверок прав нет. Жизненный цикл: черновик → зафиксирована
// → архив, удаления нет. Итог черновика считается при чтении (lib/assessment-score.ts), при фиксации замораживается.
// В журнал аудита — баллы и цели как есть, текст комментариев — нет («комментарий изменён»).
import { Prisma } from '../../generated/prisma/client.js';
import { compareScores, normalizeScore, score, sectionsOf, type AnswerInput, type Methodology, type Score } from '../../lib/assessment-score.js';
import { isUniqueViolation, withTx, type Db } from '../../lib/db.js';
import { badRequest, conflict, notFound, versionConflict } from '../../lib/errors.js';
import { formatDateRu } from '../../lib/register-values.js';
import { addDaysIso, todayIso } from '../../lib/today.js';
import { notify } from '../notifications/service.js';
import { auditSettings, trimmed, type Actor } from '../settings/common.js';
import { assertAssignee, createTask } from '../tasks/service.js';
import { userOptions } from '../users/service.js';

export const TITLE_MAX = 200;
export const COMMENT_MAX = 4000;
export const ENTITY = 'assessment';

export const STATUSES = ['draft', 'final', 'archived'] as const;
export type AssessmentStatus = (typeof STATUSES)[number];
export const STATUS_NAMES: Record<AssessmentStatus, string> = { draft: 'Черновик', final: 'Зафиксирована', archived: 'Архив' };

/** Профиль оценки (лист «Общая информация»). Флажки отрасли, стажа и численности КБ заполняются в портале. */
export interface Profile {
  organization?: string;
  respondent?: string;
  position?: string;
  industries?: string[];
  employees?: number | null;
  kbExperience?: string;
  kbStaff?: string;
}

const answerInclude = { updater: { select: { fullName: true } } } as const;
const include = { answers: { include: answerInclude, orderBy: { sectionCode: 'asc' as const } } } as const;
type Row = Prisma.AssessmentGetPayload<{ include: typeof include }>;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const snapshotOf = (r: { methodologySnapshot: unknown }) => r.methodologySnapshot as Methodology;
const answersOf = (r: Pick<Row, 'answers'>) => new Map<string, AnswerInput>(r.answers.map((a) => [a.sectionCode, { level: a.level, target: a.targetLevel }]));

/** Итог: у зафиксированной — замороженный при фиксации (до 1.13.8 — без признака inTotal); у черновика — на лету. */
function scoreOf(r: Row): Score {
  if (r.result) return normalizeScore(r.result);
  return score(snapshotOf(r), answersOf(r));
}

const sameMethodology = (a: Pick<Methodology, 'code' | 'version'>, b: Pick<Methodology, 'code' | 'version'>) => a.code === b.code && a.version === b.version;

function summaryDto(r: Row) {
  const s = scoreOf(r);
  return {
    id: r.id, title: r.title, assessedOn: isoDay(r.assessedOn), status: r.status as AssessmentStatus, statusName: STATUS_NAMES[r.status as AssessmentStatus],
    total: s.total, max: s.max, answered: s.answered, sections: s.sections, preliminary: s.preliminary, level: s.level,
    finalizedAt: r.finalizedAt?.toISOString() ?? null, version: r.version,
  };
}

async function getRow(db: Db, id: string): Promise<Row> {
  const r = await db.assessment.findUnique({ where: { id }, include });
  if (!r) throw notFound('Оценка');
  return r;
}

const draftOnly = (r: { status: string }) => {
  if (r.status !== 'draft') throw conflict('NOT_DRAFT', 'Оценка зафиксирована или в архиве: менять можно только черновик. Верните её в черновик');
};

export async function activeMethodology(db: Db) {
  const m = await db.assessmentMethodology.findFirst({ where: { isActive: true, archivedAt: null }, orderBy: { version: 'desc' } });
  if (!m) throw conflict('NO_METHODOLOGY', 'Методика самооценки не загружена: выполните обновление (migrate)');
  return m;
}

/** Последняя зафиксированная (или архивная после фиксации) — с ней сравнивается новая оценка. */
async function lastFinal(db: Db, exceptId?: string) {
  return db.assessment.findFirst({
    where: { status: 'final', ...(exceptId ? { id: { not: exceptId } } : {}) },
    orderBy: [{ assessedOn: 'desc' }, { finalizedAt: 'desc' }],
    include,
  });
}

export async function listAssessments(db: Db) {
  const rows = await db.assessment.findMany({ include, orderBy: [{ assessedOn: 'desc' }, { createdAt: 'desc' }] });
  return { items: rows.map(summaryDto) };
}

function cleanTitle(v: string): string {
  const t = trimmed(v);
  if (!t) throw badRequest('EMPTY_TITLE', 'Укажите название оценки');
  if (t.length > TITLE_MAX) throw badRequest('TOO_LONG', `Название — не длиннее ${TITLE_MAX} символов`);
  return t;
}
function cleanDate(v: string): Date {
  const d = new Date(`${v}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(d.getTime()) || isoDay(d) !== v) throw badRequest('BAD_DATE', 'Укажите дату проведения');
  return d;
}

/** Новая оценка: пустая или копия зафиксированной (баллы и цели переносятся, комментарии — нет). Черновик один. */
export async function createAssessment(db: Db, actor: Actor, input: { title: string; assessedOn: string; copyFromId?: string }) {
  return withTx(db, async (tx) => {
    const title = cleanTitle(input.title);
    const assessedOn = cleanDate(input.assessedOn);
    const m = await activeMethodology(tx);
    const snapshot = m.content as unknown as Methodology;
    let copy: Row | null = null;
    if (input.copyFromId) {
      copy = await getRow(tx, input.copyFromId);
      if (!copy.finalizedAt) throw conflict('NOT_FINAL', 'Копировать можно только зафиксированную оценку');
    }
    const previous = copy ?? (await lastFinal(tx));
    const from = copy ? answersOf(copy) : new Map<string, AnswerInput>();
    let created;
    try {
      created = await withTx(tx, (t) => t.assessment.create({
        data: {
          methodologyId: m.id, methodologySnapshot: m.content as Prisma.InputJsonValue, title, assessedOn,
          profile: (copy?.profile ?? {}) as Prisma.InputJsonValue, previousId: previous?.id ?? null, createdBy: actor.id,
          answers: { create: sectionsOf(snapshot).map((s) => ({ sectionCode: s.code, level: from.get(s.code)?.level ?? null, targetLevel: from.get(s.code)?.target ?? null })) },
        },
      }));
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('DRAFT_EXISTS', 'Уже есть оценка в работе (черновик): закончите или зафиксируйте её');
      throw err;
    }
    await auditSettings(tx, actor, {
      action: 'assessment.created', entity: ENTITY, entityId: created.id,
      summary: `Самооценка «${title}» создана${copy ? ` копией «${copy.title}»` : ''}`,
      after: { title, assessedOn: input.assessedOn, copyFromId: copy?.id ?? null, methodology: `${m.code} v${m.version}` },
    });
    return created.id;
  });
}

/** Задачи по разделам оценки (связи assessment_links) и их состояние на доске. */
async function linkedTasks(db: Db, assessmentId: string) {
  const links = await db.assessmentLink.findMany({
    where: { entityType: 'task', answer: { assessmentId } },
    select: { entityId: true, createdAt: true, answer: { select: { sectionCode: true } } },
    orderBy: { createdAt: 'asc' },
  });
  if (!links.length) return [];
  const tasks = await db.task.findMany({
    where: { id: { in: links.map((l) => l.entityId) } },
    select: {
      id: true, number: true, title: true, dueDate: true, completedAt: true, archivedAt: true, deletedAt: true,
      status: { select: { value: true } }, assignee: { select: { fullName: true } },
    },
  });
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return links.flatMap((l) => {
    const t = byId.get(l.entityId);
    if (!t) return [];
    return [{
      code: l.answer.sectionCode, id: t.id, number: t.number, title: t.title, assignee: t.assignee?.fullName ?? null,
      dueDate: t.dueDate ? isoDay(t.dueDate) : null, status: t.status.value, done: t.completedAt !== null,
      archived: t.archivedAt !== null, deleted: t.deletedAt !== null,
    }];
  });
}

/** Куда можно обновить методику черновика (1.13.8): активная отличается от снимка по коду или версии; иначе null. */
async function methodologyUpgradeOf(db: Db, r: Row): Promise<{ code: string; version: number; name: string } | null> {
  if (r.status !== 'draft') return null;
  const active = await db.assessmentMethodology.findFirst({ where: { isActive: true, archivedAt: null }, orderBy: { version: 'desc' } });
  if (!active || sameMethodology(active, snapshotOf(r))) return null;
  return { code: active.code, version: active.version, name: active.name };
}

export async function getAssessment(db: Db, id: string) {
  const r = await getRow(db, id);
  const m = snapshotOf(r);
  const s = scoreOf(r);
  const prev = r.previousId ? await db.assessment.findUnique({ where: { id: r.previousId }, include }) : null;
  const prevScore = prev ? scoreOf(prev) : null;
  return {
    ...summaryDto(r),
    profile: r.profile as Profile,
    reopenComment: r.reopenComment,
    methodology: m,
    methodologyUpgrade: await methodologyUpgradeOf(db, r),
    answers: r.answers.map((a) => ({
      code: a.sectionCode, level: a.level, targetLevel: a.targetLevel, comment: a.comment, version: a.version,
      updatedAt: a.updatedAt.toISOString(), updatedBy: a.updater?.fullName ?? null,
    })),
    score: s,
    tasks: await linkedTasks(db, id),
    previous: prev && prevScore ? {
      id: prev.id, title: prev.title, assessedOn: isoDay(prev.assessedOn), total: prevScore.total, level: prevScore.level,
      domains: prevScore.domains.map((d) => ({ no: d.no, sum: d.sum, avg: d.avg })),
      answers: prev.answers.map((a) => ({ code: a.sectionCode, level: a.level })),
      delta: compareScores({ score: s, answers: answersOf(r) }, { score: prevScore, answers: answersOf(prev) }),
    } : null,
  };
}

function cleanProfile(p: Profile): Profile {
  const text = (v: string | undefined, what: string) => {
    const t = trimmed(v ?? '');
    if (t.length > 300) throw badRequest('TOO_LONG', `${what} — не длиннее 300 символов`);
    return t;
  };
  const employees = p.employees ?? null;
  if (employees !== null && (!Number.isInteger(employees) || employees < 0 || employees > 10_000_000)) throw badRequest('BAD_NUMBER', 'Численность — целое число');
  return {
    organization: text(p.organization, 'Организация'), respondent: text(p.respondent, 'Респондент'), position: text(p.position, 'Должность'),
    industries: (p.industries ?? []).map((x) => text(x, 'Отрасль')).filter(Boolean).slice(0, 20),
    employees, kbExperience: text(p.kbExperience, 'Стаж КБ'), kbStaff: text(p.kbStaff, 'Численность функции КБ'),
  };
}

/** Шапка и профиль — только в черновике. */
export async function updateAssessment(db: Db, actor: Actor, id: string, input: { version: number; title?: string; assessedOn?: string; profile?: Profile }) {
  return withTx(db, async (tx) => {
    const r = await getRow(tx, id);
    if (r.version !== input.version) throw versionConflict();
    draftOnly(r);
    const data: Prisma.AssessmentUpdateManyMutationInput = {};
    const changes: string[] = [];
    if (input.title !== undefined) { const t = cleanTitle(input.title); if (t !== r.title) { data.title = t; changes.push('название'); } }
    if (input.assessedOn !== undefined) { const d = cleanDate(input.assessedOn); if (isoDay(d) !== isoDay(r.assessedOn)) { data.assessedOn = d; changes.push('дата'); } }
    if (input.profile !== undefined) { data.profile = cleanProfile(input.profile) as Prisma.InputJsonValue; changes.push('профиль'); }
    if (!changes.length) return;
    const res = await tx.assessment.updateMany({ where: { id, version: input.version }, data: { ...data, version: { increment: 1 } } });
    if (res.count === 0) throw versionConflict();
    await auditSettings(tx, actor, {
      action: 'assessment.updated', entity: ENTITY, entityId: id,
      summary: `Самооценка «${r.title}»: ${changes.join(', ')}`, after: { changes },
    });
  });
}

const levelText = (v: number | null) => (v === null ? '—' : String(v));
function cleanLevel(v: number | null | undefined, what: string): number | null | undefined {
  if (v === undefined || v === null) return v;
  if (!Number.isInteger(v) || v < 1 || v > 4) throw badRequest('BAD_LEVEL', `${what} — от 1 до 4`);
  return v;
}

/** Ответ раздела (только черновик). В журнал — балл и цель как есть, вместо текста комментария — «комментарий изменён». */
export async function saveAnswer(db: Db, actor: Actor, id: string, code: string,
  input: { version: number; level?: number | null; targetLevel?: number | null; comment?: string }) {
  return withTx(db, async (tx) => {
    const r = await getRow(tx, id);
    draftOnly(r);
    const a = r.answers.find((x) => x.sectionCode === code);
    if (!a) throw notFound('Раздел');
    if (a.version !== input.version) throw versionConflict();
    const level = cleanLevel(input.level, 'Балл');
    const target = cleanLevel(input.targetLevel, 'Целевой уровень');
    const comment = input.comment === undefined ? undefined : input.comment.trim();
    if (comment !== undefined && comment.length > COMMENT_MAX) throw badRequest('TOO_LONG', `Комментарий — не длиннее ${COMMENT_MAX} символов`);
    const changes: { field: string; from: string; to: string }[] = [];
    const data: Prisma.AssessmentAnswerUpdateManyMutationInput = {};
    if (level !== undefined && level !== a.level) { data.level = level; changes.push({ field: 'level', from: levelText(a.level), to: levelText(level) }); }
    if (target !== undefined && target !== a.targetLevel) { data.targetLevel = target; changes.push({ field: 'targetLevel', from: levelText(a.targetLevel), to: levelText(target) }); }
    const commentChanged = comment !== undefined && comment !== a.comment;
    if (commentChanged) data.comment = comment;
    if (changes.length || commentChanged) {
      const res = await tx.assessmentAnswer.updateMany({
        where: { id: a.id, version: input.version },
        data: { ...data, updatedBy: actor.id, updatedAt: new Date(), version: { increment: 1 } },
      });
      if (res.count === 0) throw versionConflict();
      await tx.assessment.update({ where: { id }, data: { version: { increment: 1 } } });
      const name = sectionsOf(snapshotOf(r)).find((s) => s.code === code)?.name ?? code;
      const parts = [
        ...changes.map((c) => `${c.field === 'level' ? 'балл' : 'цель'} ${c.from} → ${c.to}`),
        ...(commentChanged ? ['комментарий изменён'] : []),
      ];
      await auditSettings(tx, actor, {
        action: 'assessment.answer_updated', entity: ENTITY, entityId: id,
        summary: `Самооценка «${r.title}», ${code} ${name}: ${parts.join(', ')}`,
        after: { code, changes, commentChanged },
      });
    }
    const fresh = await getRow(tx, id);
    const saved = fresh.answers.find((x) => x.sectionCode === code);
    return {
      answer: saved ? { code, level: saved.level, targetLevel: saved.targetLevel, comment: saved.comment, version: saved.version, updatedAt: saved.updatedAt.toISOString(), updatedBy: saved.updater?.fullName ?? null } : null,
      score: scoreOf(fresh),
      version: fresh.version,
    };
  });
}

/**
 * Обновить методику черновика до активной (1.13.8, ADR-0050): новый снимок, пустые строки ответов для новых разделов;
 * ответы, цели и комментарии существующих разделов не трогаются, итог не меняется (новые домены вне итога).
 * Только черновик; активная совпадает со снимком — 409 SAME_METHODOLOGY.
 */
export async function upgradeMethodology(db: Db, actor: Actor, id: string, input: { version: number }) {
  return withTx(db, async (tx) => {
    const r = await getRow(tx, id);
    if (r.version !== input.version) throw versionConflict();
    draftOnly(r);
    const m = await activeMethodology(tx);
    const from = snapshotOf(r);
    const to = m.content as unknown as Methodology;
    if (sameMethodology(from, to)) throw conflict('SAME_METHODOLOGY', `Оценка уже на методике ${to.code} v${to.version}`);
    const have = new Set(r.answers.map((a) => a.sectionCode));
    const added = sectionsOf(to).filter((sec) => !have.has(sec.code)).map((sec) => sec.code);
    const res = await tx.assessment.updateMany({
      where: { id, version: input.version },
      data: { methodologyId: m.id, methodologySnapshot: m.content as Prisma.InputJsonValue, version: { increment: 1 } },
    });
    if (res.count === 0) throw versionConflict();
    if (added.length) await tx.assessmentAnswer.createMany({ data: added.map((code) => ({ assessmentId: id, sectionCode: code })) });
    await auditSettings(tx, actor, {
      action: 'assessment.methodology_upgraded', entity: ENTITY, entityId: id,
      summary: `Самооценка «${r.title}»: методика обновлена — ${from.code} v${from.version} → ${to.code} v${to.version}, новых разделов ${added.length}${added.length ? ` (${added.join(', ')})` : ''}`,
      before: { methodology: `${from.code} v${from.version}` },
      after: { methodology: `${to.code} v${to.version}`, added },
    });
  });
}

/** Зафиксировать: только при всех разделах снимка (24 у v1, 28 у v2), итог замораживается (правила 5 и «Жизненный цикл»). */
export async function finalizeAssessment(db: Db, actor: Actor, id: string, input: { version: number }) {
  return withTx(db, async (tx) => {
    const r = await getRow(tx, id);
    if (r.version !== input.version) throw versionConflict();
    draftOnly(r);
    const s = score(snapshotOf(r), answersOf(r));
    if (s.preliminary) throw conflict('INCOMPLETE', `Заполнено ${s.answered} из ${s.sections} разделов: зафиксировать можно, когда отвечены все`);
    const res = await tx.assessment.updateMany({
      where: { id, version: input.version },
      data: { status: 'final', result: s as unknown as Prisma.InputJsonValue, finalizedAt: new Date(), finalizedBy: actor.id, version: { increment: 1 } },
    });
    if (res.count === 0) throw versionConflict();
    await auditSettings(tx, actor, {
      action: 'assessment.finalized', entity: ENTITY, entityId: id,
      summary: `Самооценка «${r.title}» зафиксирована: ${s.total} из ${s.max}, «${s.level.name}»`,
      after: { total: s.total, level: s.level.code },
    });
  });
}

/** Вернуть в черновик (с необязательным комментарием): итог снова считается на лету. */
export async function reopenAssessment(db: Db, actor: Actor, id: string, input: { version: number; comment?: string }) {
  return withTx(db, async (tx) => {
    const r = await getRow(tx, id);
    if (r.version !== input.version) throw versionConflict();
    if (r.status !== 'final') throw conflict('NOT_FINAL', 'В черновик возвращается только зафиксированная оценка');
    const comment = (input.comment ?? '').trim();
    if (comment.length > COMMENT_MAX) throw badRequest('TOO_LONG', `Комментарий — не длиннее ${COMMENT_MAX} символов`);
    try {
      await withTx(tx, (t) => t.assessment.update({
        where: { id },
        data: { status: 'draft', result: Prisma.DbNull, finalizedAt: null, finalizedBy: null, reopenComment: comment, version: { increment: 1 } },
      }));
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('DRAFT_EXISTS', 'Уже есть оценка в работе (черновик): сначала зафиксируйте или отправьте её в архив');
      throw err;
    }
    await auditSettings(tx, actor, {
      action: 'assessment.reopened', entity: ENTITY, entityId: id,
      summary: `Самооценка «${r.title}» возвращена в черновик${comment ? ' с комментарием' : ''}`,
      after: { commented: comment.length > 0 },
    });
  });
}

/** В архив (удаления нет — ADR-0026). */
export async function archiveAssessment(db: Db, actor: Actor, id: string, input: { version: number }) {
  return withTx(db, async (tx) => {
    const r = await getRow(tx, id);
    if (r.version !== input.version) throw versionConflict();
    if (r.status === 'archived') return;
    const res = await tx.assessment.updateMany({ where: { id, version: input.version }, data: { status: 'archived', archivedAt: new Date(), version: { increment: 1 } } });
    if (res.count === 0) throw versionConflict();
    await auditSettings(tx, actor, { action: 'assessment.archived', entity: ENTITY, entityId: id, summary: `Самооценка «${r.title}» отправлена в архив` });
  });
}

/** Журнал оценки или одного раздела — из audit_log (право «История в карточках» не нужно, ADR-0026). */
export async function assessmentLog(db: Db, id: string, code?: string) {
  await getRow(db, id);
  const rows = await db.auditLog.findMany({
    where: { entity: ENTITY, entityId: id, ...(code ? { diff: { path: ['after', 'code'], equals: code } } : {}) },
    include: { user: { select: { fullName: true } } },
    orderBy: [{ at: 'desc' }, { id: 'desc' }],
    take: 500,
  });
  return {
    items: rows.map((r) => ({
      id: String(r.id), at: r.at.toISOString(), actor: r.user?.fullName ?? 'Система', action: r.action,
      summary: typeof (r.diff as { summary?: unknown } | null)?.summary === 'string' ? (r.diff as { summary: string }).summary : '',
    })),
  };
}

/** Сравнение двух оценок по разделам и доменам. */
export async function compareAssessments(db: Db, aId: string, bId: string) {
  const [a, b] = await Promise.all([getRow(db, aId), getRow(db, bId)]);
  const sa = scoreOf(a);
  const sb = scoreOf(b);
  const inA = new Set(sectionsOf(snapshotOf(a)).map((s) => s.code));
  return {
    a: summaryDto(a), b: summaryDto(b),
    domains: sb.domains.map((d) => {
      const x = sa.domains.find((y) => y.no === d.no);
      return { no: d.no, name: d.name, a: x?.sum ?? null, b: d.sum, aAvg: x?.avg ?? null, bAvg: d.avg };
    }),
    // inA — раздел есть в снимке первой оценки (1.13.8): иначе «нет в прошлой оценке», а не «не отвечено».
    sections: sectionsOf(snapshotOf(b)).map((s) => ({
      code: s.code, name: s.name, inA: inA.has(s.code),
      a: a.answers.find((x) => x.sectionCode === s.code)?.level ?? null,
      b: b.answers.find((x) => x.sectionCode === s.code)?.level ?? null,
    })),
    delta: compareScores({ score: sb, answers: answersOf(b) }, { score: sa, answers: answersOf(a) }),
  };
}

// ---------------------------------------------------------------- задачи по разрывам (ADR-0026)

export const TASK_TITLE_MAX = 300;

/** Исполнители для формы задачи: активные сотрудники с ib.work, только id и имя. */
export async function taskAssignees(db: Db) {
  return { items: (await userOptions(db, 'ib')).map((u) => ({ id: u.id, fullName: u.fullName })) };
}

/**
 * Задача по разрыву раздела — на общей доске. Право даёт сам раздел (assessment.manage): «Задачи: постановка другим»
 * не нужно; исполнитель — активный сотрудник с ib.work. Задача — обычная ручная (source = 'manual'): в её карточке
 * и журнале нет ни раздела, ни баллов, ни ссылки; связь — только в assessment_links, видна внутри раздела.
 */
export async function createGapTask(db: Db, actor: Actor, id: string, code: string,
  input: { title: string; categoryId: string; assigneeId: string; dueDate?: string | null }) {
  return withTx(db, async (tx) => {
    const r = await getRow(tx, id);
    if (r.status === 'archived') throw conflict('ARCHIVED', 'Оценка в архиве: задачи по ней не ставятся');
    const answer = r.answers.find((x) => x.sectionCode === code);
    if (!answer) throw notFound('Раздел');
    await assertAssignee(tx, input.assigneeId);
    // Постановка другому — по праву раздела, а не tasks.assign (решение владельца 1 по этапу Д).
    const task = await createTask(tx, { ...actor, perms: new Set(['tasks.assign']) }, {
      title: input.title, categoryId: input.categoryId, assigneeId: input.assigneeId, dueDate: input.dueDate ?? null,
    });
    await tx.assessmentLink.create({ data: { answerId: answer.id, entityType: 'task', entityId: task.id, createdBy: actor.id } });
    const name = sectionsOf(snapshotOf(r)).find((s) => s.code === code)?.name ?? code;
    await auditSettings(tx, actor, {
      action: 'assessment.task_linked', entity: ENTITY, entityId: id,
      summary: `Самооценка «${r.title}», ${code} ${name}: поставлена задача #${task.number}`,
      after: { code, taskId: task.id },
    });
    const linked = (await linkedTasks(tx, id)).find((t) => t.id === task.id);
    if (!linked) throw new Error('задача по разрыву не найдена после создания');
    return linked;
  });
}

// ---------------------------------------------------------------- напоминание о переоценке (правило 11)

export const REMIND_DAYS = 30;
export const REMINDER_KIND = 'assessment_reminder' as const;
export const REMINDER_LINK = '/assessment/overview';

/** Годовщина даты оценки; 29 февраля → 1 марта следующего года. */
export function anniversaryOf(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y + 1, m - 1, d)).toISOString().slice(0, 10);
}

/**
 * За 30 дней до годовщины последней зафиксированной оценки — «Пора провести самооценку» всем активным держателям
 * assessment.manage. Без повторов (dedupe_key по дате годовщины); не приходит, если черновик уже есть.
 */
export async function notifyReassessment(db: Db, now = new Date()): Promise<number> {
  if (await db.assessment.count({ where: { status: 'draft' } })) return 0;
  const last = await db.assessment.findFirst({ where: { status: 'final' }, orderBy: [{ assessedOn: 'desc' }, { finalizedAt: 'desc' }] });
  if (!last) return 0;
  const assessed = isoDay(last.assessedOn);
  const anniversary = anniversaryOf(assessed);
  if (todayIso(now) < addDaysIso(anniversary, -REMIND_DAYS)) return 0;
  const owners = await db.user.findMany({
    where: { isActive: true, roles: { some: { role: { permissions: { some: { permissionCode: 'assessment.manage' } } } } } },
    select: { id: true },
  });
  return notify(db, {
    kind: REMINDER_KIND, to: owners.map((u) => u.id), actorId: null, dedupeKey: `assessment_reminder:${anniversary}`,
    title: 'Пора провести самооценку',
    body: `${formatDateRu(anniversary)} — год с оценки «${last.title}» от ${formatDateRu(assessed)}. Создайте новую оценку в разделе «Самооценка».`,
  });
}
