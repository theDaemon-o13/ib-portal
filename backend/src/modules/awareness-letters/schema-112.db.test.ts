// Схема 1.12.0 (миграция awareness_layout) с настоящей БД под ролью приложения: выгрузки только пополняются,
// «Оформление писем» — одна строка, поля отметки «Отправлено» только у события sent, file_active_refs() учитывает
// логотип и выгрузки, у прежних строк новые колонки пустые. Каждый тест — транзакция с откатом.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { inTx, makeUser, type Tx } from '../../test/db.js';

async function rejects(tx: Tx, sql: string, re: RegExp): Promise<void> {
  await tx.$executeRawUnsafe('SAVEPOINT expect_fail');
  await expect(tx.$executeRawUnsafe(sql)).rejects.toThrow(re);
  await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT expect_fail');
}

async function fixture(tx: Tx) {
  const user = await makeUser(tx, ['ib_staff']);
  const letter = await tx.awarenessLetter.create({ data: { title: 'Письмо', kind: 'planned', createdBy: user.id } });
  const v = await tx.awarenessLetterVersion.create({
    data: { letterId: letter.id, no: 1, reason: 'created', subjectRu: 'Тема', subjectTj: 'Мавзӯъ', htmlRu: '<p>Текст</p>', htmlTj: '<p>Матн</p>', createdBy: user.id },
  });
  const data = Buffer.from('X-Unsent: 1\r\n\r\n');
  const sha256 = createHash('sha256').update(data).digest('hex');
  const file = await tx.file.create({
    data: { storageKey: `2026/11/${crypto.randomUUID()}`, originalName: 'Тема_RU-TJ_2026-11-06.eml', mime: 'message/rfc822', size: BigInt(data.length), sha256, uploadedBy: user.id },
  });
  const exp = await tx.awarenessLetterExport.create({ data: { letterId: letter.id, versionId: v.id, langs: 'both', fileId: file.id, sha256, createdBy: user.id } });
  return { user, letter, v, file, exp };
}

const refs = async (tx: Tx, id: string) => Number((await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT file_active_refs('${id}') AS n`))[0]?.n ?? -1);

describe('учебные письма 1.12.0: схема под ролью приложения', () => {
  it('выгрузка только пополняется; языки и sha256 проверяются', () =>
    inTx(async (tx) => {
      const { exp, letter, v, file, user } = await fixture(tx);
      await rejects(tx, `UPDATE awareness_letter_exports SET langs = 'ru' WHERE id = '${exp.id}'`, /только пополняется|permission denied/);
      await rejects(tx, `DELETE FROM awareness_letter_exports WHERE id = '${exp.id}'`, /только пополняется|permission denied/);
      await rejects(tx, `INSERT INTO awareness_letter_exports (letter_id, version_id, langs, file_id, sha256, created_by)
        VALUES ('${letter.id}', '${v.id}', 'en', '${file.id}', '${exp.sha256}', '${user.id}')`, /awareness_letter_exports_langs_check/);
      await rejects(tx, `INSERT INTO awareness_letter_exports (letter_id, version_id, langs, file_id, sha256, created_by)
        VALUES ('${letter.id}', '${v.id}', 'ru', '${file.id}', 'abc', '${user.id}')`, /awareness_letter_exports_sha_check/);
    }));

  it('оформление — одна строка; удалить нельзя', () =>
    inTx(async (tx) => {
      const row = await tx.awarenessLayout.findUnique({ where: { id: 1 } });
      expect(row).toMatchObject({ email: 'security@example.org', logoFileId: null });
      await rejects(tx, `INSERT INTO awareness_layout (id, dept_ru, dept_tj, email, closing_ru, closing_tj, label_urgent_ru, label_urgent_tj, label_planned_ru, label_planned_tj, tj_hint)
        VALUES (2, 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a')`, /awareness_layout_single_check/);
      await rejects(tx, 'DELETE FROM awareness_layout', /permission denied/);
    }));

  it('языки, получатели и выгрузка — только у события sent', () =>
    inTx(async (tx) => {
      const { letter, user, exp } = await fixture(tx);
      await rejects(tx, `INSERT INTO awareness_letter_events (letter_id, action, langs, actor_id) VALUES ('${letter.id}', 'submitted', 'ru', '${user.id}')`,
        /awareness_letter_events_send_check/);
      await rejects(tx, `INSERT INTO awareness_letter_events (letter_id, action, langs, sent_on, audience, actor_id) VALUES ('${letter.id}', 'sent', 'de', '2026-11-06', 'Все сотрудники', '${user.id}')`,
        /awareness_letter_events_langs_check/);
      await tx.awarenessLetterEvent.create({ data: { letterId: letter.id, action: 'sent', sentOn: new Date('2026-11-06T00:00:00Z'), audience: 'Все сотрудники', langs: 'both', recipients: 'all@example.org', exportId: exp.id, actorId: user.id } });
    }));

  it('file_active_refs: выгрузка и логотип — ссылки', () =>
    inTx(async (tx) => {
      const { file, user } = await fixture(tx);
      expect(await refs(tx, file.id)).toBe(1);
      const logo = await tx.file.create({
        data: { storageKey: `2026/11/${crypto.randomUUID()}`, originalName: 'logo.png', mime: 'image/png', size: 10n, sha256: 'a'.repeat(64), uploadedBy: user.id },
      });
      expect(await refs(tx, logo.id)).toBe(0);
      await tx.awarenessLayout.update({ where: { id: 1 }, data: { logoFileId: logo.id } });
      expect(await refs(tx, logo.id)).toBe(1);
    }));

  it('новые колонки шаблонов и версий по умолчанию пустые', () =>
    inTx(async (tx) => {
      const { v } = await fixture(tx);
      expect(v).toMatchObject({ headerRu: '', headerTj: '', labelRu: '', labelTj: '', subjectBoth: '' });
    }));
});
