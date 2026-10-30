// Этап 8б с настоящей БД: стартовые реестры «Устройства DLP» и «Разрешения на доступ», фиксация полей статусом
// (сервис 422 и триггер), причина изменения связи, «не позже 31.12», статус основания по связи, автоматизации,
// текст PDF и глобальный поиск, выгрузка zip. Хранилище — временный каталог; БД — транзакция с откатом.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import ExcelJS from 'exceljs';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { argon2Hasher } from '../../lib/passwords.js';
import { TEST_PORTAL_URL, TEST_SECRET } from '../../test/helpers.js';
import { prismaAuditWriter } from '../audit/audit.js';
import { prismaAuthRepository } from '../auth/repository.prisma.js';
import { diskFileStore } from '../../lib/file-store.js';
import type { Values } from '../../lib/register-values.js';
import { actorFor, expectCode, inTx, makeUser, must, type Tx } from '../../test/db.js';
import { scanPdf, textPdf, tinyJpg } from '../../test/files-fixture.js';
import { runAutomations } from '../automations/service.js';
import { uploadFile } from '../files/service.js';
import { processPendingTexts } from '../files/text.js';
import { search } from '../search/service.js';
import type { Actor } from '../settings/common.js';
import { loadRegister, type RegisterDef } from './definition.js';
import * as excel from './excel.service.js';
import { exportZip } from './export-zip.js';
import * as files from './record-files.service.js';
import * as records from './records.service.js';
import * as structure from './structure.service.js';
import { makeRegister } from '../../test/registers-fixture.js';

/** Записи zip по центральному каталогу (archiver пишет размеры там); deflate или store. */
function readZip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let p = buf.readUInt32LE(eocd + 16);
  const n = buf.readUInt16LE(eocd + 10);
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

async function setup(tx: Tx) {
  const root = mkdtempSync(join(tmpdir(), 'ibportal-dlp-'));
  roots.push(root);
  const store = diskFileStore(root);
  const staff = await makeUser(tx, ['ib_staff'], { fullName: 'Сотрудник ИБ' });
  const actor = await actorFor(tx, staff.id);
  const regByName = async (name: string) => loadRegister(tx, must(await tx.register.findFirst({ where: { name, archivedAt: null } }), name).id);
  const dev = await regByName('Устройства DLP');
  const perm = await regByName('Разрешения на доступ');
  const field = (reg: RegisterDef, label: string) => must(reg.fields.find((f) => f.label === label), label);
  const opt = (reg: RegisterDef, label: string, option: string) => must(field(reg, label).options.find((o) => o.label === option), option).id;
  const P = (label: string) => field(perm, label).id;
  const D = (label: string) => field(dev, label).id;
  const device = (host: string, values: Record<string, unknown> = {}) => records.createRecord(tx, actor, dev.id, {
    values: { [D('Имя хоста')]: host, [D('Сотрудник')]: 'Иванов Иван', [D('Соцсети и мессенджеры')]: opt(dev, 'Соцсети и мессенджеры', 'Разрешён Telegram'), ...values },
  });
  const upload = (a: Actor, name: string, data: Buffer) => uploadFile(tx, store, a, name, data);
  /** Разрешение «Оформляется» с документом-основанием; active — сразу перевести в «Действует». */
  const permission = async (deviceIds: string[], opts: { docNo?: string; docDate?: string; until?: string; kind?: string; active?: boolean; file?: Buffer; fileName?: string } = {}) => {
    let rec = await records.createRecord(tx, actor, perm.id, {
      values: {
        [P('Сотрудник')]: 'Иванов Иван',
        [P('Вид')]: opt(perm, 'Вид', opts.kind ?? 'Соцсети и мессенджеры'),
        [P('Сервисы')]: 'Telegram',
        [P('Устройства')]: deviceIds,
        [P('№ документа')]: opts.docNo ?? '12/45-р',
        [P('Дата документа')]: opts.docDate ?? '2026-03-01',
        ...(opts.until ? { [P('Действует до')]: opts.until } : {}),
      },
    });
    const f = await upload(actor, opts.fileName ?? 'Разрешение.pdf', opts.file ?? textPdf(['Разрешение на Telegram']));
    rec = await files.attachFiles(tx, actor, rec.id, { fieldId: P('Документ-основание'), fileIds: [f.id], version: rec.version });
    if (opts.active !== false) rec = await records.updateRecord(tx, actor, rec.id, { version: rec.version, values: { [P('Статус')]: opt(perm, 'Статус', 'Действует') } });
    return rec;
  };
  return { store, staff, actor, dev, perm, P, D, opt, device, permission, upload };
}

