// Решения другого отдела (ADR-0007, этап 7): вносятся только с файлом документа-основания, номером и датой
// документа. Таблица register_decisions только пополняется; значение поля — последнее решение.
// Документ-основание сразу попадает в доказательную базу (доказательство «Решение другого отдела», принято).
// В «Реестре рисков ИБ» решение заполняет «№ в реестре ОУР» и «Пересмотр до» той же транзакцией.
import type { Prisma } from '../../generated/prisma/client.js';
import { withTx, type Db } from '../../lib/db.js';
import { badRequest, conflict, notFound, versionConflict } from '../../lib/errors.js';
import { formatDateRu, type Values } from '../../lib/register-values.js';
import { todayIso } from '../../lib/today.js';
import { createDecisionEvidence } from '../evidence/service.js';
import { claimFiles } from '../files/links.js';
import { isRiskRegister, riskField } from '../risks/definition.js';
import { auditSettings, ensureVersioned, trimmed, type Actor } from '../settings/common.js';
import { assertNotArchived, loadRegister, loadUsers, searchTextOf, userIdsIn } from './definition.js';
import { getRecord } from './records.service.js';

export const DOC_TITLE_MAX = 300;
export const DOC_NUMBER_MAX = 100;
export const REF_MAX = 100;

export interface DecisionInput {
  /** Версия записи, которую видел пользователь: решение меняет отображение записи. */
  recordVersion: number;
  fieldId: string;
  optionId: string;
  documentTitle: string;
  documentNumber: string;
  documentDate: string;
  fileId: string;
  reviewDue?: string | null;
  /** № в реестре другого отдела (реестр рисков: «№ в реестре ОУР»). */
  externalRef?: string | null;
}

const isIso = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

