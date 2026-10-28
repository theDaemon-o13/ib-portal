import { readFileSync } from 'node:fs';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { testDbConfig } from '../../../scripts/test-db.js';
import { must } from '../../test/db.js';

// Миграция rule_recipient_labels_by_id прогоняется целиком, как есть в файле, под владельцем схемы — в транзакции
// с откатом. Функцию link_recipient_labels (её удаляет сама миграция) транзакция сначала создаёт заново из
// миграции rule_recipient_ids.
const MIGRATIONS = new URL('../../../prisma/migrations/', import.meta.url);
const NARROW = readFileSync(new URL('20261028013925_rule_recipient_labels_by_id/migration.sql', MIGRATIONS), 'utf8');
const LINK_FN = (() => {
  const src = readFileSync(new URL('20261027052414_rule_recipient_ids/migration.sql', MIGRATIONS), 'utf8');
  const start = src.indexOf('CREATE FUNCTION "public"."link_recipient_labels"');
  const end = src.indexOf('\n$$;', start);
  if (start < 0 || end < 0) throw new Error('link_recipient_labels не найдена в миграции rule_recipient_ids');
  return src.slice(start, end + 4);
})();

type Recipient = Record<string, unknown>;

async function inOwnerTx(fn: (c: pg.Client) => Promise<void>) {
  const c = new pg.Client({ connectionString: testDbConfig().ownerUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(LINK_FN);
    await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
}

async function setup(c: pg.Client) {
  const reg = must((await c.query<{ id: string }>(`INSERT INTO registers (name, updated_at) VALUES ('Реестр сужения', now()) RETURNING id`)).rows[0]).id;
  const item = must((await c.query<{ id: string }>(
    `INSERT INTO catalog_items (catalog_code, value, updated_at) VALUES ('notify_recipients', 'Метка сужения', now()) RETURNING id`,
  )).rows[0]).id;
  const rule = async (recipients: Recipient[]) =>
    must((await c.query<{ id: string }>(
      `INSERT INTO register_automations (register_id, condition, action, updated_at) VALUES ($1, '{"kind":"overdue"}', $2, now()) RETURNING id`,
      [reg, JSON.stringify({ eventType: 'notify', recipients })],
    )).rows[0]).id;
  const recipientsOf = async (id: string) =>
    must((await c.query<{ r: Recipient[] }>(`SELECT action -> 'recipients' AS r FROM register_automations WHERE id = $1`, [id])).rows[0]).r;
  return { item, rule, recipientsOf };
}

/** Миграция в savepoint: при ошибке состояние транзакции возвращается к моменту до неё. */
async function migrate(c: pg.Client): Promise<string | null> {
  await c.query('SAVEPOINT narrow');
  try {
    await c.query(NARROW);
    return null;
  } catch (err) {
    await c.query('ROLLBACK TO SAVEPOINT narrow');
    return (err as Error).message;
  }
}

describe('миграция rule_recipient_labels_by_id', () => {
  it('метка, которую не привязать к справочнику, останавливает миграцию; ничего не меняется', () =>
    inOwnerTx(async (c) => {
      const x = await setup(c);
      const lost = await x.rule([{ kind: 'label', label: 'Удалённая метка' }, { kind: 'responsible' }]);
      const ghost = await x.rule([{ kind: 'label', label: 'Призрак', itemId: '00000000-0000-4000-8000-000000000000' }]);
      const ok = await x.rule([{ kind: 'label', label: 'Метка сужения', itemId: x.item }]);

      const error = await migrate(c);
      expect(error).toMatch(/миграция остановлена, данные не изменены/);
      expect(error).toContain(`реестр «Реестр сужения», правило ${lost}: метка «Удалённая метка» без itemId`);
      expect(error).toContain(`правило ${ghost}: метка «Призрак» — itemId 00000000-0000-4000-8000-000000000000 нет в справочнике`);
      expect(error).not.toContain(ok);

      // Названия на месте, ни одно правило не переписано, функция привязки не удалена.
      expect(await x.recipientsOf(lost)).toEqual([{ kind: 'label', label: 'Удалённая метка' }, { kind: 'responsible' }]);
      expect(await x.recipientsOf(ghost)).toEqual([{ kind: 'label', label: 'Призрак', itemId: '00000000-0000-4000-8000-000000000000' }]);
      expect(await x.recipientsOf(ok)).toEqual([{ kind: 'label', label: 'Метка сужения', itemId: x.item }]);
      expect((await c.query(`SELECT 1 FROM pg_proc WHERE proname = 'link_recipient_labels'`)).rowCount).toBe(1);
    }));

  it('метка без itemId, найденная по названию, привязывается; у всех меток остаются только kind и itemId', () =>
    inOwnerTx(async (c) => {
      const x = await setup(c);
      const byName = await x.rule([{ kind: 'user', userId: '00000000-0000-4000-8000-000000000001' }, { kind: 'label', label: '  метка   СУЖЕНИЯ ' }]);
      const linked = await x.rule([{ kind: 'label', label: 'Старое название', itemId: x.item }, { kind: 'responsible' }]);

      expect(await migrate(c)).toBeNull();
      expect(await x.recipientsOf(byName)).toEqual([{ kind: 'user', userId: '00000000-0000-4000-8000-000000000001' }, { kind: 'label', itemId: x.item }]);
      expect(await x.recipientsOf(linked)).toEqual([{ kind: 'label', itemId: x.item }, { kind: 'responsible' }]);
      expect((await c.query(`SELECT 1 FROM pg_proc WHERE proname = 'link_recipient_labels'`)).rowCount).toBe(0);
    }));
});