describe('стартовые реестры DLP (seed)', () => {
  it('поля, фиксация, статус основания, правила, плитки, метка и правило почты выше «Доступа»', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      expect(s.perm.fields.find((f) => f.label === 'Устройства')).toMatchObject({ type: 'link', linkRegisterId: s.dev.id, settings: { lock: { mode: 'reason' } } });
      expect(s.perm.fields.find((f) => f.label === 'Документ-основание')).toMatchObject({ type: 'file', settings: { lock: { mode: 'locked' } } });
      expect(s.perm.fields.find((f) => f.label === 'Действует до')?.settings.date).toEqual({ notAfterYearEndOfFieldId: s.P('Дата документа'), defaultEndOfYear: true });
      expect(s.dev.fields.filter((f) => f.calcRule?.kind === 'link_basis').map((f) => f.label)).toEqual(['Основание: соцсети', 'Основание: облако']);
      expect(await tx.registerAutomation.count({ where: { registerId: { in: [s.dev.id, s.perm.id] } } })).toBe(5);
      expect((await tx.dashboardTile.findMany({ where: { registerId: { in: [s.dev.id, s.perm.id] } }, orderBy: { sortOrder: 'asc' } })).map((t) => t.title))
        .toEqual(['Доступ к соцсетям', 'Доступ к облаку', 'Доступ к USB', 'Действующие разрешения по видам', 'Ожидают настройки']);
      const rules = await tx.catalogItem.findMany({ where: { catalogCode: 'mail_rules', deletedAt: null }, orderBy: { sortOrder: 'asc' } });
      const order = rules.map((r) => r.value);
      expect(order.indexOf('Разрешения')).toBeLessThan(order.indexOf('Доступ'));
      expect(rules.find((r) => r.value === 'Разрешения')?.keywords).toContain('удалённ');
      expect(await tx.catalogItem.count({ where: { catalogCode: 'notify_recipients', value: 'Разрешения DLP' } })).toBe(1);
    }));
});