export async function addDecision(db: Db, actor: Actor, recordId: string, input: DecisionInput) {
  return withTx(db, async (tx) => {
    const row = await tx.registerRecord.findFirst({ where: { id: recordId, deletedAt: null } });
    if (!row) throw notFound('Запись');
    const reg = await loadRegister(tx, row.registerId);
    assertNotArchived(reg);
    if (row.archivedAt) throw conflict('RECORD_ARCHIVED', 'Запись в архиве. Верните её, чтобы внести решение');
    if (row.version !== input.recordVersion) throw versionConflict();

    const field = reg.fields.find((f) => f.id === input.fieldId && f.type === 'decision');
    if (!field) throw badRequest('BAD_FIELD', 'У реестра нет такого поля «Решение другого отдела»');
    if (field.archived) throw badRequest('BAD_FIELD', `Поле «${field.label}» в архиве`);
    const active = field.options.filter((o) => !o.archived).sort((a, b) => a.sortOrder - b.sortOrder);
    const option = active.find((o) => o.id === input.optionId);
    // Первый вариант («Ожидает решения») — состояние до решения, его не вносят.
    if (!option || option.id === active[0]?.id) throw badRequest('BAD_OPTION', 'Выберите решение из списка');

    const documentTitle = trimmed(input.documentTitle);
    const documentNumber = trimmed(input.documentNumber);
    if (!documentTitle) throw badRequest('NO_DOCUMENT', 'Укажите документ-основание');
    if (!documentNumber) throw badRequest('NO_DOCUMENT_NUMBER', 'Укажите номер документа');
    if (documentTitle.length > DOC_TITLE_MAX || documentNumber.length > DOC_NUMBER_MAX) throw badRequest('TOO_LONG', 'Слишком длинное название или номер документа');
    const today = todayIso();
    if (!isIso(input.documentDate)) throw badRequest('NO_DOCUMENT_DATE', 'Укажите дату документа');
    if (input.documentDate > today) throw badRequest('BAD_DATE', 'Дата документа не может быть позже сегодняшней');
    const reviewDue = input.reviewDue || null;
    if (reviewDue !== null && !isIso(reviewDue)) throw badRequest('BAD_DATE', '«Пересмотр до» — дата');
    const externalRef = trimmed(input.externalRef ?? '');
    if (externalRef.length > REF_MAX) throw badRequest('TOO_LONG', `Номер в реестре — не длиннее ${REF_MAX} символов`);

    const [file] = await claimFiles(tx, actor.id, [input.fileId], { what: 'Документ-основание' });
    if (!file) throw badRequest('NO_FILE', 'Приложите файл документа-основания: без него решение не сохраняется');

    // В реестре рисков решение заполняет «№ в реестре ОУР» и «Пересмотр до».
    const current = (row.values ?? {}) as Values;
    const values: Values = { ...current };
    const mirrored: { fieldId: string; label: string; from: string; to: string }[] = [];
    if (isRiskRegister(reg)) {
      const ref = riskField(reg, 'ormRef');
      if (ref && externalRef && current[ref.id] !== externalRef) {
        values[ref.id] = externalRef;
        mirrored.push({ fieldId: ref.id, label: ref.label, from: String(current[ref.id] ?? '—'), to: externalRef });
      }
      const due = riskField(reg, 'reviewDue');
      if (due && reviewDue && current[due.id] !== reviewDue) {
        values[due.id] = reviewDue;
        mirrored.push({ fieldId: due.id, label: due.label, from: typeof current[due.id] === 'string' ? formatDateRu(current[due.id] as string) : '—', to: formatDateRu(reviewDue) });
      }
    }
    const users = await loadUsers(tx, userIdsIn(reg, [values]));
    const res = await tx.registerRecord.updateMany({
      where: { id: recordId, version: input.recordVersion, deletedAt: null },
      data: {
        ...(mirrored.length ? { values: values as Prisma.InputJsonValue, searchText: searchTextOf(reg, row.number, values, users) } : {}),
        version: { increment: 1 },
      },
    });
    await ensureVersioned(res.count, () => tx.registerRecord.findFirst({ where: { id: recordId, deletedAt: null } }), 'Запись');

    const decision = await tx.registerDecision.create({
      data: {
        recordId, fieldId: field.id, optionId: option.id, documentTitle, documentNumber,
        documentDate: new Date(`${input.documentDate}T00:00:00Z`), fileId: file.id,
        reviewDue: reviewDue ? new Date(`${reviewDue}T00:00:00Z`) : null, decidedBy: actor.id,
      },
    });
    const ev = await createDecisionEvidence(tx, actor, {
      decisionId: decision.id, recordId, fileId: file.id,
      title: `${field.label} «${option.label}»: ${documentTitle} № ${documentNumber}`,
    });
    const before = await tx.registerDecision.count({ where: { recordId, fieldId: field.id } });
    await auditSettings(tx, actor, {
      action: 'register_record.decision_added', entity: 'register_record', entityId: recordId,
      summary: `«${reg.name}», запись #${row.number}: «${field.label}» — «${option.label}» по документу «${documentTitle}» № ${documentNumber} от ${formatDateRu(input.documentDate)}; файл «${file.originalName}», доказательство #${ev.number}`,
      after: {
        changes: [
          { fieldId: field.id, label: field.label, from: before > 1 ? 'прежнее решение' : 'Ожидает решения', to: option.label },
          ...mirrored,
        ],
        decisionId: decision.id, fileId: file.id, sha256: file.sha256, evidenceId: ev.id,
      },
    });
    return getRecord(tx, recordId);
  });
}

/** История решений по полю записи: только пополняется, новые сверху. */
export async function listDecisions(db: Db, recordId: string, fieldId?: string) {
  const row = await db.registerRecord.findFirst({ where: { id: recordId, deletedAt: null }, select: { id: true } });
  if (!row) throw notFound('Запись');
  const rows = await db.registerDecision.findMany({
    where: { recordId, ...(fieldId ? { fieldId } : {}) },
    include: {
      option: { select: { label: true } },
      author: { select: { fullName: true } },
      file: { select: { id: true, originalName: true, mime: true, sha256: true, size: true } },
      evidence: { select: { id: true, number: true } },
    },
    orderBy: { decidedAt: 'desc' },
  });
  return rows.map((d) => ({
    id: d.id,
    fieldId: d.fieldId,
    optionId: d.optionId,
    label: d.option.label,
    documentTitle: d.documentTitle,
    documentNumber: d.documentNumber,
    documentDate: d.documentDate.toISOString().slice(0, 10),
    reviewDue: d.reviewDue?.toISOString().slice(0, 10) ?? null,
    decidedAt: d.decidedAt.toISOString(),
    decidedBy: d.author.fullName,
    file: { id: d.file.id, name: d.file.originalName, mime: d.file.mime, sha256: d.file.sha256, size: Number(d.file.size) },
    evidence: d.evidence,
  }));
}
