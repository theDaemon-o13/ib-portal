// Круговой путь Excel с полем «Файл» (1.12.0 → 1.13.0): выгрузка пишет «имя; sha256» каждого файла, обратный импорт
// этого же файла (и сравнение с реестром) — без ошибок, без изменений и без ложного «изменено в колонках только для
// чтения»; ссылки на файлы записи не меняются и не очищаются, даже если ячейку в Excel поправили или стёрли.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diskFileStore } from '../../lib/file-store.js';
import { inTx, must, type Tx } from '../../test/db.js';
import { makeRegister } from '../../test/registers-fixture.js';
import { uploadFile } from '../files/service.js';
import * as compare from './compare.service.js';
import * as excel from './excel.service.js';
import * as recordFiles from './record-files.service.js';
import * as records from './records.service.js';
import * as structure from './structure.service.js';

const store = diskFileStore(mkdtempSync(join(tmpdir(), 'ibportal-xfile-')));

async function setup(tx: Tx) {
  const x = await makeRegister(tx);
  const reg = await structure.addField(tx, x.actor, x.reg.id, { label: 'Документ', type: 'file' });
  const fieldId = must(reg.fields.find((f) => f.label === 'Документ')).id;
  const a = await records.createRecord(tx, x.actor, x.reg.id, { values: { [x.f.title]: 'Запись с файлами' } });
  const f1 = await uploadFile(tx, store, x.actor, 'приказ.pdf', Buffer.from('%PDF-1.4\n%%EOF\n'));
  const f2 = await uploadFile(tx, store, x.actor, 'акт.txt', Buffer.from('акт проверки'));
  await recordFiles.attachFiles(tx, x.actor, a.id, { fieldId, fileIds: [f1.id, f2.id], version: a.version });
  const b = await records.createRecord(tx, x.actor, x.reg.id, { values: { [x.f.title]: 'Запись без файла' } });
  const links = async () => (await tx.registerRecordFile.findMany({ where: { fieldId, removedAt: null }, orderBy: { fileId: 'asc' } })).map((l) => [l.recordId, l.fileId]);
  return { x, fieldId, a, b, f1, f2, links };
}

describe('Excel: поле «Файл» туда и обратно', () => {
  it('выгрузка — «имя; sha256»; импорт того же файла — без изменений, ошибок и предупреждений; файлы на месте', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const before = await s.links();
      const out = await excel.exportRegister(tx, s.x.reg.id);
      const { ws } = await excel.openRegisterSheet(out.buffer);
      const header = (ws.getRow(1).values as unknown[]).map(String);
      const col = header.indexOf('Документ');
      const cells = [2, 3].map((r) => String(ws.getRow(r).getCell(col).value ?? ''));
      expect(cells.find((c) => c.includes('приказ.pdf'))).toMatch(new RegExp(`приказ\\.pdf; sha256: ${s.f1.sha256}\\nакт\\.txt; sha256: ${s.f2.sha256}|акт\\.txt; sha256: ${s.f2.sha256}\\nприказ\\.pdf; sha256: ${s.f1.sha256}`));

      const p = await excel.previewImport(tx, s.x.actor, s.x.reg.id, out.buffer, out.fileName);
      expect(p.summary).toMatchObject({ added: 0, updated: 0, errorRows: 0, errors: [], warnings: [] });
      await excel.applyImport(tx, s.x.actor, p.id);
      expect(await s.links()).toEqual(before);
    }));

  it('ячейку «Файл» поправили или стёрли — импорт её не применяет: только предупреждение, ссылки на файлы не меняются', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const before = await s.links();
      const out = await excel.exportRegister(tx, s.x.reg.id);
      const { wb, ws } = await excel.openRegisterSheet(out.buffer);
      const col = (ws.getRow(1).values as unknown[]).map(String).indexOf('Документ');
      for (const r of [2, 3]) {
        const cell = ws.getRow(r).getCell(col);
        cell.value = String(cell.value ?? '').includes('приказ') ? '' : 'чужой.pdf; sha256: 00';
      }
      const edited = Buffer.from(await wb.xlsx.writeBuffer());
      const p = await excel.previewImport(tx, s.x.actor, s.x.reg.id, edited, 'правка.xlsx');
      expect(p.summary).toMatchObject({ added: 0, updated: 0, errorRows: 0 });
      expect(p.summary.warnings).toEqual(['В колонках «только для чтения» изменено значений: 2. Они не импортируются']);
      await excel.applyImport(tx, s.x.actor, p.id);
      expect(await s.links()).toEqual(before);
    }));

  it('сравнение с реестром по этому же файлу — проходит, файлы записи не меняются', () =>
    inTx(async (tx) => {
      const s = await setup(tx);
      const before = await s.links();
      const out = await excel.exportRegister(tx, s.x.reg.id);
      const p = await excel.previewImport(tx, s.x.actor, s.x.reg.id, out.buffer, out.fileName);
      const c = await compare.compareWithRegister(tx, store, s.x.actor, p.id, out.buffer, { all: true });
      expect(c.missing).toEqual([]);
      expect(await s.links()).toEqual(before);
    }));
});