describe('фиксация полей статусом «Действует»', () => {
  it('документ нельзя заменить или отвязать, реквизиты не меняются, запись не удаляется — сервис 422', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const d = await s.device('WS-BUH-014');
      let rec = await s.permission([d.id]);
      expect(rec.locked[s.P('Документ-основание')]).toBe('locked');
      expect(rec.locked[s.P('Устройства')]).toBe('reason');
      const doc = must(rec.files[s.P('Документ-основание')]?.[0]);
      expect(doc.file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(doc.file.uploadedAt).toBeTruthy();

      await expectCode(files.detachFile(tx, s.actor, rec.id, doc.linkId, rec.version), 'FIELD_LOCKED');
      const other = await s.upload(s.actor, 'Другое.pdf', textPdf(['Другой документ основание']));
      await expectCode(files.attachFiles(tx, s.actor, rec.id, { fieldId: s.P('Документ-основание'), fileIds: [other.id], version: rec.version }), 'FIELD_LOCKED');
      for (const [label, v] of [['№ документа', '99'], ['Дата документа', '2026-04-01'], ['Действует до', '2026-06-30'], ['Сервисы', 'WhatsApp']] as const) {
        await expectCode(records.updateRecord(tx, s.actor, rec.id, { version: rec.version, values: { [s.P(label)]: v } }), 'FIELD_LOCKED');
      }
      await expectCode(records.updateRecord(tx, s.actor, rec.id, { version: rec.version, values: { [s.P('Статус')]: s.opt(s.perm, 'Статус', 'Оформляется') } }), 'STATUS_LOCKED');
      await expectCode(records.deleteRecord(tx, s.actor, rec.id, rec.version), 'RECORD_LOCKED');

      // Пустое зафиксированное поле заполнить можно; остальные поля — как обычно; статус — на другой фиксирующий.
      rec = await records.updateRecord(tx, s.actor, rec.id, { version: rec.version, values: { [s.P('Кто разрешил')]: 'Председатель правления', [s.P('Место хранения оригинала')]: 'Дело 7, папка 2' } });
      await expectCode(records.updateRecord(tx, s.actor, rec.id, { version: rec.version, values: { [s.P('Кто разрешил')]: 'Другой' } }), 'FIELD_LOCKED');
      rec = await records.updateRecord(tx, s.actor, rec.id, { version: rec.version, values: { [s.P('Статус')]: s.opt(s.perm, 'Статус', 'Отозвано') } });
      expect(rec.closed).toBe(true);
      // Отозванное разрешение тоже хранится навсегда: файл не удаляется, запись не удаляется.
      await expectCode(records.deleteRecord(tx, s.actor, rec.id, rec.version), 'RECORD_LOCKED');
      expect(await tx.file.findUnique({ where: { id: doc.file.id }, select: { deletedAt: true } })).toEqual({ deletedAt: null });
    }));

  it('триггер БД держит фиксацию и в обход сервиса', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const d = await s.device('WS-TRG-1');
      const rec = await s.permission([d.id]);
      const docNo = s.P('№ документа');
      await expect(tx.$executeRaw`UPDATE register_records SET "values" = jsonb_set("values", ARRAY[${docNo}], '"подмена"') WHERE id = ${rec.id}::uuid`)
        .rejects.toThrow(/зафиксировано статусом/);
    }));

  it('триггер: отвязать зафиксированный файл и удалить запись нельзя', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const d = await s.device('WS-TRG-2');
      const rec = await s.permission([d.id]);
      const link = must(rec.files[s.P('Документ-основание')]?.[0]);
      await expect(tx.$executeRaw`UPDATE register_record_files SET removed_at = now(), removed_by = ${s.staff.id}::uuid WHERE id = ${link.linkId}::uuid`)
        .rejects.toThrow(/зафиксирован статусом/);
    }));

  it('триггер: мягкое удаление действующего разрешения запрещено', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const d = await s.device('WS-TRG-3');
      const rec = await s.permission([d.id]);
      await expect(tx.$executeRaw`UPDATE register_records SET deleted_at = now() WHERE id = ${rec.id}::uuid`).rejects.toThrow(/не удаляется/);
    }));

  it('до «Действует» документ можно заменить: отвязка мягкая, в истории', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const d = await s.device('WS-DRAFT');
      let rec = await s.permission([d.id], { active: false });
      const link = must(rec.files[s.P('Документ-основание')]?.[0]);
      rec = await files.detachFile(tx, s.actor, rec.id, link.linkId, rec.version);
      expect(rec.files[s.P('Документ-основание')]).toEqual([]);
      expect(await tx.registerRecordFile.findUnique({ where: { id: link.linkId }, select: { removedBy: true } })).toEqual({ removedBy: s.staff.id });
      const history = await records.recordHistory(tx, rec.id);
      expect(history[0]?.summary).toMatch(/отвязан «Разрешение.pdf»/);
    }));
});

