// Выгрузка для проверки (этап 8б, ADR-0013): записи реестра за период по полю-дате (с архивными) в Excel
// и все файлы полей «Файл» этих записей одним zip. Имена файлов — «<№ документа>_<хосты>.<расш.>» (lib/zip-names.ts);
// лист «Файлы» книги — опись архива с sha256 для сверки. Выгрузка пишется в журнал аудита.
import archiver, { type Archiver } from 'archiver';
import type { Db } from '../../lib/db.js';
import { badRequest } from '../../lib/errors.js';
import type { FileStore } from '../../lib/file-store.js';
import type { Values } from '../../lib/register-values.js';
import { extOf, zipNames } from '../../lib/zip-names.js';
import { auditSettings, type Actor } from '../settings/common.js';
import { loadRegister } from './definition.js';
import { exportRegister, exportRows } from './excel.service.js';
import { loadLinkRefs } from './links.js';

export interface ZipExportInput {
  dateFieldId: string;
  from?: string;
  to?: string;
  /** Текстовое поле номера документа для имён файлов; по умолчанию — поле «№ …», иначе заголовок записи. */
  nameFieldId?: string;
  /** Поле «Связь с записью» с хостами; по умолчанию — первое такое поле. */
  linkFieldId?: string;
}

export async function exportZip(db: Db, store: FileStore, actor: Actor, registerId: string, input: ZipExportInput): Promise<{ fileName: string; archive: Archiver }> {
  const reg = await loadRegister(db, registerId);
  const dateField = reg.fields.find((f) => f.id === input.dateFieldId);
  if (!dateField || dateField.type !== 'date') throw badRequest('BAD_FILTER', 'Период — по полю-дате реестра');
  if (input.from && input.to && input.from > input.to) throw badRequest('BAD_FILTER', 'Начало периода позже конца');
  // По умолчанию — текстовое поле «№ …» (номер документа), иначе заголовок записи.
  const nameField = input.nameFieldId
    ? reg.fields.find((f) => f.id === input.nameFieldId && f.type === 'text')
    : reg.fields.find((f) => !f.archived && f.type === 'text' && f.label.trim().startsWith('№')) ?? reg.fields.find((f) => f.isTitle);
  if (input.nameFieldId && !nameField) throw badRequest('BAD_FIELD', 'Номер документа — текстовое поле реестра');
  const linkField = input.linkFieldId ? reg.fields.find((f) => f.id === input.linkFieldId && f.type === 'link') : reg.fields.find((f) => f.type === 'link' && !f.archived);
  if (input.linkFieldId && !linkField) throw badRequest('BAD_FIELD', 'Хосты — поле «Связь с записью» реестра');
  const fileFields = reg.fields.filter((f) => f.type === 'file');
  if (!fileFields.length) throw badRequest('NO_FILE_FIELDS', 'В реестре нет поля «Файл» — выгрузите только Excel');

  const opts = { filter: { date: { fieldId: dateField.id, from: input.from, to: input.to } }, includeArchived: true };
  const rows = await exportRows(db, reg, opts);
  const links = await db.registerRecordFile.findMany({
    where: { recordId: { in: rows.map((r) => r.id) }, fieldId: { in: fileFields.map((f) => f.id) }, removedAt: null },
    include: { file: true, field: { select: { label: true } } },
    orderBy: [{ addedAt: 'asc' }, { id: 'asc' }],
  });
  const byRecord = new Map(rows.map((r) => [r.id, r]));
  const ordered = [...links].sort((a, b) => (byRecord.get(a.recordId)?.number ?? 0) - (byRecord.get(b.recordId)?.number ?? 0));
  const hostIds = linkField ? rows.flatMap((r) => ((r.values as Values)[linkField.id] as string[] | undefined) ?? []) : [];
  const hosts = await loadLinkRefs(db, hostIds);
  const names = zipNames(ordered.map((l) => {
    const values = (byRecord.get(l.recordId)?.values ?? {}) as Values;
    const doc = nameField ? values[nameField.id] : undefined;
    const ids = linkField && Array.isArray(values[linkField.id]) ? (values[linkField.id] as string[]) : [];
    return {
      docNumber: typeof doc === 'string' ? doc : `запись ${byRecord.get(l.recordId)?.number ?? ''}`,
      hosts: ids.map((id) => hosts.get(id)?.title || `#${hosts.get(id)?.number ?? '?'}`),
      ext: extOf(l.file.mime, l.file.originalName),
    };
  }));

  const period = `${input.from ?? 'начало'} — ${input.to ?? 'сегодня'}`;
  const { buffer } = await exportRegister(db, registerId, {
    ...opts,
    extra: (wb) => {
      const ws = wb.addWorksheet('Файлы');
      ws.columns = [
        { header: 'ID записи', width: 10 }, { header: 'Поле', width: 22 }, { header: 'Имя в архиве', width: 48 },
        { header: 'Исходное имя', width: 40 }, { header: 'sha256', width: 68 }, { header: 'Загружен', width: 20 }, { header: 'Размер, Б', width: 12 },
      ];
      ws.getRow(1).font = { bold: true };
      ordered.forEach((l, i) => ws.addRow([
        byRecord.get(l.recordId)?.number, l.field.label, `files/${names[i]}`, l.file.originalName, l.file.sha256,
        l.file.uploadedAt.toISOString().replace('T', ' ').slice(0, 19), Number(l.file.size),
      ]));
    },
  });

  await auditSettings(db, actor, {
    action: 'register.exported_zip', entity: 'register', entityId: reg.id,
    summary: `«${reg.name}»: выгрузка для проверки за ${period} по «${dateField.label}» — записей ${rows.length}, файлов ${ordered.length}`,
    after: { dateFieldId: dateField.id, from: input.from ?? null, to: input.to ?? null, records: rows.length, files: ordered.length },
  });

  const archive = archiver('zip', { zlib: { level: 6 } });
  const stamp = new Date().toISOString().slice(0, 10);
  archive.append(buffer, { name: `${reg.name} ${input.from ?? ''}_${input.to ?? stamp}.xlsx`.replace(/[\\/:*?"<>|]/g, '-') });
  ordered.forEach((l, i) => archive.append(store.open(l.file.storageKey), { name: `files/${names[i]}`, date: l.file.uploadedAt }));
  void archive.finalize();
  return { fileName: `${reg.name} — выгрузка для проверки ${stamp}.zip`, archive };
}
