// Шаблоны форм подтверждения (docs/concept.md, раздел 8). Загруженная форма хранит снимок полей,
// поэтому правка шаблона не меняет старые формы и поля можно удалять свободно.
import { Prisma } from '../../generated/prisma/client.js';
import { withTx, type Db } from '../../lib/db.js';
import { badRequest, conflict, notFound, versionConflict } from '../../lib/errors.js';
import { auditSettings, ensureVersioned, trimmed, type Actor } from '../settings/common.js';
import { formTemplateUsage } from '../settings/usage.js';
import '../settings/usage-counters.js';

export type CheckKind = 'min' | 'max' | 'yes' | 'text';
const KIND_TEXT: Record<CheckKind, string> = { min: 'не менее', max: 'не более', yes: 'да / нет', text: 'текст' };

const fieldsWhere = {
  where: { deletedAt: null },
  orderBy: [{ sortOrder: 'asc' as const }, { createdAt: 'asc' as const }],
};
const include = { fields: fieldsWhere } satisfies Prisma.FormTemplateInclude;
type TemplateRow = Prisma.FormTemplateGetPayload<{ include: typeof include }>;
type FieldRow = TemplateRow['fields'][number];

export interface FieldDto {
  id: string;
  label: string;
  checkKind: CheckKind;
  threshold: number | null;
  sortOrder: number;
  version: number;
}

const fieldDto = (f: FieldRow): FieldDto => ({
  id: f.id,
  label: f.label,
  checkKind: f.checkKind as CheckKind,
  threshold: f.threshold === null ? null : Number(f.threshold),
  sortOrder: f.sortOrder,
  version: f.version,
});

const templateDto = (t: TemplateRow, usage: number) => ({
  id: t.id,
  name: t.name,
  basis: t.basis,
  validMonths: t.validMonths,
  version: t.version,
  archived: t.archivedAt !== null,
  usage,
  fields: t.fields.map(fieldDto),
});

export type TemplateDto = ReturnType<typeof templateDto>;

async function getTemplate(db: Db, id: string) {
  const t = await db.formTemplate.findFirst({ where: { id, deletedAt: null }, include });
  if (!t) throw notFound('Шаблон формы');
  return t;
}

async function withUsage(db: Db, rows: TemplateRow[]) {
  const usage = await formTemplateUsage.count(db, rows.map((r) => r.id));
  return rows.map((r) => templateDto(r, usage.get(r.id) ?? 0));
}

export async function listTemplates(db: Db, opts: { includeArchived: boolean }) {
  const rows = await db.formTemplate.findMany({
    where: { deletedAt: null, ...(opts.includeArchived ? {} : { archivedAt: null }) },
    include,
    orderBy: { name: 'asc' },
  });
  return withUsage(db, rows);
}

async function fresh(db: Db, id: string) {
  return (await withUsage(db, [await getTemplate(db, id)]))[0] as TemplateDto;
}

