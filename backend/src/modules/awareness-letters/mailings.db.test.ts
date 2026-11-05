// Реестр «Рассылки» с настоящей БД (1.9.0, шаг 8; docs/specs/awareness.md, раздел 18): запись при каждой отметке
// «Отправлено», поля по ключам, «Подготовил» и «Задача», реестр в архиве, ссылки на письма. Всё вымышленное.
import { describe, expect, it } from 'vitest';
import { actorFor, inTx, makeUser, must, type Tx } from '../../test/db.js';
import { createRecord } from '../registers/records.service.js';
import { AWARENESS_MAILINGS_KEY } from './definition.js';
import * as letters from './letters.service.js';
import { letterRef, letterRefs, parseLetterRef } from './mailings.js';
import { SIGNATURE_BLOCK } from './variables.js';

const NOW = new Date('2041-01-04T06:00:00Z');
const deps = { now: () => NOW };
const both = { subjectRu: 'Поддельные письма', subjectTj: 'Мактубҳои қалбакӣ', htmlRu: `<p>Текст</p>${SIGNATURE_BLOCK}`, htmlTj: `<p>Матн</p>${SIGNATURE_BLOCK}` };

/** Значения записи по ключам полей; список — подпись варианта, сотрудник — id. */
async function mailing(tx: Tx, recordId: string) {
  const reg = await tx.register.findUniqueOrThrow({ where: { systemKey: AWARENESS_MAILINGS_KEY }, include: { fields: { include: { options: true } } } });
  const rec = await tx.registerRecord.findUniqueOrThrow({ where: { id: recordId } });
  const values = rec.values as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of reg.fields) {
    const v = values[f.id];
    if (v === undefined || !f.systemKey) continue;
    out[f.systemKey] = f.type === 'select' ? f.options.find((o) => o.id === v)?.label : v;
  }
  return { number: rec.number, values: out };
}

async function approved(tx: Tx, title: string, extra: Partial<typeof both> = {}) {
  const author = await actorFor(tx, (await makeUser(tx, ['ib_staff'])).id);
  const head = await actorFor(tx, (await makeUser(tx, ['ib_staff', 'ib_head'], { isIbHead: true })).id);
  const { letter } = await letters.createLetter(tx, author, { title, kind: 'planned', ...both, ...extra });
  const s = await letters.submitLetter(tx, author, letter.id, { version: letter.version });
  const a = await letters.approveLetter(tx, head, letter.id, { version: s.version });
  return { author, head, letter: a };
}

describe('реестр «Рассылки»', () => {
  it('отметка «Отправлено» — запись: дата, «№ N, версия V», тема «RU / TJ», тип, аудитория, подготовил; повтор — новая запись', () =>
    inTx(async (tx) => {
      const { author, letter } = await approved(tx, 'Январская');
      const sent = await letters.sendLetter(tx, author, letter.id, { version: letter.version, sentOn: '2041-01-04', audience: 'Все сотрудники' }, deps);
      const ev = must(sent.events[0]);
      const r1 = await mailing(tx, must(ev.record).id);
      expect(r1.values).toEqual({
        sentOn: '2041-01-04', letter: `№ ${letter.number}, версия ${sent.sentVersionNo}`, subject: 'Поддельные письма / Мактубҳои қалбакӣ',
        kind: 'Плановое', audience: 'Все сотрудники', preparedBy: author.id,
      });
      const a = await tx.auditLog.findFirstOrThrow({ where: { entity: 'register_record', entityId: must(ev.record).id } });
      expect(a.diff).toMatchObject({ after: { via: 'awareness_letter', letterNumber: letter.number } });

      const again = await letters.sendLetter(tx, author, letter.id, { version: sent.version, sentOn: '2041-01-04', audience: 'Отдел кадров' }, deps);
      const r2 = await mailing(tx, must(must(again.events[0]).record).id);
      expect([r2.number, r2.values.audience, r2.values.letter]).toEqual([r1.number + 1, 'Отдел кадров', r1.values.letter]);
      expect(again.versions.length).toBe(sent.versions.length);
    }));

  it('срочное на одном языке без согласования: «, только RU», тема RU, повод, «Задача #K»; автор отключён — «Подготовил» пусто', () =>
    inTx(async (tx) => {
      const author = await actorFor(tx, (await makeUser(tx, ['ib_staff'])).id);
      const sender = await actorFor(tx, (await makeUser(tx, ['ib_staff'])).id);
      const u = await letters.urgentMailing(tx, author, { title: 'Атака', reason: 'Новая схема мошенничества' }, deps);
      const filled = await letters.saveLetter(tx, author, u.letter.id, { version: u.letter.version, subjectRu: 'Внимание', htmlRu: '<p>Текст</p>', subjectTj: '', htmlTj: '' });
      await tx.user.update({ where: { id: author.id }, data: { isActive: false } });
      const sent = await letters.sendLetter(tx, sender, u.letter.id, {
        version: filled.letter.version, sentOn: '2041-01-04', audience: 'Все сотрудники', comment: 'Отправлено без согласования: атака идёт сейчас',
      }, deps);
      const r = await mailing(tx, must(must(sent.events[0]).record).id);
      expect(r.values).toEqual({
        sentOn: '2041-01-04', letter: `№ ${u.letter.number}, версия ${sent.sentVersionNo}, только RU`, subject: 'Внимание', kind: 'Срочное',
        reason: 'Новая схема мошенничества', audience: 'Все сотрудники', task: `Задача #${must(u.letter.task).number}`,
      });
    }));

  it('реестр в архиве — отметка проходит без записи; ручная запись с любым «Письмом» — можно; ссылка — только на существующее', () =>
    inTx(async (tx) => {
      const { author, letter } = await approved(tx, 'Без реестра');
      const reg = await tx.register.findUniqueOrThrow({ where: { systemKey: AWARENESS_MAILINGS_KEY }, include: { fields: true } });
      await tx.register.update({ where: { id: reg.id }, data: { archivedAt: new Date() } });
      const sent = await letters.sendLetter(tx, author, letter.id, { version: letter.version, sentOn: '2041-01-04', audience: 'Все сотрудники' }, deps);
      expect([sent.status, sent.events[0]?.record]).toEqual(['sent', null]);
      await tx.register.update({ where: { id: reg.id }, data: { archivedAt: null } });

      const fieldId = (key: string) => must(reg.fields.find((f) => f.systemKey === key)).id;
      const manual = await createRecord(tx, author, reg.id, {
        values: { [fieldId('subject')]: 'Осторожно: звонки', [fieldId('letter')]: 'Рассылка 2023 года, письмо отдела кадров', [fieldId('sentOn')]: '2023-03-01' },
      });
      expect(manual.number).toBeGreaterThan(0);

      expect(parseLetterRef(letterRef(12, 3, 'only_tj'))).toEqual({ number: 12, versionNo: 3 });
      expect(parseLetterRef('Рассылка 2023 года')).toBeNull();
      const refs = await letterRefs(tx, [letter.number, 999_999_999]);
      expect(refs.items).toEqual([{ number: letter.number, id: letter.id, lastVersionNo: must(sent.sentVersionNo) }]);
    }));
});
