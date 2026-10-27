import { describe, expect, it } from 'vitest';
import { assertShadowDb, dbNameOf } from './shadow-db.js';

describe('теневая база Prisma', () => {
  it('только одноразовая *_shadow, не совпадающая с проверяемой', () => {
    expect(() => assertShadowDb('ibportal_dev_shadow', 'ibportal_dev')).not.toThrow();
    expect(() => assertShadowDb('ibportal_dev', 'ibportal_dev')).toThrow('*_shadow');
    expect(() => assertShadowDb('ibportal', 'ibportal_dev')).toThrow('*_shadow');
    expect(() => assertShadowDb('ibportal_test', 'ibportal_dev')).toThrow('*_shadow');
    expect(() => assertShadowDb('shadow', 'ibportal_dev')).toThrow('*_shadow');
    expect(() => assertShadowDb('x_shadow"; DROP', 'ibportal_dev')).toThrow('*_shadow');
    expect(() => assertShadowDb('ibportal_shadow', 'ibportal_shadow')).toThrow('совпадает');
  });

  it('имя базы из адреса', () => {
    expect(dbNameOf('postgresql://u:p@127.0.0.1:5433/ibportal_dev_shadow?schema=public')).toBe('ibportal_dev_shadow');
  });
});
