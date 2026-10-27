import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../test/helpers.js';
import { createCache } from './cache.js';

describe('кэш дашборда', () => {
  it('минуту отдаёт посчитанное, потом считает заново', async () => {
    const clock = new FakeClock();
    const cache = createCache(60_000, clock.now);
    let calls = 0;
    const compute = async () => ++calls;
    const a = await cache.get('kpis', compute);
    clock.advance(59_000);
    const b = await cache.get('kpis', compute);
    expect([a.value, b.value, calls]).toEqual([1, 1, 1]);
    expect(b.computedAt).toBe(a.computedAt);
    clock.advance(1_000);
    expect((await cache.get('kpis', compute)).value).toBe(2);
  });

  it('одновременные запросы ждут один расчёт', async () => {
    const cache = createCache();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const compute = async () => {
      calls++;
      await gate;
      return 'ok';
    };
    const p = Promise.all([cache.get('w', compute), cache.get('w', compute), cache.get('w', compute)]);
    release();
    expect((await p).map((x) => x.value)).toEqual(['ok', 'ok', 'ok']);
    expect(calls).toBe(1);
  });

  it('ошибка не кэшируется; сброс по префиксу', async () => {
    const cache = createCache();
    await expect(cache.get('x', async () => Promise.reject(new Error('нет связи с БД')))).rejects.toThrow('нет связи');
    expect((await cache.get('x', async () => 5)).value).toBe(5);
    await cache.get('tile:1', async () => 1);
    cache.invalidate('tile:1');
    expect((await cache.get('tile:1', async () => 2)).value).toBe(2);
  });
});
