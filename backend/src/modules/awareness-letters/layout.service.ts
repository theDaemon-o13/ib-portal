// «Оформление писем» (1.12.0, ADR-0044; docs/specs/awareness.md, раздел 22): одна строка awareness_layout. Читают все
// с ib.work (предпросмотр, выгрузка), меняют settings.manage + ib.work (как «Подпись ИБ»). Логотип — PNG до 100 КБ
// через files: тип проверен при загрузке по содержимому, здесь — ещё раз MIME, размер и заголовок PNG.
import type { Readable } from 'node:stream';
import { withTx, type Db } from '../../lib/db.js';
import { badRequest, versionConflict } from '../../lib/errors.js';
import type { FileStore } from '../../lib/file-store.js';
import { claimFiles, deleteIfUnreferenced } from '../files/links.js';
import { auditSettings, type Actor } from '../settings/common.js';
import { LAYOUT_PLACEHOLDER } from './definition.js';
import { logoOf, pngSize, type MailLogo } from './export/layout.js';
import type { LayoutSettings } from './export/mail.js';

export const LOGO_MAX_BYTES = 100 * 1024;
export const LAYOUT_TEXT_MAX = 200;
export const LAYOUT_FOOTER_MAX = 1000;

const TEXT_KEYS = [
  'deptRu', 'deptTj', 'email', 'closingRu', 'closingTj', 'footerRu', 'footerTj',
  'labelUrgentRu', 'labelUrgentTj', 'labelPlannedRu', 'labelPlannedTj', 'tjHint',
] as const satisfies readonly (keyof LayoutSettings)[];

const LABELS: Record<keyof LayoutSettings, string> = {
  deptRu: 'Название отдела RU', deptTj: 'Название отдела TJ', email: 'Адрес ИБ', closingRu: 'Прощание RU', closingTj: 'Прощание TJ',
  footerRu: 'Подвал RU', footerTj: 'Подвал TJ', labelUrgentRu: 'Метка срочного RU', labelUrgentTj: 'Метка срочного TJ',
  labelPlannedRu: 'Метка планового RU', labelPlannedTj: 'Метка планового TJ', tjHint: 'Подсказка о таджикском тексте',
};
const REQUIRED = new Set<keyof LayoutSettings>(['deptRu', 'deptTj', 'closingRu', 'closingTj']);
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

const pick = (row: LayoutSettings): LayoutSettings => Object.fromEntries(TEXT_KEYS.map((k) => [k, row[k]])) as unknown as LayoutSettings;

/** Настройки для макета; строки нет (seed ещё не выполнен) — заглушки. */
export async function readLayout(db: Db): Promise<LayoutSettings> {
  const row = await db.awarenessLayout.findUnique({ where: { id: 1 } });
  return row ? pick(row) : { ...LAYOUT_PLACEHOLDER };
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks);
}

/** Логотип для шапки (data: PNG, ширина 238): нет логотипа или файла на диске — null, шапка с названием отдела. */
export async function readLogo(db: Db, store: FileStore | undefined): Promise<MailLogo | null> {
  const row = await db.awarenessLayout.findUnique({ where: { id: 1 }, select: { logo: { select: { storageKey: true, mime: true, deletedAt: true } } } });
  if (!store || !row?.logo || row.logo.deletedAt || row.logo.mime !== 'image/png') return null;
  try {
    return logoOf(await readAll(store.open(row.logo.storageKey)));
  } catch {
    return null;
  }
}

export async function getLayout(db: Db, perms: ReadonlySet<string>) {
  const row = await db.awarenessLayout.findUnique({
    where: { id: 1 },
    include: { logo: { select: { id: true, originalName: true, size: true, sha256: true } }, updater: { select: { id: true, fullName: true } } },
  });
  const base = row ? pick(row) : { ...LAYOUT_PLACEHOLDER };
  return {
    ...base,
    logo: row?.logo ? { id: row.logo.id, name: row.logo.originalName, size: Number(row.logo.size), sha256: row.logo.sha256 } : null,
    version: row?.version ?? 0,
    updatedBy: row?.updater ?? null,
    updatedAt: row && row.version > 1 ? row.updatedAt.toISOString() : null,
    canEdit: perms.has('settings.manage') && perms.has('ib.work'),
  };
}

export type LayoutInput = LayoutSettings & { version: number; logoFileId: string | null };

function cleanText(k: keyof LayoutSettings, raw: string): string {
  const multiline = k === 'footerRu' || k === 'footerTj';
  const v = multiline ? raw.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() : raw.replace(/\s+/g, ' ').trim();
  const max = multiline ? LAYOUT_FOOTER_MAX : LAYOUT_TEXT_MAX;
  if (v.length > max) throw badRequest('LAYOUT_TOO_LONG', `${LABELS[k]}: длиннее ${max} символов`);
  if (REQUIRED.has(k) && !v) throw badRequest('LAYOUT_REQUIRED', `Заполните «${LABELS[k]}»`);
  if (k === 'email' && v && !EMAIL_RE.test(v)) throw badRequest('BAD_EMAIL', 'Адрес ИБ: укажите адрес вида name@example.org');
  return v;
}

/** Сохранить «Оформление писем»: version (0 — строки ещё нет), журнал с изменёнными полями. */
export async function updateLayout(db: Db, actor: Actor, input: LayoutInput) {
  const values = Object.fromEntries(TEXT_KEYS.map((k) => [k, cleanText(k, input[k] ?? '')])) as unknown as LayoutSettings;
  return withTx(db, async (tx) => {
    const row = await tx.awarenessLayout.findUnique({ where: { id: 1 } });
    if ((row?.version ?? 0) !== input.version) throw versionConflict();
    let logoFileId = row?.logoFileId ?? null;
    if (input.logoFileId !== logoFileId) {
      if (input.logoFileId) {
        const [f] = await claimFiles(tx, actor.id, [input.logoFileId], { mimes: ['image/png'], what: 'логотип' });
        if (!f) throw badRequest('BAD_LOGO', 'Логотип не найден. Загрузите файл заново');
        if (Number(f.size) > LOGO_MAX_BYTES) throw badRequest('LOGO_TOO_LARGE', `Логотип ${Math.ceil(Number(f.size) / 1024)} КБ — больше 100 КБ. Уменьшите его`);
      }
      logoFileId = input.logoFileId;
    }
    const changed = TEXT_KEYS.filter((k) => !row || row[k] !== values[k]).map((k) => LABELS[k]);
    if ((row?.logoFileId ?? null) !== logoFileId) changed.push(logoFileId ? 'Логотип' : 'Логотип убран');
    const data = { ...values, logoFileId, updatedBy: actor.id };
    if (row) await tx.awarenessLayout.update({ where: { id: 1 }, data: { ...data, version: { increment: 1 } } });
    else await tx.awarenessLayout.create({ data: { id: 1, ...data, version: 1 } });
    // Прежний логотип без других ссылок — помечается удалённым (содержимое на диске остаётся).
    if (row?.logoFileId && row.logoFileId !== logoFileId) await deleteIfUnreferenced(tx, actor, row.logoFileId, 'логотип «Оформления писем» заменён');
    await auditSettings(tx, actor, {
      action: 'awareness_layout.updated', entity: 'awareness_layout', entityId: '1',
      summary: `«Оформление писем»: ${changed.length ? changed.join(', ') : 'без изменений'}`,
      after: { ...values, logoFileId },
    });
  });
}

/** Проверка PNG логотипа по содержимому (размеры для макета). */
export function checkLogoPng(buf: Buffer): void {
  if (!pngSize(buf)) throw badRequest('BAD_LOGO', 'Логотип — только PNG');
}