describe('«Устройства» действующего разрешения — только с причиной', () => {
  it('без причины 422; с причиной — в истории записи и журнале', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const a = await s.device('WS-A');
      const b = await s.device('WS-B');
      let rec = await s.permission([a.id]);
      await expectCode(records.updateRecord(tx, s.actor, rec.id, { version: rec.version, values: { [s.P('Устройства')]: [a.id, b.id] } }), 'REASON_REQUIRED');
      rec = await records.updateRecord(tx, s.actor, rec.id, { version: rec.version, values: { [s.P('Устройства')]: [a.id, b.id] }, reason: 'Замена ноутбука, заявка 1182' });
      expect(rec.links[s.P('Устройства')]?.map((l) => l.title)).toEqual(['WS-A', 'WS-B']);
      const [last] = await records.recordHistory(tx, rec.id);
      expect(last).toMatchObject({ reason: 'Замена ноутбука, заявка 1182', changes: [{ label: 'Устройства', from: '#' + a.number + ' WS-A', to: `#${a.number} WS-A; #${b.number} WS-B` }] });
      expect(last?.summary).toMatch(/причина: Замена ноутбука/);
    }));
});

describe('«Действует до»: не позже 31.12 года даты документа', () => {
  it('по умолчанию 31.12 года документа; позже — ошибка', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const d = await s.device('WS-DATE');
      const rec = await s.permission([d.id], { docDate: '2025-11-20', active: false });
      expect(rec.values[s.P('Действует до')]).toBe('2025-12-31');
      await expectCode(records.updateRecord(tx, s.actor, rec.id, { version: rec.version, values: { [s.P('Действует до')]: '2026-01-15' } }), 'INVALID_VALUES');
      // Сменили дату документа так, что срок вышел за её год, — тоже ошибка.
      const ok = await records.updateRecord(tx, s.actor, rec.id, { version: rec.version, values: { [s.P('Действует до')]: '2025-06-30' } });
      await expectCode(records.updateRecord(tx, s.actor, ok.id, { version: ok.version, values: { [s.P('Дата документа')]: '2024-12-01' } }), 'INVALID_VALUES');
    }));
});

describe('статус основания (сверка с DLP)', () => {
  it('одно разрешение на несколько хостов; по связи, а не по ФИО; истекло; канал закрыт', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const cloudOpen = { [s.D('Облачные хранилища')]: s.opt(s.dev, 'Облачные хранилища', 'Только чтение') };
      const a = await s.device('WS-MULTI-1', cloudOpen);
      const b = await s.device('WS-MULTI-2');
      const sameName = await s.device('WS-SAME-NAME'); // тот же сотрудник, но разрешение на него не выдано
      const closed = await s.device('WS-CLOSED', { [s.D('Соцсети и мессенджеры')]: s.opt(s.dev, 'Соцсети и мессенджеры', 'Запрещены') });
      const p = await s.permission([a.id, b.id], { until: '2099-12-31', docDate: '2099-01-10', docNo: '7-р' });
      const basis = async (id: string, label: string) => must((await records.getRecord(tx, id)).basis[s.D(label)]);
      for (const id of [a.id, b.id]) {
        expect(await basis(id, 'Основание: соцсети')).toMatchObject({ state: 'ok', permission: { id: p.id, docNumber: '7-р', until: '2099-12-31' }, text: 'есть основание — разрешение 7-р до 31.12.2099' });
      }
      expect((await basis(a.id, 'Основание: облако')).state).toBe('none'); // разрешение на соцсети, а не на облако
      expect((await basis(b.id, 'Основание: облако')).state).toBe('closed');
      expect((await basis(sameName.id, 'Основание: соцсети')).state).toBe('none');
      expect((await basis(closed.id, 'Основание: соцсети')).state).toBe('closed');

      // Фильтр списка и плитка-ссылка: «нет основания» по соцсетям — те же записи.
      const list = await records.listRecords(tx, s.dev.id, { limit: 50, filter: { state: 'open', field: { fieldId: s.D('Основание: соцсети'), values: ['none', 'expired'] } } });
      expect(list.items.map((r) => r.values[s.D('Имя хоста')])).toContain('WS-SAME-NAME');
      expect(list.items.map((r) => r.values[s.D('Имя хоста')])).not.toContain('WS-MULTI-1');

      // Отозвали — основания больше нет: «истекло» с последним разрешением.
      await records.updateRecord(tx, s.actor, p.id, { version: p.version, values: { [s.P('Статус')]: s.opt(s.perm, 'Статус', 'Отозвано') } });
      expect(await basis(a.id, 'Основание: соцсети')).toMatchObject({ state: 'expired', permission: { id: p.id } });
    }));
});

