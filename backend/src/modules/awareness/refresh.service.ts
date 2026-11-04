// «Обновить по сотрудникам» (релиз 1.8.0, docs/specs/awareness.md, раздел 5, решение владельца 8): записи «Результатов
// INDIGO» со статусом «Не сопоставлен», которые теперь сопоставляются «Точно» по правилам импорта (ADR-0038), —
// например, после загрузки «Сотрудников». «Точно» и «Вручную» не трогаются; подразделение у уже связанных не меняется.
// Два шага, как массовые действия (ADR-0016): предпросмотр → применение с expected (разошлось — 409 BULK_CHANGED).
import type { Prisma } from '../../generated/prisma/client.js';
import { withTx, type Db } from '../../lib/db.js';
import { AppError, badRequest, conflict } from '../../lib/errors.js';
import { displayValue, sameValue, type Values } from '../../lib/register-values.js';
import { assertNotArchived, loadRegister, loadUsers, searchTextOf, userIdsIn, type FieldMeta, type RegisterDef } from '../registers/definition.js';
import { linkIdsIn, linkLabels, loadLinkRefs } from '../registers/links.js';
import { auditSettings, type Actor } from '../settings/common.js';
import { AWARENESS_EMPLOYEES_KEY, AWARENESS_RESULTS_KEY } from './definition.js';
import { normalizeFio } from './logic.js';

