// Реестр утверждённых документов в Excel (1.11.0, план — раздел 4): те же фильтры, что у подменю «Утверждённые»,
// стиль — как у отчёта по задачам (заголовок жирным, первая строка закреплена, лист «Параметры»). Выгрузка — в журнал.
import ExcelJS from 'exceljs';
import type { Db } from '../../lib/db.js';
import { todayIso } from '../../lib/today.js';
import type { Actor } from '../settings/common.js';
import { listDocuments, LIST_LIMIT, type DocAccess, type DocListQuery } from './service.js';

const fmt = (iso: string | null) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '');
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export type ApprovedFilter = Pick<DocListQuery, 'typeId' | 'ownerId' | 'due' | 'dueTo' | 'q' | 'onReview' | 'sort'>;

/** Строки реестра утверждённых — те же, что видит пользователь в подменю «Утверждённые» (права — listDocuments). */
export async function approvedRows(db: Db, a: DocAccess, f: ApprovedFilter, today = todayIso()) {
  const page = await listDocuments(db, a, { ...f, archived: false, view: 'approved', sort: f.sort ?? 'type', limit: LIST_LIMIT * 100 });
  return page.items.map((x) => ({
    number: x.number,
    title: x.title,
    type: x.type.value,
    owner: x.owner.fullName,
    version: x.approvedEdition ? `${x.approvedVersionNo} · ред. ${x.approvedEdition}` : String(x.approvedVersionNo ?? ''),
    approvedOn: x.signedOn ?? x.approvedAt?.slice(0, 10) ?? null,
    orderNo: x.approvedOrderNo,
    reviewDue: x.reviewDue,
    /** Дней до пересмотра; отрицательное — просрочен на столько дней. */
    daysLeft: x.reviewDue ? daysBetween(today, x.reviewDue) : null,
    onReview: x.onReview,
  }));
}

export async function exportApproved(db: Db, actor: Actor, a: DocAccess, f: ApprovedFilter): Promise<{ fileName: string; buffer: Buffer }> {
  const today = todayIso();
  const rows = await approvedRows(db, a, f, today);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Утверждённые');
  ws.columns = [
    { header: '№', key: 'number', width: 8 },
    { header: 'Документ', key: 'title', width: 50 },
    { header: 'Тип', key: 'type', width: 18 },
    { header: 'Владелец', key: 'owner', width: 26 },
    { header: 'Действующая версия', key: 'version', width: 18 },
    { header: 'Утверждён', key: 'approvedOn', width: 12 },
    { header: 'Приказ', key: 'orderNo', width: 14 },
    { header: 'Пересмотр до', key: 'reviewDue', width: 14 },
    { header: 'Дней до пересмотра', key: 'daysLeft', width: 14 },
    { header: 'На пересмотре', key: 'onReview', width: 12 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const r of rows) {
    const row = ws.addRow({ ...r, approvedOn: fmt(r.approvedOn), reviewDue: fmt(r.reviewDue), daysLeft: r.daysLeft ?? '', onReview: r.onReview ? 'да' : '' });
    // Просроченный пересмотр — красным, как в реестре.
    if (r.daysLeft !== null && r.daysLeft < 0) row.getCell('daysLeft').font = { color: { argb: 'FFC00000' }, bold: true };
  }
  const info = wb.addWorksheet('Параметры');
  info.columns = [{ key: 'k', width: 22 }, { key: 'v', width: 60 }];
  for (const [k, v] of [
    ['Сформирован', fmt(today)],
    ['Поиск', f.q?.trim() || '—'],
    ['Только на пересмотре', f.onReview ? 'да' : 'нет'],
    ['Срок пересмотра', f.due ?? (f.dueTo ? `до ${fmt(f.dueTo)}` : 'любой')],
    ['Документов', String(rows.length)],
  ] as const) info.addRow({ k, v });
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  await db.auditLog.create({
    data: {
      userId: actor.id, action: 'documents.approved_exported', entity: 'document', entityId: 'approved', ip: actor.ip,
      diff: { summary: `Реестр утверждённых документов выгружен в Excel: ${rows.length}`, actorRoles: [...actor.roleNames], filter: { ...f }, rows: rows.length },
    },
  });
  return { fileName: `Утверждённые документы ${today}.xlsx`, buffer };
}