describe('автоматизации разрешений', () => {
  it('1 января «Действует» → «Истекло» с историей; 1 декабря — одна сводная задача; канал без основания — задача без дублей', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const d = await s.device('WS-AUTO');
      const lonely = await s.device('WS-NO-BASIS');
      const p = await s.permission([d.id], { docDate: '2026-02-01' }); // до 31.12.2026 по умолчанию

      // 1 декабря: сводная задача «Продление разрешений на 2027» со списком действующих.
      const dec = await runAutomations(tx, { now: new Date('2026-12-01T06:00:00Z'), registerId: s.perm.id });
      expect(dec.tasksCreated).toBe(1);
      const digest = must(await tx.task.findFirst({ where: { automation: { registerId: s.perm.id }, recordId: null } }));
      expect(digest.title).toBe('Продление разрешений на 2027');
      expect(digest.description).toContain(`#${p.number} Иванов Иван — Действует, до 31.12.2026`);
      expect((await runAutomations(tx, { now: new Date('2026-12-03T06:00:00Z'), registerId: s.perm.id })).tasksCreated).toBe(0);

      // 1 января — «Истекло», в истории записи от имени системы.
      await runAutomations(tx, { now: new Date('2027-01-01T06:00:00Z'), registerId: s.perm.id });
      const after = await records.getRecord(tx, p.id);
      expect(after.display[s.P('Статус')]).toBe('Истекло');
      const [h] = await records.recordHistory(tx, p.id);
      expect(h).toMatchObject({ actor: null, via: 'automation', changes: [{ label: 'Статус', from: 'Действует', to: 'Истекло' }] });

      // Канал открыт без основания: задача «Закрыть доступ…»; повторный прогон дублей не даёт.
      const r1 = await runAutomations(tx, { now: new Date('2027-01-02T06:00:00Z'), registerId: s.dev.id });
      const tasks = await tx.task.findMany({ where: { recordId: { in: [d.id, lonely.id] } } });
      // Порядок событий одного прогона не задан — сравниваем отсортированные заголовки.
      expect(tasks.map((t) => t.title).sort()).toEqual([
        expect.stringMatching(/^Закрыть доступ в Device Monitor или получить разрешение — #\d+ WS-AUTO$/),
        expect.stringMatching(/^Закрыть доступ в Device Monitor или получить разрешение — #\d+ WS-NO-BASIS$/),
      ]);
      expect(r1.tasksCreated).toBe(2);
      const r2 = await runAutomations(tx, { now: new Date('2027-01-03T06:00:00Z'), registerId: s.dev.id });
      expect([r2.created, r2.tasksCreated]).toEqual([0, 0]);
    }));

  it('за 14 дней до «Действует до» — только если срок раньше конца года', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const d = await s.device('WS-14');
      const early = await s.permission([d.id], { until: '2026-06-30', docNo: 'early' });
      const yearEnd = await s.permission([d.id], { docNo: 'year-end' });
      await runAutomations(tx, { now: new Date('2026-06-20T06:00:00Z'), registerId: s.perm.id });
      await runAutomations(tx, { now: new Date('2026-12-20T06:00:00Z'), registerId: s.perm.id });
      expect(await tx.task.count({ where: { recordId: early.id } })).toBe(1);
      expect(await tx.task.count({ where: { recordId: yearEnd.id } })).toBe(0);
    }));
});

