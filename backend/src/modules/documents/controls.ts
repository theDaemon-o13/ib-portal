// Механизмы контроля документа (1.11.0, ADR-0043; план — раздел 5.1): у утверждённого документа — пункт, требование,
// механизм со стороны ИБ, способ проверки, ожидаемое доказательство, подразделение-исполнитель. Ведут владелец документа,
// начальник ИБ (отметка) и docs.manage; видят сотрудники ИБ (ib.work — маршрут). Физически не удаляются (триггер) —
// только отключаются; каждое изменение — audit_log «было → стало».
import { withTx, type Db } from '../../lib/db.js';
import { badRequest, conflict, forbidden, notFound, versionConflict } from '../../lib/errors.js';
import { auditSettings, trimmed, type Actor } from '../settings/common.js';
import { accessOf, forbiddenWith, type DocAccess } from './service.js';

export const CONTROL_LIMITS = { clause: 300, requirement: 2000, mechanism: 4000, checkMethod: 4000, expectedEvidence: 4000, executorUnit: 300 } as const;
type TextField = keyof typeof CONTROL_LIMITS;
const LABELS: Record<TextField, string> = {
  clause: 'Пункт или раздел', requirement: 'Требование', mechanism: 'Механизм контроля', checkMethod: 'Способ проверки',
  expectedEvidence: 'Ожидаемое доказательство', executorUnit: 'Подразделение-исполнитель',
};
const REQUIRED: readonly TextField[] = ['requirement', 'mechanism'];

export type ControlInput = Partial<Record<TextField, string>>;
export interface ControlPatch extends ControlInput { version: number; active?: boolean }

/** Кто ведёт механизмы и автоматизации документа: владелец, начальник ИБ (отметка, не супер-администратор), docs.manage. */
export function canManageControls(a: DocAccess, doc: { ownerId: string }): boolean {
  return a.ibWork && (doc.ownerId === a.userId || (a.ibHead && !a.superAdmin) || a.manage);
}

/** Документ для механизмов и автоматизаций: только утверждённый и не удалённый; изменения — не в архиве. */
export async function controlDoc(db: Db, id: string, forChange: boolean) {
  const d = await db.document.findFirst({ where: { id, deletedAt: null }, select: { id: true, number: true, ownerId: true, approvedVersionId: true, archivedAt: true, approvedVersion: { select: { title: true } } } });
  if (!d) throw notFound('Документ');
  if (!d.approvedVersionId) throw conflict('NOT_APPROVED', 'Механизмы контроля и автоматизации — у утверждённого документа');
  if (forChange && d.archivedAt) throw conflict('DOC_ARCHIVED', 'Документ в архиве. Верните его из архива, чтобы менять механизмы контроля');
  return { ...d, title: d.approvedVersion?.title ?? '' };
}

/** Многострочные поля сохраняют переносы строк; однострочные — без лишних пробелов. */
const MULTILINE: readonly TextField[] = ['mechanism', 'checkMethod', 'expectedEvidence'];
function clean(v: string | undefined, f: TextField, required: boolean): string {
  const t = MULTILINE.includes(f) ? (v ?? '').trim() : trimmed(v ?? '');
  if (required && !t) throw badRequest('EMPTY', `Укажите: ${LABELS[f].toLowerCase()}`);
  if (t.length > CONTROL_LIMITS[f]) throw badRequest('TOO_LONG', `${LABELS[f]} — не длиннее ${CONTROL_LIMITS[f]} символов`);
  return t;
}

const controlSelect = {
  id: true, position: true, clause: true, requirement: true, mechanism: true, checkMethod: true, expectedEvidence: true, executorUnit: true,
  active: true, version: true, createdAt: true, updatedAt: true, creator: { select: { fullName: true } },
} as const;
type ControlRow = { id: string; position: number; clause: string; requirement: string; mechanism: string; checkMethod: string; expectedEvidence: string;
  executorUnit: string; active: boolean; version: number; createdAt: Date; updatedAt: Date; creator: { fullName: string } };
