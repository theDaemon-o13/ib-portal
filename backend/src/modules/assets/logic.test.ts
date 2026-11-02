import { describe, expect, it } from 'vitest';
import { checkedFact, nameCollisions, noDataFact, normalizeHostName, type FactRecord } from './logic.js';

const def = { code: 'x.y', section: '2.2', title: 'Проверка' };
const at = '2026-11-01T00:00:00.000Z';
const ref = (id: string): FactRecord => ({ id, title: id, href: null, detail: null });

describe('normalizeHostName', () => {
  it('без регистра, пробелов и доменного суффикса', () => {
    expect(normalizeHostName('  WS-01.bank.local ')).toBe('ws-01');
    expect(normalizeHostName('ws-01')).toBe('ws-01');
  });
  it('IP-адрес остаётся целиком', () => {
    expect(normalizeHostName('10.1.2.3')).toBe('10.1.2.3');
  });
  it('пустое имя', () => {
    expect(normalizeHostName('   ')).toBe('');
  });
});

describe('единая структура факта', () => {
  it('нарушения: числитель — соответствующие, процент вниз, список нарушителей', () => {
    const f = checkedFact(def, at, { checked: 3, violators: [ref('a')], emptyMessage: 'пусто' });
    expect(f).toMatchObject({ code: 'x.y', section: '2.2', relatedSections: [], status: 'violations', numerator: 2, denominator: 3, percent: 66.6, calculatedAt: at });
    expect(f.records.map((r) => r.id)).toEqual(['a']);
  });
  it('84,96% не округляется до прохождения порога 85%', () => {
    const f = checkedFact(def, at, { checked: 2000, violators: Array.from({ length: 301 }, (_, i) => ref(String(i))), emptyMessage: 'пусто' });
    expect(f.percent).toBe(84.9);
  });
  it('нарушений нет: ok и 100%', () => {
    expect(checkedFact(def, at, { checked: 2, violators: [], emptyMessage: 'пусто' })).toMatchObject({ status: 'ok', percent: 100, records: [] });
  });
  it('проверять нечего: no_data без процента и списка, а не 100%', () => {
    expect(checkedFact(def, at, { checked: 0, violators: [], emptyMessage: 'Нет данных' })).toMatchObject({
      status: 'no_data', numerator: null, denominator: null, percent: null, records: [], message: 'Нет данных',
    });
  });
  it('пустой источник: сообщение обязательно', () => {
    expect(noDataFact(def, at, 'Нет данных: реестр рисков не заполнен').message).toBe('Нет данных: реестр рисков не заполнен');
  });
});

describe('nameCollisions', () => {
  it('совпавшие имена — предупреждение со ссылками на обе записи', () => {
    const w = nameCollisions([
      { name: 'WS-01', ref: ref('a') },
      { name: 'ws-01.bank.local', ref: ref('b') },
      { name: 'WS-02', ref: ref('c') },
    ], 'Реестр хостов');
    expect(w).toHaveLength(1);
    expect(w[0]?.records.map((r) => r.id)).toEqual(['a', 'b']);
  });
});