describe('текст PDF и глобальный поиск', () => {
  it('текст извлекается и ищется с русской морфологией; скан — no_text и счётчик; права', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const d = await s.device('WS-SEARCH-77');
      await s.permission([d.id], { docNo: 'ДОК-555', file: textPdf(['Председатель правления разрешает использование мессенджеров']) });
      await s.permission([d.id], { docNo: 'СКАН-1', file: scanPdf(), fileName: 'скан.pdf' });
      await s.permission([d.id], { docNo: 'JPG-1', file: tinyJpg(), fileName: 'фото.jpg' });
      const run = await processPendingTexts(tx, s.store);
      expect(run).toMatchObject({ processed: 2, text: 1, noText: 1 });

      // «мессенджер» находит «мессенджеров» — морфология; фрагмент с подсветкой.
      const r = await search(tx, s.staff.id, { q: 'мессенджер', limit: 10 });
      expect(r.files.items.map((f) => f.title)).toEqual(['Разрешение.pdf']);
      expect(r.files.items[0]?.snippet).toMatch(/\[\[мессенджеров\]\]/);
      expect(r.files.items[0]?.context).toMatch(/«Разрешения на доступ», запись #\d+: Документ-основание/);
      expect(r.noTextFiles).toBeGreaterThanOrEqual(1);
      // Имя хоста — в записях устройства и разрешений (заголовок связанной записи в тексте поиска).
      const host = await search(tx, s.staff.id, { q: 'ws-search-77', limit: 10 });
      expect(host.records.total).toBe(4);
      expect((await search(tx, s.staff.id, { q: 'ДОК-555', limit: 10 })).records.items).toHaveLength(1);
      // Имя файла.
      expect((await search(tx, s.staff.id, { q: 'скан', limit: 10 })).files.items.map((f) => f.title)).toContain('скан.pdf');

      // Юрист (без ib.work) не видит записей, доказательств и файлов записей.
      const lawyer = await makeUser(tx, ['doc_reader']);
      const l = await search(tx, lawyer.id, { q: 'мессенджер', limit: 10 });
      expect([l.records.total, l.files.total, l.evidence.total, l.noTextFiles]).toEqual([0, 0, 0, 0]);
    }));
});

describe('выгрузка для проверки', () => {
  it('Excel за период по дате документа и все файлы с именами «<№>_<хосты>»', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const a = await s.device('WS-Z1');
      const b = await s.device('WS-Z2');
      await s.permission([a.id, b.id], { docNo: '12/45-р', docDate: '2026-03-01' });
      await s.permission([a.id], { docNo: '13', docDate: '2026-04-10', file: tinyJpg(), fileName: 'скан письма.jpg' });
      const outside = await s.permission([b.id], { docNo: '99', docDate: '2025-12-30' });
      const { archive, fileName } = await exportZip(tx, s.store, s.actor, s.perm.id, {
        dateFieldId: s.P('Дата документа'), from: '2026-01-01', to: '2026-12-31', nameFieldId: s.P('№ документа'),
      });
      expect(fileName).toMatch(/^Разрешения на доступ — выгрузка для проверки \d{4}-\d{2}-\d{2}\.zip$/);
      const chunks: Buffer[] = [];
      for await (const c of archive) chunks.push(c as Buffer);
      const zip = readZip(Buffer.concat(chunks));
      const names = [...zip.keys()];
      expect(names.filter((n) => n.startsWith('files/'))).toEqual(['files/12-45-р_WS-Z1_WS-Z2.pdf', 'files/13_WS-Z1.jpg']);
      expect(must(zip.get('files/12-45-р_WS-Z1_WS-Z2.pdf')).subarray(0, 5).toString()).toBe('%PDF-');

      const book = new ExcelJS.Workbook();
      await book.xlsx.load(must(zip.get(must(names.find((n) => n.endsWith('.xlsx'))))) as unknown as ExcelJS.Buffer);
      const main = must(book.getWorksheet('Реестр'));
      const ids = main.getColumn(1).values.slice(2).map(Number);
      expect(ids).not.toContain(outside.number);
      expect(ids).toHaveLength(2);
      const list = must(book.getWorksheet('Файлы'));
      expect(list.getRow(2).getCell(3).value).toBe('files/12-45-р_WS-Z1_WS-Z2.pdf');
      expect(String(list.getRow(2).getCell(5).value)).toMatch(/^[0-9a-f]{64}$/);
      const audit = await tx.auditLog.findFirst({ where: { action: 'register.exported_zip' }, orderBy: { id: 'desc' } });
      expect((audit?.diff as { after?: { files?: number } }).after?.files).toBe(2);
    }));
});

