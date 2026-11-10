// Справочник «Ответственные лица» для этапа согласования документов (релиз 1.6.7).
// Хранится в app_settings (ключ documents.partyDirectory) — схема БД не меняется, миграций нет: нет строки — справочник пуст.
// В документ ФИО и должность копируются текстом (document_parties), ссылка на запись справочника не хранится:
// правка и отключение записи уже добавленных лиц не меняют. Физического удаления нет — только отключение (CLAUDE.md, 3.4).
// Ведёт settings.manage; каждое изменение — в audit_log. Данных банка в seed и тестах нет.
// Почта (1.13.6) — отдельным ключом documents.partyDirectoryEmails ({ emails: { id: почта } }): значение основного ключа
// проверяется strictObject, и лишнее поле в записи backend 1.13.5 после отката счёл бы повреждением справочника.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import { withTx, type Db } from '../../lib/db.js';
import { cleanEmail, EMAIL_MAX } from '../../lib/email.js';
import { AppError, badRequest, conflict, notFound, versionConflict } from '../../lib/errors.js';
import { normalizePersonText } from '../../lib/person-key.js';
import { accessOf, getDocument } from '../documents/service.js';
import { auditSettings, trimmed, type Actor } from '../settings/common.js';

export const PARTY_DIRECTORY_KEY = 'documents.partyDirectory';
/** Почты записей справочника (1.13.6): id записи → почта; пустой почты в значении нет. */
export const PARTY_DIRECTORY_EMAILS_KEY = 'documents.partyDirectoryEmails';
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
export const DirectoryEmailsSchema = z.strictObject({ emails: z.record(z.string().uuid(), z.string().min(3).max(EMAIL_MAX)) });
type StoredItem = z.infer<typeof ItemSchema>;
/** Запись справочника с почтой (почта — из второго ключа; нет — ''). */
export type DirectoryItem = StoredItem & { email: string };

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
  const emails = await readEmails(db);
  return parsed.data.items.map((i) => ({ ...i, email: emails[i.id] ?? '' }));
}

async function readEmails(db: Db): Promise<Record<string, string>> {
  const row = await db.appSetting.findUnique({ where: { key: PARTY_DIRECTORY_EMAILS_KEY } });
  if (!row) return {};
  const parsed = DirectoryEmailsSchema.safeParse(row.value);
  if (!parsed.success) throw new AppError(500, 'PARTY_DIRECTORY_INVALID', 'Почты справочника «Ответственные лица» повреждены: запустите check-integrity');
  return parsed.data.emails;
}

