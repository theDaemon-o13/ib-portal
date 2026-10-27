import { describe, expect, it } from 'vitest';
import { actorFor, expectCode, inTx, makeFileRow, makeUser, must, type Tx } from '../../test/db.js';
import { RISK_REGISTER_KEY } from '../risks/definition.js';
import { addDecision, listDecisions } from './decisions.service.js';
import { loadRegister } from './definition.js';
import * as records from './records.service.js';

async function riskRecord(tx: Tx) {
  const staff = await makeUser(tx, ['ib_staff'], { fullName: 'Сотрудник ИБ' });
  const actor = await actorFor(tx, staff.id);
  const regRow = must(await tx.register.findUnique({ where: { systemKey: RISK_REGISTER_KEY } }), 'реестр рисков из seed');
  const reg = await loadRegister(tx, regRow.id);
  const field = (key: string) => must(reg.fields.find((f) => f.systemKey === key), key);
  const title = must(reg.fields.find((f) => f.isTitle));
  const rec = await records.createRecord(tx, actor, reg.id, { values: { [title.id]: 'Компрометация привилегированных УЗ AD' } });
  const decision = field('decision');
  const option = (label: string) => must(decision.options.find((o) => o.label === label), label).id;
  return { staff, actor, reg, rec, decision, option, ormRef: field('ormRef'), reviewDue: field('reviewDue') };
}

describe('решения ОУР', () => {
  it('без файла документа-основания, номера или даты решение не вносится', () =>
    inTx(async (tx) => {
      const x = await riskRecord(tx);
      const base = {
        recordVersion: x.rec.version, fieldId: x.decision.id, optionId: x.option('Снижение'),
        documentTitle: 'Протокол риск-комитета', documentNumber: '7', documentDate: '2026-10-20',
      };
      // Файла нет (не загружен) — отказ; в БД решения не появилось.
      await expectCode(addDecision(tx, x.actor, x.rec.id, { ...base, fileId: '00000000-0000-4000-8000-000000000000' }), 'FILE_NOT_FOUND');
      const file = await makeFileRow(tx, x.staff.id, { name: 'Протокол_РК_7.pdf' });
      await expectCode(addDecision(tx, x.actor, x.rec.id, { ...base, fileId: file.id, documentNumber: ' ' }), 'NO_DOCUMENT_NUMBER');
      await expectCode(addDecision(tx, x.actor, x.rec.id, { ...base, fileId: file.id, documentDate: '' }), 'NO_DOCUMENT_DATE');
      await expectCode(addDecision(tx, x.actor, x.rec.id, { ...base, fileId: file.id, optionId: x.option('Ожидает решения') }), 'BAD_OPTION');
      expect(await tx.registerDecision.count({ where: { recordId: x.rec.id } })).toBe(0);
      // И в БД: file_id обязателен.
      await tx.$executeRawUnsafe('SAVEPOINT s');
      await expect(tx.$executeRawUnsafe(
        `INSERT INTO register_decisions (record_id, field_id, option_id, document_title, document_number, document_date, decided_by)
         VALUES ('${x.rec.id}', '${x.decision.id}', '${x.option('Снижение')}', 'СЗ', '1', '2026-10-20', '${x.staff.id}')`,
      )).rejects.toThrow(/23502/); // NOT NULL: file_id
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT s');
    }));

  it('решение с документом: «№ в реестре ОУР» и «Пересмотр до» в записи, документ — в доказательной базе', () =>
    inTx(async (tx) => {
      const x = await riskRecord(tx);
      const file = await makeFileRow(tx, x.staff.id, { name: 'СЗ_ОУР_88.pdf' });
      const rec = await addDecision(tx, x.actor, x.rec.id, {
        recordVersion: x.rec.version, fieldId: x.decision.id, optionId: x.option('Передача'),
        documentTitle: 'СЗ ОУР', documentNumber: '88', documentDate: '2026-10-20', fileId: file.id,
        reviewDue: '2027-04-20', externalRef: 'ОР-2026-033',
      });
      expect(rec.display[x.decision.id]).toBe('Передача');
      expect(rec.decisions[x.decision.id]).toMatchObject({ documentNumber: '88', fileId: file.id, reviewDue: '2027-04-20' });
      expect(rec.values[x.ormRef.id]).toBe('ОР-2026-033');
      expect(rec.values[x.reviewDue.id]).toBe('2027-04-20');
      expect(rec.version).toBe(x.rec.version + 1);

      // История записи: у изменений решения есть fieldId (раньше их не было — история отвечала 500).
      const [entry] = await records.recordHistory(tx, x.rec.id);
      expect(must(entry).changes.map((c) => c.fieldId)).toEqual([x.decision.id, x.ormRef.id, x.reviewDue.id]);

      const ev = must(await tx.evidence.findFirst({ where: { recordId: x.rec.id }, include: { files: true } }));
      expect(ev).toMatchObject({ kind: 'decision', status: 'accepted' });
      expect(ev.files.map((f) => f.fileId)).toEqual([file.id]);
      // Файл приложен дважды (решение и доказательство) — запись больше не удаляется, только архив.
      await expectCode(records.deleteRecord(tx, x.actor, x.rec.id, rec.version), 'HAS_DECISIONS');
      const hist = await listDecisions(tx, x.rec.id);
      expect(hist[0]).toMatchObject({ label: 'Передача', file: { name: 'СЗ_ОУР_88.pdf' } });
      // Устаревший экран — 409.
      await expectCode(addDecision(tx, x.actor, x.rec.id, {
        recordVersion: x.rec.version, fieldId: x.decision.id, optionId: x.option('Принят'),
        documentTitle: 'СЗ', documentNumber: '1', documentDate: '2026-10-21', fileId: (await makeFileRow(tx, x.staff.id)).id,
      }), 'VERSION_CONFLICT');
    }));

  it('старые записи журнала без fieldId у изменений — история читается, fieldId пустой', () =>
    inTx(async (tx) => {
      const x = await riskRecord(tx);
      await tx.auditLog.create({
        data: {
          userId: x.staff.id, action: 'register_record.decision_added', entity: 'register_record', entityId: x.rec.id,
          diff: { summary: 'решение до 1.0.0', after: { changes: [{ label: 'Решение ОУР', from: 'Ожидает решения', to: 'Снижение' }] } },
        },
      });
      const [entry] = await records.recordHistory(tx, x.rec.id);
      expect(must(entry).changes).toEqual([{ fieldId: '', label: 'Решение ОУР', from: 'Ожидает решения', to: 'Снижение' }]);
    }));
});