describe('Excel: связь с записью по имени хоста', () => {
  it('импорт находит устройства по имени хоста; неизвестный хост — ошибка строки', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const a = await s.device('WS-XL-1');
      const b = await s.device('WS-XL-2');
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Реестр');
      ws.addRow(['ID', 'Сотрудник', 'Устройства', 'Дата документа']);
      ws.addRow([null, 'Петров Пётр', 'ws-xl-1; WS-XL-2', '01.02.2026']);
      ws.addRow([null, 'Сидоров', 'WS-НЕТ', '01.02.2026']);
      const buf = Buffer.from(await wb.xlsx.writeBuffer());
      const preview = await excel.previewImport(tx, s.actor, s.perm.id, buf, 'разрешения.xlsx');
      expect(preview.summary).toMatchObject({ added: 1, errorRows: 1 });
      expect(preview.summary.errors[0]?.message).toMatch(/«WS-НЕТ» — не найдено/);
      await excel.applyImport(tx, s.actor, preview.id);
      const created = must(await tx.registerRecord.findFirst({ where: { registerId: s.perm.id, deletedAt: null }, orderBy: { number: 'desc' } }));
      const v = created.values as Values;
      expect(v[s.P('Устройства')]).toEqual([a.id, b.id]);
      expect(v[s.P('Действует до')]).toBe('2026-12-31');
      expect(created.searchText).toContain('ws-xl-1');
    }));
});

describe('HTTP: разрешения и поиск', () => {
  it('422 FIELD_LOCKED в едином формате; файл записи с sha256 и статусом текста; обратные связи; поиск; zip', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const app = await buildApp({ db: tx, repo: prismaAuthRepository(tx), audit: prismaAuditWriter(tx), hasher: argon2Hasher, sessionSecret: TEST_SECRET, portalUrl: TEST_PORTAL_URL, files: s.store });
      const password = 'Dlp-Http-Test-2026';
      await tx.user.update({ where: { id: s.staff.id }, data: { passwordHash: await argon2Hasher.hash(password) } });
      const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: s.staff.login, password } });
      const cookie = `ib_session=${login.cookies.find((c) => c.name === 'ib_session')?.value}`;
      const d = await s.device('WS-HTTP-1');
      const rec = await s.permission([d.id], { docNo: 'HTTP-1' });

      const patch = await app.inject({
        method: 'PATCH', url: `/api/v1/register-records/${rec.id}`, headers: { cookie },
        payload: { version: rec.version, values: { [s.P('№ документа')]: 'другой' } },
      });
      expect(patch.statusCode).toBe(422);
      expect(patch.json().error).toMatchObject({ code: 'FIELD_LOCKED', message: expect.stringMatching(/«№ документа» зафиксировано статусом «Действует»/) });

      const got = await app.inject({ url: `/api/v1/register-records/${rec.id}`, headers: { cookie } });
      const file = got.json().files[s.P('Документ-основание')][0].file;
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      const meta = await app.inject({ url: `/api/v1/files/${file.id}`, headers: { cookie } });
      expect(meta.json()).toMatchObject({ text: { status: 'pending' }, refs: [{ kind: 'record', id: rec.id }] });

      const back = await app.inject({ url: `/api/v1/register-records/${d.id}/backlinks`, headers: { cookie } });
      expect(back.json().items[0]).toMatchObject({ registerName: 'Разрешения на доступ', fieldLabel: 'Устройства', items: [{ id: rec.id, status: 'Действует' }] });

      const found = await app.inject({ url: `/api/v1/search?q=${encodeURIComponent('HTTP-1')}`, headers: { cookie } });
      expect(found.statusCode).toBe(200);
      expect(found.json().records.items[0]).toMatchObject({ kind: 'records', link: `/registers?record=${rec.id}#${s.perm.id}/records` });

      const zip = await app.inject({ url: `/api/v1/registers/${s.perm.id}/export.zip?dateFieldId=${s.P('Дата документа')}&from=2026-01-01&to=2026-12-31`, headers: { cookie } });
      expect(zip.statusCode).toBe(200);
      expect(zip.headers['content-type']).toBe('application/zip');
      expect([...readZip(zip.rawPayload).keys()]).toContain('files/HTTP-1_WS-HTTP-1.pdf');
    }));
});

