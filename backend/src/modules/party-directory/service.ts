// Справочник «Ответственные лица» для этапа согласования документов (релиз 1.6.7).
// Хранится в app_settings (ключ documents.partyDirectory) — схема БД не меняется, миграций нет: нет строки — справочник пуст.
// В документ ФИО и должность копируются текстом (document_parties), ссылка на запись справочника не хранится:
// правка и отключение записи уже добавленных лиц не меняют. Физического удаления нет — только отключение (CLAUDE.md, 3.4).
// Ведёт settings.manage; каждое изменение — в audit_log. Данных банка в seed и тестах нет.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import { withTx, type Db } from '../../lib/db.js';
import { AppError, badRequest, conflict, notFound, versionConflict } from '../../lib/errors.js';
import { normalizePersonText } from '../../lib/person-key.js';
import { accessOf, getDocument } from '../documents/service.js';
import { auditSettings, trimmed, type Actor } from '../settings/common.js';

export const PARTY_DIRECTORY_KEY = 'documents.partyDirectory';
/** Совпадает с document_parties: ФИО и «Подразделение или должность» копируются в документ без обрезки. */
export const PERSON_NAME_MAX = 300;
export const PERSON_POSITION_MAX = 300;
export const DIRECTORY_MAX = 2000;

const ItemSchema = z.strictObject({
  id: z.string().uuid(),
  fullName: z.string().min(1).max(PERSON_NAME_MAX),
  position: z.string().max(PERSON_POSITION_MAX),
  active: z.boolean(),
  version: z.number().int().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
/** Значение ключа app_settings; проверяется при чтении и в check-integrity. */
export const DirectorySchema = z.strictObject({ items: z.array(ItemSchema).max(DIRECTORY_MAX) });
export type DirectoryItem = z.infer<typeof ItemSchema>;

const byName = (a: DirectoryItem, b: DirectoryItem) => a.fullName.localeCompare(b.fullName, 'ru') || a.position.localeCompare(b.position, 'ru');

function cleanText(v: string | undefined, max: number, what: string, required = false): string {
  const t = trimmed(v ?? '');
  if (required && !t) throw badRequest('EMPTY', `Укажите ${what}`);
  if (t.length > max) throw badRequest('TOO_LONG', `${what[0]?.toUpperCase() ?? ''}${what.slice(1)} — не длиннее ${max} символов`);
  return t;
}

/** Справочник из app_settings. Испорченное значение — ошибка, а не молчаливо пустой список: иначе записи «пропадут». */
export async function readDirectory(db: Db): Promise<DirectoryItem[]> {
  const row = await db.appSetting.findUnique({ where: { key: PARTY_DIRECTORY_KEY } });
  if (!row) return [];
  const parsed = DirectorySchema.safeParse(row.value);
  if (!parsed.success) throw new AppError(500, 'PARTY_DIRECTORY_INVALID', 'Справочник «Ответственные лица» повреждён: запустите check-integrity');
  return parsed.data.items;
}

/** Изменение справочника: под блокировкой ключа (одновременные правки не теряются), запись одной транзакцией с журналом. */
async function mutate<T>(db: Db, fn: (tx: Db, items: DirectoryItem[]) => Promise<{ items: DirectoryItem[]; out: T }>): Promise<T> {
  return withTx(db, async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${PARTY_DIRECTORY_KEY}))::text`;
    const { items, out } = await fn(tx, await readDirectory(tx));
    const value = { items } as unknown as Prisma.InputJsonValue;
    await tx.appSetting.upsert({ where: { key: PARTY_DIRECTORY_KEY }, create: { key: PARTY_DIRECTORY_KEY, value }, update: { value, version: { increment: 1 } } });
    return out;
  });
}

const label = (i: { fullName: string; position: string }) => `«${i.fullName}»${i.position ? ` (${i.position})` : ''}`;
const snapshot = (i: DirectoryItem) => ({ fullName: i.fullName, position: i.position, active: i.active });

/** Весь справочник для «Настройки → Ответственные лица», включая отключённых; по ФИО. */
export async function listDirectory(db: Db): Promise<DirectoryItem[]> {
  return [...(await readDirectory(db))].sort(byName);
}

export interface NewPerson {
  fullName: string;
  position?: string;
}

/** Добавить. Такое же ФИО — не запрет (однофамильцы), а предупреждение: sameName — записи с тем же ФИО. */
export async function createPerson(db: Db, actor: Actor, input: NewPerson) {
  const fullName = cleanText(input.fullName, PERSON_NAME_MAX, 'ФИО', true);
  const position = cleanText(input.position, PERSON_POSITION_MAX, 'подразделение или должность');
  return mutate(db, async (tx, items) => {
    if (items.length >= DIRECTORY_MAX) throw conflict('DIRECTORY_FULL', `В справочнике не больше ${DIRECTORY_MAX} записей. Отключённые тоже считаются`);
    const name = normalizePersonText(fullName);
    const sameName = items.filter((i) => normalizePersonText(i.fullName) === name).sort(byName);
    const now = new Date().toISOString();
    const item: DirectoryItem = { id: randomUUID(), fullName, position, active: true, version: 1, createdAt: now, updatedAt: now };
    await auditSettings(tx, actor, {
      action: 'party_directory.created', entity: 'party_directory', entityId: item.id,
      summary: `Ответственные лица: добавлен(а) ${label(item)}`, after: snapshot(item),
    });
    return { items: [...items, item], out: { item, sameName } };
  });
}

export interface PersonPatch {
  version: number;
  fullName?: string;
  position?: string;
  active?: boolean;
}

/** Изменить ФИО и должность, отключить или включить. Уже добавленных в документы лиц это не меняет. */
export async function updatePerson(db: Db, actor: Actor, itemId: string, input: PersonPatch) {
  const fullName = input.fullName === undefined ? undefined : cleanText(input.fullName, PERSON_NAME_MAX, 'ФИО', true);
  const position = input.position === undefined ? undefined : cleanText(input.position, PERSON_POSITION_MAX, 'подразделение или должность');
  return mutate(db, async (tx, items) => {
    const idx = items.findIndex((i) => i.id === itemId);
    const cur = items[idx];
    if (!cur) throw notFound('Запись справочника');
    if (cur.version !== input.version) throw versionConflict();
    const next: DirectoryItem = {
      ...cur,
      ...(fullName !== undefined ? { fullName } : {}),
      ...(position !== undefined ? { position } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    };
    const textChanged = next.fullName !== cur.fullName || next.position !== cur.position;
    const activeChanged = next.active !== cur.active;
    if (!textChanged && !activeChanged) return { items, out: { item: cur } };
    const saved: DirectoryItem = { ...next, version: cur.version + 1, updatedAt: new Date().toISOString() };
    const action = textChanged ? 'party_directory.updated' : saved.active ? 'party_directory.enabled' : 'party_directory.disabled';
    const what = textChanged
      ? `изменено ${label(cur)} → ${label(saved)}${activeChanged ? (saved.active ? ', включено' : ', отключено') : ''}`
      : `${saved.active ? 'включено' : 'отключено'} ${label(saved)}`;
    await auditSettings(tx, actor, {
      action, entity: 'party_directory', entityId: itemId, summary: `Ответственные лица: ${what}`,
      before: snapshot(cur), after: snapshot(saved),
    });
    const out = [...items];
    out[idx] = saved;
    return { items: out, out: { item: saved } };
  });
}

/**
 * Активные записи для выбора в карточке документа: тот же круг, что ведёт ответственных лиц этого документа
 * (автор или начальник ИБ, этапы 11–14) — проверка та же, что у кнопки «Добавить ответственное лицо» (can.parties).
 */
export async function directoryForDocument(db: Db, userId: string, documentId: string): Promise<DirectoryItem[]> {
  const doc = await getDocument(db, await accessOf(db, userId), documentId);
  if (!doc.can.parties) throw new AppError(403, 'FORBIDDEN', 'Список ответственных лиц доступен тем, кто ведёт лиц этого документа: автору и начальнику ИБ на этапах 11–14');
  return (await readDirectory(db)).filter((i) => i.active).sort(byName);
}
