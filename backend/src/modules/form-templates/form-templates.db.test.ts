import { afterEach, describe, expect, it } from 'vitest';
import { actorFor, expectCode, inTx, makeUser, type Tx } from '../../test/db.js';
import { formTemplateUsage } from '../settings/usage.js';
import * as svc from './service.js';

const actorOf = async (tx: Tx) => actorFor(tx, (await makeUser(tx, ['super_admin'])).id);
function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('ожидалось значение');
  return v;
}
let unregister: (() => void) | null = null;
afterEach(() => {
  unregister?.();
  unregister = null;
});

describe('шаблоны форм подтверждения', () => {
  it('seed: «Парольная защита» с требованиями, совпадающими с политикой портала', () =>
    inTx(async (tx) => {
      const list = await svc.listTemplates(tx, { includeArchived: false });
      expect(list.map((t) => t.name)).toEqual([
        'Акт пересмотра прав доступа',
        'Подтверждение соответствия требованиям парольной защиты',
      ]);
      const pwd = must(list[1]);
      expect(pwd.fields.map((f) => [f.label, f.checkKind, f.threshold])).toEqual([
        ['Минимальная длина пароля', 'min', 12],
        ['Классов символов (A, a, 0–9, !)', 'min', 3],
        ['Максимальный срок действия, дней', 'max', 90],
        ['Блокировка после неудачных попыток', 'max', 5],
        ['Запрет повтора последних паролей', 'min', 5],
        ['MFA для привилегированных УЗ', 'yes', null],
      ]);
    }));

  it('порог обязателен для «не менее» и «не более» и не хранится у остальных', () =>
    inTx(async (tx) => {
      const actor = await actorOf(tx);
      const t = await svc.createTemplate(tx, actor, { name: 'Резервное копирование', basis: 'Политика ИБ', validMonths: 6 });
      await expectCode(svc.addField(tx, actor, t.id, { label: 'Копий в неделю', checkKind: 'min' }), 'THRESHOLD_REQUIRED');
      const withField = await svc.addField(tx, actor, t.id, { label: 'Шифрование копий', checkKind: 'yes', threshold: 5 });
      expect(withField.fields[0]).toMatchObject({ checkKind: 'yes', threshold: null });
      const f = must(withField.fields[0]);
      await expectCode(svc.updateField(tx, actor, f.id, { version: f.version, checkKind: 'max' }), 'THRESHOLD_REQUIRED');
      const updated = await svc.updateField(tx, actor, f.id, { version: f.version, checkKind: 'max', threshold: 7.5 });
      expect(updated.fields[0]).toMatchObject({ checkKind: 'max', threshold: 7.5 });
    }));

  it('порядок полей и удаление поля', () =>
    inTx(async (tx) => {
      const actor = await actorOf(tx);
      let t = await svc.createTemplate(tx, actor, { name: 'Проверка', basis: '', validMonths: 12 });
      for (const label of ['А', 'Б', 'В']) t = await svc.addField(tx, actor, t.id, { label, checkKind: 'text' });
      const b = must(t.fields[1]);
      t = await svc.moveField(tx, actor, b.id, 'up');
      expect(t.fields.map((f) => f.label)).toEqual(['Б', 'А', 'В']);
      t = await svc.moveField(tx, actor, b.id, 'up'); // уже первое — без изменений
      expect(t.fields.map((f) => f.label)).toEqual(['Б', 'А', 'В']);
      const a = must(t.fields[1]);
      t = await svc.deleteField(tx, actor, a.id, a.version);
      expect(t.fields.map((f) => f.label)).toEqual(['Б', 'В']);
    }));

  it('шаблон, по которому загружены формы, не удаляется — только в архив; имя уникально', () =>
    inTx(async (tx) => {
      const actor = await actorOf(tx);
      const t = await svc.createTemplate(tx, actor, { name: 'Проверка DLP', basis: '', validMonths: 12 });
      await expectCode(svc.createTemplate(tx, actor, { name: 'проверка dlp', basis: '', validMonths: 1 }), 'DUPLICATE');
      unregister = formTemplateUsage.register('test', async (_db, ids) => new Map(ids.map((id) => [id, id === t.id ? 2 : 0])));
      await expectCode(svc.deleteTemplate(tx, actor, t.id, t.version), 'IN_USE');
      const archived = await svc.archiveTemplate(tx, actor, t.id, t.version);
      expect(archived).toMatchObject({ archived: true, usage: 2 });
      expect((await svc.listTemplates(tx, { includeArchived: false })).map((x) => x.id)).not.toContain(t.id);
    }));
});