async function assertNameFree(db: Db, name: string, exceptId?: string) {
  const clash = await db.formTemplate.findFirst({
    where: { deletedAt: null, name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
  });
  if (clash) throw conflict('DUPLICATE', `Шаблон «${name}» уже есть`);
}

/** У проверок «не менее» и «не более» обязателен порог, у остальных его нет. */
function normalizeThreshold(kind: CheckKind, threshold: number | null | undefined): number | null {
  if (kind === 'min' || kind === 'max') {
    if (threshold === null || threshold === undefined || !Number.isFinite(threshold)) {
      throw badRequest('THRESHOLD_REQUIRED', `Для проверки «${KIND_TEXT[kind]}» укажите значение`);
    }
    return threshold;
  }
  return null;
}

export async function createTemplate(db: Db, actor: Actor, input: { name: string; basis: string; validMonths: number }) {
  const name = trimmed(input.name);
  return withTx(db, async (tx) => {
    await assertNameFree(tx, name);
    const t = await tx.formTemplate.create({ data: { name, basis: trimmed(input.basis), validMonths: input.validMonths } });
    await auditSettings(tx, actor, {
      action: 'form_template.created',
      entity: 'form_template',
      entityId: t.id,
      summary: `Шаблоны форм: создан «${name}»`,
      after: { name, basis: t.basis, validMonths: t.validMonths },
    });
    return fresh(tx, t.id);
  });
}

export async function updateTemplate(
  db: Db,
  actor: Actor,
  id: string,
  input: { version: number; name?: string; basis?: string; validMonths?: number },
) {
  return withTx(db, async (tx) => {
    const t = await getTemplate(tx, id);
    const data: Prisma.FormTemplateUpdateManyMutationInput = {};
    if (input.name !== undefined && trimmed(input.name) !== t.name) {
      await assertNameFree(tx, trimmed(input.name), id);
      data.name = trimmed(input.name);
    }
    if (input.basis !== undefined && trimmed(input.basis) !== t.basis) data.basis = trimmed(input.basis);
    if (input.validMonths !== undefined && input.validMonths !== t.validMonths) data.validMonths = input.validMonths;
    if (Object.keys(data).length === 0) {
      if (input.version !== t.version) throw versionConflict();
      return fresh(tx, id);
    }
    const res = await tx.formTemplate.updateMany({ where: { id, version: input.version, deletedAt: null }, data: { ...data, version: { increment: 1 } } });
    await ensureVersioned(res.count, () => tx.formTemplate.findFirst({ where: { id, deletedAt: null } }), 'Шаблон формы');
    await auditSettings(tx, actor, {
      action: 'form_template.updated',
      entity: 'form_template',
      entityId: id,
      summary: `Шаблоны форм: изменён «${t.name}»${data.name ? ` → «${String(data.name)}»` : ''}`,
      before: { name: t.name, basis: t.basis, validMonths: t.validMonths },
      after: { ...data },
    });
    return fresh(tx, id);
  });
}

async function setArchived(db: Db, actor: Actor, id: string, version: number, archived: boolean) {
  return withTx(db, async (tx) => {
    const t = await getTemplate(tx, id);
    const res = await tx.formTemplate.updateMany({
      where: { id, version, deletedAt: null },
      data: { archivedAt: archived ? new Date() : null, version: { increment: 1 } },
    });
    await ensureVersioned(res.count, () => tx.formTemplate.findFirst({ where: { id, deletedAt: null } }), 'Шаблон формы');
    await auditSettings(tx, actor, {
      action: archived ? 'form_template.archived' : 'form_template.restored',
      entity: 'form_template',
      entityId: id,
      summary: `Шаблоны форм: ${archived ? 'отправлен в архив' : 'возвращён из архива'} «${t.name}»`,
    });
    return fresh(tx, id);
  });
}

export const archiveTemplate = (db: Db, a: Actor, id: string, v: number) => setArchived(db, a, id, v, true);
export const restoreTemplate = (db: Db, a: Actor, id: string, v: number) => setArchived(db, a, id, v, false);

export async function deleteTemplate(db: Db, actor: Actor, id: string, version: number) {
  await withTx(db, async (tx) => {
    const t = await getTemplate(tx, id);
    const used = (await formTemplateUsage.count(tx, [id])).get(id) ?? 0;
    if (used > 0) throw conflict('IN_USE', `По шаблону загружено форм: ${used}. Отправьте шаблон в архив`);
    const res = await tx.formTemplate.updateMany({ where: { id, version, deletedAt: null }, data: { deletedAt: new Date(), version: { increment: 1 } } });
    await ensureVersioned(res.count, () => tx.formTemplate.findFirst({ where: { id, deletedAt: null } }), 'Шаблон формы');
    await auditSettings(tx, actor, {
      action: 'form_template.deleted',
      entity: 'form_template',
      entityId: id,
      summary: `Шаблоны форм: удалён «${t.name}»`,
      before: { name: t.name, fields: t.fields.map((f) => f.label) },
    });
  });
}

async function getField(db: Db, id: string) {
  const f = await db.formTemplateField.findFirst({ where: { id, deletedAt: null }, include: { template: true } });
  if (!f || f.template.deletedAt) throw notFound('Поле шаблона');
  return f;
}

function requirement(kind: CheckKind, threshold: number | null): string {
  return threshold === null ? KIND_TEXT[kind] : `${KIND_TEXT[kind]} ${threshold}`;
}

export async function addField(
  db: Db,
  actor: Actor,
  templateId: string,
  input: { label: string; checkKind: CheckKind; threshold?: number | null },
) {
  return withTx(db, async (tx) => {
    const t = await getTemplate(tx, templateId);
    const label = trimmed(input.label);
    const threshold = normalizeThreshold(input.checkKind, input.threshold);
    const max = await tx.formTemplateField.aggregate({ where: { templateId }, _max: { sortOrder: true } });
    const f = await tx.formTemplateField.create({
      data: { templateId, label, checkKind: input.checkKind, threshold, sortOrder: (max._max.sortOrder ?? 0) + 1 },
    });
    await auditSettings(tx, actor, {
      action: 'form_template.field.created',
      entity: 'form_template_field',
      entityId: f.id,
      summary: `Шаблон «${t.name}»: добавлено поле «${label}» (${requirement(input.checkKind, threshold)})`,
      after: { label, checkKind: input.checkKind, threshold },
    });
    return fresh(tx, templateId);
  });
}

export async function updateField(
  db: Db,
  actor: Actor,
  id: string,
  input: { version: number; label?: string; checkKind?: CheckKind; threshold?: number | null },
) {
  return withTx(db, async (tx) => {
    const f = await getField(tx, id);
    const kind = input.checkKind ?? (f.checkKind as CheckKind);
    const thresholdIn = input.threshold !== undefined ? input.threshold : f.threshold === null ? null : Number(f.threshold);
    const threshold = normalizeThreshold(kind, thresholdIn);
    const label = input.label !== undefined ? trimmed(input.label) : f.label;
    const res = await tx.formTemplateField.updateMany({
      where: { id, version: input.version, deletedAt: null },
      data: {
        label,
        checkKind: kind,
        threshold: threshold === null ? null : new Prisma.Decimal(threshold),
        version: { increment: 1 },
      },
    });
    await ensureVersioned(res.count, () => tx.formTemplateField.findFirst({ where: { id, deletedAt: null } }), 'Поле шаблона');
    const before = { label: f.label, checkKind: f.checkKind, threshold: f.threshold === null ? null : Number(f.threshold) };
    await auditSettings(tx, actor, {
      action: 'form_template.field.updated',
      entity: 'form_template_field',
      entityId: id,
      summary: `Шаблон «${f.template.name}»: поле «${f.label}» → «${label}» (${requirement(kind, threshold)})`,
      before,
      after: { label, checkKind: kind, threshold },
    });
    return fresh(tx, f.templateId);
  });
}

export async function deleteField(db: Db, actor: Actor, id: string, version: number) {
  return withTx(db, async (tx) => {
    const f = await getField(tx, id);
    const res = await tx.formTemplateField.updateMany({ where: { id, version, deletedAt: null }, data: { deletedAt: new Date(), version: { increment: 1 } } });
    await ensureVersioned(res.count, () => tx.formTemplateField.findFirst({ where: { id, deletedAt: null } }), 'Поле шаблона');
    await auditSettings(tx, actor, {
      action: 'form_template.field.deleted',
      entity: 'form_template_field',
      entityId: id,
      summary: `Шаблон «${f.template.name}»: удалено поле «${f.label}». Уже загруженные формы его сохраняют`,
      before: { label: f.label, checkKind: f.checkKind },
    });
    return fresh(tx, f.templateId);
  });
}

/** Переместить поле на одну позицию выше или ниже. */
export async function moveField(db: Db, actor: Actor, id: string, direction: 'up' | 'down') {
  return withTx(db, async (tx) => {
    const f = await getField(tx, id);
    const siblings = await tx.formTemplateField.findMany({ where: { templateId: f.templateId, ...fieldsWhere.where }, orderBy: fieldsWhere.orderBy });
    const i = siblings.findIndex((s) => s.id === id);
    const j = direction === 'up' ? i - 1 : i + 1;
    const other = siblings[j];
    if (i < 0 || !other) return fresh(tx, f.templateId);
    // Перенумеровать по порядку, затем поменять местами соседей.
    const order = siblings.map((s) => s.id);
    [order[i], order[j]] = [other.id, id];
    for (const [k, fid] of order.entries()) {
      await tx.formTemplateField.update({ where: { id: fid }, data: { sortOrder: k + 1, version: { increment: 1 } } });
    }
    await auditSettings(tx, actor, {
      action: 'form_template.field.moved',
      entity: 'form_template_field',
      entityId: id,
      summary: `Шаблон «${f.template.name}»: поле «${f.label}» перемещено ${direction === 'up' ? 'выше' : 'ниже'}`,
    });
    return fresh(tx, f.templateId);
  });
}