/** Изменение справочника: под блокировкой ключа (одновременные правки не теряются), запись одной транзакцией с журналом. */
async function mutate<T>(db: Db, fn: (tx: Db, items: DirectoryItem[]) => Promise<{ items: DirectoryItem[]; out: T }>): Promise<T> {
  return withTx(db, async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${PARTY_DIRECTORY_KEY}))::text`;
    const { items, out } = await fn(tx, await readDirectory(tx));
    // Основной ключ — в прежнем формате (без почты), почты — вторым ключом.
    const stored: StoredItem[] = items.map(({ email: _email, ...rest }) => rest);
    const value = { items: stored } as unknown as Prisma.InputJsonValue;
    await tx.appSetting.upsert({ where: { key: PARTY_DIRECTORY_KEY }, create: { key: PARTY_DIRECTORY_KEY, value }, update: { value, version: { increment: 1 } } });
    const emails = Object.fromEntries(items.filter((i) => i.email).map((i) => [i.id, i.email]));
    const prev = await readEmails(tx);
    if (JSON.stringify(prev) !== JSON.stringify(emails)) {
      const ev = { emails } as unknown as Prisma.InputJsonValue;
      await tx.appSetting.upsert({ where: { key: PARTY_DIRECTORY_EMAILS_KEY }, create: { key: PARTY_DIRECTORY_EMAILS_KEY, value: ev }, update: { value: ev, version: { increment: 1 } } });
    }
    return out;
  });
}

const label = (i: { fullName: string; position: string }) => `«${i.fullName}»${i.position ? ` (${i.position})` : ''}`;
const snapshot = (i: DirectoryItem) => ({ fullName: i.fullName, position: i.position, email: i.email, active: i.active });
/** Записи с той же почтой (кроме exceptId): предупреждение, не запрет. */
const sameEmailOf = (items: DirectoryItem[], email: string, exceptId?: string) =>
  email ? items.filter((i) => i.id !== exceptId && i.email === email).sort(byName) : [];

/** Весь справочник для «Настройки → Ответственные лица», включая отключённых; по ФИО. */
export async function listDirectory(db: Db): Promise<DirectoryItem[]> {
  return [...(await readDirectory(db))].sort(byName);
}

export interface NewPerson {
  fullName: string;
  position?: string;
  /** Почта (1.13.6), необязательна. */
  email?: string;
}

/**
 * Добавить. Такое же ФИО — не запрет (однофамильцы), а предупреждение: sameName — записи с тем же ФИО;
 * так же с почтой (1.13.6): sameEmail — записи с той же почтой.
 */
export async function createPerson(db: Db, actor: Actor, input: NewPerson) {
  const fullName = cleanText(input.fullName, PERSON_NAME_MAX, 'ФИО', true);
  const position = cleanText(input.position, PERSON_POSITION_MAX, 'подразделение или должность');
  const email = cleanEmail(input.email);
  return mutate(db, async (tx, items) => {
    if (items.length >= DIRECTORY_MAX) throw conflict('DIRECTORY_FULL', `В справочнике не больше ${DIRECTORY_MAX} записей. Отключённые тоже считаются`);
    const name = normalizePersonText(fullName);
    const sameName = items.filter((i) => normalizePersonText(i.fullName) === name).sort(byName);
    const now = new Date().toISOString();
    const sameEmail = sameEmailOf(items, email);
    const item: DirectoryItem = { id: randomUUID(), fullName, position, email, active: true, version: 1, createdAt: now, updatedAt: now };
    await auditSettings(tx, actor, {
      action: 'party_directory.created', entity: 'party_directory', entityId: item.id,
      summary: `Ответственные лица: добавлен(а) ${label(item)}`, after: snapshot(item),
    });
    return { items: [...items, item], out: { item, sameName, sameEmail } };
  });
}

export interface PersonPatch {
  version: number;
  fullName?: string;
  position?: string;
  /** '' — снять почту. */
  email?: string;
  active?: boolean;
}

/** Изменить ФИО и должность, отключить или включить. Уже добавленных в документы лиц это не меняет. */
export async function updatePerson(db: Db, actor: Actor, itemId: string, input: PersonPatch) {
  const fullName = input.fullName === undefined ? undefined : cleanText(input.fullName, PERSON_NAME_MAX, 'ФИО', true);
  const position = input.position === undefined ? undefined : cleanText(input.position, PERSON_POSITION_MAX, 'подразделение или должность');
  const email = input.email === undefined ? undefined : cleanEmail(input.email);
  return mutate(db, async (tx, items) => {
    const idx = items.findIndex((i) => i.id === itemId);
    const cur = items[idx];
    if (!cur) throw notFound('Запись справочника');
    if (cur.version !== input.version) throw versionConflict();
    const next: DirectoryItem = {
      ...cur,
      ...(fullName !== undefined ? { fullName } : {}),
      ...(position !== undefined ? { position } : {}),
      ...(email !== undefined ? { email } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    };
    const textChanged = next.fullName !== cur.fullName || next.position !== cur.position || next.email !== cur.email;
    const activeChanged = next.active !== cur.active;
    if (!textChanged && !activeChanged) return { items, out: { item: cur, sameEmail: [] as DirectoryItem[] } };
    const saved: DirectoryItem = { ...next, version: cur.version + 1, updatedAt: new Date().toISOString() };
    const action = textChanged ? 'party_directory.updated' : saved.active ? 'party_directory.enabled' : 'party_directory.disabled';
    const mail = next.email !== cur.email ? `, почта ${cur.email || '—'} → ${saved.email || '—'}` : '';
    const what = textChanged
      ? `изменено ${label(cur)} → ${label(saved)}${mail}${activeChanged ? (saved.active ? ', включено' : ', отключено') : ''}`
      : `${saved.active ? 'включено' : 'отключено'} ${label(saved)}`;
    await auditSettings(tx, actor, {
      action, entity: 'party_directory', entityId: itemId, summary: `Ответственные лица: ${what}`,
      before: snapshot(cur), after: snapshot(saved),
    });
    const out = [...items];
    out[idx] = saved;
    return { items: out, out: { item: saved, sameEmail: email ? sameEmailOf(items, saved.email, itemId) : [] } };
  });
}

/**
 * Активные записи для выбора в карточке документа: тот же круг, что ведёт ответственных лиц этого документа
 * (автор или начальник ИБ, этапы 11–14) — проверка та же, что у кнопки «Добавить ответственное лицо» (can.parties).
 */
export async function directoryForDocument(db: Db, userId: string, documentId: string): Promise<DirectoryItem[]> {
  const doc = await getDocument(db, await accessOf(db, userId), documentId);
  if (!doc.can.parties) throw new AppError(403, 'FORBIDDEN', 'Список ответственных лиц доступен тому, кто ведёт лиц этого документа: автору в драфте и на этапе «Согласование»');
  return (await readDirectory(db)).filter((i) => i.active).sort(byName);
}
