import { describe, expect, it } from 'vitest';
import { basisOf, basisText, type BasisRule } from './link-basis.js';

const rule: BasisRule = {
  kind: 'link_basis', channelFieldId: 'soc', closedOptionIds: ['forbidden'], sourceRegisterId: 'perm', linkFieldId: 'devices',
  kindFieldId: 'kind', kindOptionIds: ['social'], statusFieldId: 'status', activeOptionIds: ['active'], untilFieldId: 'until', numberFieldId: 'no',
};
const perm = (id: string, number: number, values: Record<string, unknown>) => ({
  id, number, values: { devices: ['dev1'], kind: 'social', status: 'active', until: '2026-12-31', no: `№${number}`, ...values },
});

describe('статус основания (link_basis)', () => {
  it('канал закрыт или не задан — closed', () => {
    expect(basisOf(rule, 'dev1', { soc: 'forbidden' }, [perm('p', 1, {})], '2026-06-01').state).toBe('closed');
    expect(basisOf(rule, 'dev1', {}, [], '2026-06-01').state).toBe('closed');
  });

  it('по связи с устройством: одно разрешение на несколько хостов, чужие и другого вида не считаются', () => {
    const multi = perm('p', 1, { devices: ['dev1', 'dev2'] });
    expect(basisOf(rule, 'dev2', { soc: 'tg' }, [multi], '2026-06-01')).toEqual({ state: 'ok', permission: { id: 'p', number: 1, docNumber: '№1', until: '2026-12-31' } });
    expect(basisOf(rule, 'dev3', { soc: 'tg' }, [multi], '2026-06-01').state).toBe('none');
    expect(basisOf(rule, 'dev1', { soc: 'tg' }, [perm('c', 2, { kind: 'cloud' })], '2026-06-01').state).toBe('none');
  });

  it('срок прошёл, отозвано — expired с последним по сроку; действующее важнее истёкшего', () => {
    const old = perm('old', 1, { until: '2025-12-31' });
    const revoked = perm('rev', 2, { status: 'revoked', until: '2026-12-31' });
    expect(basisOf(rule, 'dev1', { soc: 'tg' }, [old, revoked], '2026-06-01')).toMatchObject({ state: 'expired', permission: { id: 'rev' } });
    expect(basisOf(rule, 'dev1', { soc: 'tg' }, [old], '2026-01-01').state).toBe('expired');
    expect(basisOf(rule, 'dev1', { soc: 'tg' }, [old, perm('new', 3, {})], '2026-06-01')).toMatchObject({ state: 'ok', permission: { id: 'new' } });
  });

  it('текст для карточки и таблицы', () => {
    expect(basisText(basisOf(rule, 'dev1', { soc: 'tg' }, [perm('p', 1, {})], '2026-06-01'))).toBe('есть основание — разрешение №1 до 31.12.2026');
    expect(basisText({ state: 'none', permission: null })).toBe('нет основания');
  });
});