const dto = (c: ControlRow) => ({ ...c, creator: c.creator.fullName, createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString() });
export type ControlDto = ReturnType<typeof dto>;

export async function listControls(db: Db, actor: Actor, id: string) {
  const a = await accessOf(db, actor.id);
  if (!a.ibWork) throw forbidden();
  const d = await controlDoc(db, id, false);
  const rows = await db.documentControl.findMany({ where: { documentId: id }, select: controlSelect, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] });
  return { items: rows.map(dto), canManage: canManageControls(a, d) && !d.archivedAt };
}

async function manageContext(db: Db, actor: Actor, id: string) {
  const a = await accessOf(db, actor.id);
  const d = await controlDoc(db, id, true);
  if (!canManageControls(a, d)) throw forbiddenWith('FORBIDDEN', 'Механизмы контроля ведут владелец документа, начальник ИБ и «Документы: управление»');
  return d;
}

export async function createControl(db: Db, actor: Actor, id: string, input: ControlInput) {
  return withTx(db, async (tx) => {
    const d = await manageContext(tx, actor, id);
    const data = Object.fromEntries((Object.keys(CONTROL_LIMITS) as TextField[]).map((f) => [f, clean(input[f], f, REQUIRED.includes(f))])) as Record<TextField, string>;
    const last = await tx.documentControl.aggregate({ where: { documentId: id }, _max: { position: true } });
    const c = await tx.documentControl.create({ data: { documentId: id, position: (last._max.position ?? 0) + 1, ...data, createdBy: actor.id }, select: controlSelect });
    await auditSettings(tx, actor, {
      action: 'document_control.created', entity: 'document', entityId: id,
      summary: `Документ #${d.number} «${d.title}»: механизм контроля ${c.position} — «${c.requirement}»`,
      after: { controlId: c.id, ...data },
    });
    return dto(c);
  });
}

export async function updateControl(db: Db, actor: Actor, id: string, controlId: string, input: ControlPatch) {
  return withTx(db, async (tx) => {
    const d = await manageContext(tx, actor, id);
    const cur = await tx.documentControl.findFirst({ where: { id: controlId, documentId: id }, select: controlSelect });
    if (!cur) throw notFound('Механизм контроля');
    if (cur.version !== input.version) throw versionConflict();
    const data: Partial<Record<TextField, string>> & { active?: boolean } = {};
    const changes: { label: string; from: string; to: string }[] = [];
    for (const f of Object.keys(CONTROL_LIMITS) as TextField[]) {
      if (input[f] === undefined) continue;
      const v = clean(input[f], f, REQUIRED.includes(f));
      if (v !== cur[f]) { data[f] = v; changes.push({ label: LABELS[f], from: cur[f] || '—', to: v || '—' }); }
    }
    if (input.active !== undefined && input.active !== cur.active) {
      data.active = input.active;
      changes.push({ label: 'Активно', from: cur.active ? 'да' : 'нет', to: input.active ? 'да' : 'нет' });
    }
    if (!changes.length) return dto(cur);
    const res = await tx.documentControl.updateMany({ where: { id: controlId, version: input.version }, data: { ...data, version: { increment: 1 } } });
    if (res.count === 0) throw versionConflict();
    const kind = data.active === false ? 'disabled' : data.active === true ? 'enabled' : 'updated';
    await auditSettings(tx, actor, {
      action: `document_control.${kind}`, entity: 'document', entityId: id,
      summary: `Документ #${d.number} «${d.title}»: механизм контроля ${cur.position} — ${kind === 'disabled' ? 'отключён' : kind === 'enabled' ? 'включён' : changes.map((c) => `«${c.label}»`).join(', ')}`,
      before: Object.fromEntries(changes.map((c) => [c.label, c.from])), after: { controlId, changes },
    });
    return dto(await tx.documentControl.findUniqueOrThrow({ where: { id: controlId }, select: controlSelect }));
  });
}