export interface RefreshItem {
  recordId: string;
  number: number;
  version: number;
  fio: string;
  test: string;
  date: string | null;
  employee: { id: string; number: number; fio: string };
  deptFrom: string;
  deptTo: string;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const field = (reg: RegisterDef, key: string): FieldMeta => {
  const f = reg.fields.find((x) => x.systemKey === key && !x.archived);
  if (!f) throw conflict('AWARENESS_FIELD_MISSING', `В реестре «${reg.name}» нет системного поля «${key}». Обратитесь к администратору`);
  return f;
};
const option = (f: FieldMeta, key: string): string => {
  const o = f.options.find((x) => x.systemKey === key && !x.archived);
  if (!o) throw conflict('AWARENESS_FIELD_MISSING', `В поле «${f.label}» нет системного значения «${key}». Обратитесь к администратору`);
  return o.id;
};

async function registers(db: Db, registerId: string) {
  const res = await loadRegister(db, registerId);
  if (res.systemKey !== AWARENESS_RESULTS_KEY) throw conflict('WRONG_REGISTER', '«Обновить по сотрудникам» — только для реестра «Результаты INDIGO»');
  const empRow = await db.register.findUnique({ where: { systemKey: AWARENESS_EMPLOYEES_KEY }, select: { id: true } });
  if (!empRow) throw conflict('AWARENESS_FIELD_MISSING', 'Нет системного реестра «Сотрудники». Обратитесь к администратору');
  return { res, emp: await loadRegister(db, empRow.id) };
}

/**
 * Что изменится: записи «Не сопоставлен» (неудалённые, не в архиве), у которых ФИО полное (не меньше трёх слов — с
 * отчеством) и совпадает ровно с одним работающим сотрудником. Подразделение — «было → станет» (группа → сотрудник;
 * пустое у сотрудника — без изменения).
 */
export async function previewRefresh(db: Db, registerId: string): Promise<{ items: RefreshItem[]; total: number }> {
  const { res, emp } = await registers(db, registerId);
  const R = (k: string) => field(res, k);
  const none = option(R('match'), 'none');
  const working = option(field(emp, 'status'), 'working');
  const [eFio, eDept, eStatus] = [field(emp, 'fullName'), field(emp, 'dept'), field(emp, 'status')];
  const people = await db.registerRecord.findMany({ where: { registerId: emp.id, deletedAt: null, archivedAt: null }, select: { id: true, number: true, values: true } });
  const byFio = new Map<string, { id: string; number: number; fio: string; dept: string }[]>();
  for (const p of people) {
    const v = p.values as Values;
    if (v[eStatus.id] !== working || !str(v[eFio.id])) continue;
    const k = normalizeFio(str(v[eFio.id]));
    byFio.set(k, [...(byFio.get(k) ?? []), { id: p.id, number: p.number, fio: str(v[eFio.id]), dept: str(v[eDept.id]) }]);
  }
  const rows = await db.$queryRaw<{ id: string; number: number; version: number; values: Values }[]>`
    SELECT r.id::text, r.number, r.version, r."values" FROM register_records r
    WHERE r.register_id = ${res.id}::uuid AND r.deleted_at IS NULL AND r.archived_at IS NULL AND r."values" ->> ${R('match').id} = ${none}
    ORDER BY r.number`;
  const items: RefreshItem[] = [];
  for (const r of rows) {
    const fio = str(r.values[R('fullName').id]);
    const key = normalizeFio(fio);
    if (key.split(' ').length < 3) continue;
    const found = byFio.get(key) ?? [];
    const [e] = found;
    if (found.length !== 1 || !e) continue;
    const deptFrom = str(r.values[R('dept').id]);
    items.push({
      recordId: r.id, number: r.number, version: r.version, fio,
      test: str(r.values[R('test').id]), date: str(r.values[R('date').id]) || null,
      employee: { id: e.id, number: e.number, fio: e.fio }, deptFrom, deptTo: e.dept || deptFrom,
    });
  }
  return { items, total: items.length };
}

/**
 * Применение: отмеченные записи получают связь, «Точно» и подразделение сотрудника. expected — число строк
 * предпросмотра; если строк стало другое число или отмеченная запись изменилась (версия, другой сотрудник) — 409 BULK_CHANGED,
 * ничего не меняется. Каждая запись — обычная правка с историей (via: awareness_refresh), плюс одна сводная запись журнала.
 */
export async function applyRefresh(db: Db, actor: Actor, registerId: string, input: { recordIds: string[]; expected: number }) {
  if (new Set(input.recordIds).size !== input.recordIds.length) throw badRequest('BAD_SELECTION', 'Записи повторяются');
  return withTx(db, async (tx) => {
    const p = await previewRefresh(tx, registerId);
    const byId = new Map(p.items.map((i) => [i.recordId, i]));
    const changed = () => new AppError(409, 'BULK_CHANGED', 'Записи изменились после предпросмотра — проверьте список и подтвердите ещё раз', { preview: { total: p.total } });
    if (p.total !== input.expected || input.recordIds.some((id) => !byId.has(id))) throw changed();
    const { res } = await registers(tx, registerId);
    assertNotArchived(res);
    const R = (k: string) => field(res, k);
    const exact = option(R('match'), 'exact');
    const picked = input.recordIds.map((id) => byId.get(id) as RefreshItem);
    // Версии под блокировкой: запись, изменённая после чтения предпросмотра, — тоже «изменилось».
    const locked = picked.length
      ? await tx.$queryRaw<{ id: string; version: number; values: Values }[]>`
          SELECT id::text, version, "values" FROM register_records WHERE id = ANY(${picked.map((i) => i.recordId)}::uuid[]) FOR UPDATE`
      : [];
    const cur = new Map(locked.map((r) => [r.id, r]));
    if (picked.some((i) => cur.get(i.recordId)?.version !== i.version)) throw changed();

    const after = picked.map((i) => {
      const before = (cur.get(i.recordId) as { values: Values }).values;
      const values: Values = { ...before, [R('employee').id]: [i.employee.id], [R('match').id]: exact };
      if (i.deptTo) values[R('dept').id] = i.deptTo;
      return { i, before, values };
    });
    const users = await loadUsers(tx, userIdsIn(res, after.map((a) => a.values)));
    const links = linkLabels(await loadLinkRefs(tx, linkIdsIn(res, after.flatMap((a) => [a.before, a.values]))));
    const shown = (f: FieldMeta, v: Values[string] | undefined) => displayValue(f, v, { users, links });
    for (const { i, before, values } of after) {
      await tx.registerRecord.update({
        where: { id: i.recordId },
        data: { values: values as Prisma.InputJsonValue, searchText: searchTextOf(res, i.number, values, users, links), version: { increment: 1 } },
      });
      const changes = ['employee', 'match', 'dept'].map(R).filter((f) => !sameValue(before[f.id], values[f.id]))
        .map((f) => ({ fieldId: f.id, label: f.label, from: shown(f, before[f.id]), to: shown(f, values[f.id]) }));
      await auditSettings(tx, actor, {
        action: 'register_record.updated', entity: 'register_record', entityId: i.recordId,
        summary: `«${res.name}», запись #${i.number}: «Обновить по сотрудникам» — ${i.employee.fio}`,
        after: { changes, via: 'awareness_refresh' },
      });
    }
    await auditSettings(tx, actor, {
      action: 'awareness.refresh.applied', entity: 'register', entityId: res.id,
      summary: `«${res.name}»: «Обновить по сотрудникам» — сопоставлено ${picked.length} из ${p.total}`,
      after: { matched: picked.length, offered: p.total, recordIds: picked.map((i) => i.recordId) },
    });
    return { updated: picked.length, skipped: p.total - picked.length };
  });
}