describe('конструктор: фиксация — настройка любого поля', () => {
  it('фиксация по статусу в обычном реестре; ослабить при записях в этом статусе нельзя; снять — когда записей нет', () =>
    inTx(async (tx) => {
      const x = await makeRegister(tx);
      const work = x.opt('status', 'В работе');
      const field = must(x.reg.fields.find((f) => f.id === x.f.score));
      let reg = await structure.updateField(tx, x.actor, field.id, { version: field.version, settings: { lock: { statusOptionIds: [work], mode: 'locked' } } });
      let rec = await records.createRecord(tx, x.actor, x.reg.id, { values: { [x.f.title]: 'Запись', [x.f.score]: 5 } });
      rec = await records.updateRecord(tx, x.actor, rec.id, { version: rec.version, values: { [x.f.status]: work } });
      await expectCode(records.updateRecord(tx, x.actor, rec.id, { version: rec.version, values: { [x.f.score]: 6 } }), 'FIELD_LOCKED');
      const f1 = must(reg.fields.find((f) => f.id === field.id));
      await expectCode(structure.updateField(tx, x.actor, field.id, { version: f1.version, settings: null }), 'LOCK_IN_USE');
      await expectCode(structure.updateField(tx, x.actor, field.id, { version: f1.version, settings: { lock: { statusOptionIds: [work], mode: 'reason' } } }), 'LOCK_IN_USE');
      await expectCode(structure.updateField(tx, x.actor, x.f.status, { version: must(reg.fields.find((f) => f.id === x.f.status)).version, isStatus: false }), 'LOCK_DEPENDENCY');
      await expectCode(structure.applyTypeChange(tx, x.actor, field.id, { version: f1.version, to: 'text' }), 'FIELD_SETTINGS');
      await expectCode(structure.updateField(tx, x.actor, x.f.status, { version: must(reg.fields.find((f) => f.id === x.f.status)).version, settings: { lock: { statusOptionIds: [work], mode: 'locked' } } }), 'BAD_SETTINGS');
      // Зафиксированную запись можно отправить в архив (удалить — нет).
      rec = await records.setRecordArchived(tx, x.actor, rec.id, rec.version, true);
      expect(rec.archived).toBe(true);
      // Режим «с причиной» — тоже настройка любого поля; без записей в этом статусе её можно снять.
      reg = await structure.updateField(tx, x.actor, x.f.level, { version: must(reg.fields.find((f) => f.id === x.f.level)).version, settings: { lock: { statusOptionIds: [x.opt('status', 'Закрыт')], mode: 'reason' } } });
      const lv = must(reg.fields.find((f) => f.id === x.f.level));
      expect(lv.settings).toEqual({ lock: { statusOptionIds: [x.opt('status', 'Закрыт')], mode: 'reason' } });
      reg = await structure.updateField(tx, x.actor, lv.id, { version: lv.version, settings: null });
      expect(must(reg.fields.find((f) => f.id === lv.id)).settings).toEqual({});
    }));
});
