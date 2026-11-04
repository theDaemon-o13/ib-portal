import { describe, expect, it } from 'vitest';
import { keyWords, prefilterPattern, similarKeys, stripReplyPrefixes, titleKey } from './title-key.js';

const rule = { minJaccard: 0.6, minCommonWords: 2 };

describe('titleKey (1.7.0, цепочки задач)', () => {
  it('вложенные и повторяющиеся префиксы', () => {
    expect(titleKey('RE: RE: FW: Тестовая тема')).toBe('тестовая тема');
    expect(titleKey('Fwd: Re[2]: Re(3): тестовая тема')).toBe('тестовая тема');
    expect(titleKey('Отв: ВО: Пересл.: Ответ: Тестовая тема')).toBe('тестовая тема');
    expect(titleKey('AW: WG: SV: VS: TR: RV: Тестовая тема')).toBe('тестовая тема');
    expect(titleKey('[EXT] RE: [External] (EXT) Тестовая тема')).toBe('тестовая тема');
    expect(titleKey('[Внешнее] Fwd:Тестовая тема')).toBe('тестовая тема');
  });

  it('без двоеточия — только латинские RE, FW, Fwd и только с текстом дальше', () => {
    expect(titleKey('RE Тестовая тема')).toBe('тестовая тема');
    expect(titleKey('re fw Тестовая тема')).toBe('тестовая тема');
    expect(titleKey('Re[2] Тестовая тема')).toBe('тестовая тема');
    expect(titleKey('Во вторник проверка')).toBe('во вторник проверка');
    expect(titleKey('Ответственный за доступ')).toBe('ответственный за доступ');
    expect(titleKey('Отвод портов')).toBe('отвод портов');
    expect(titleKey('Report about access')).toBe('report about access');
    expect(titleKey('Fwdemo запуск')).toBe('fwdemo запуск');
    expect(titleKey('Re')).toBe('re');
  });

  it('регистр, кириллица и латиница, ё, лишние пробелы, NFKC', () => {
    expect(titleKey('  ТЕСТОВАЯ   Тема  VPN ')).toBe('тестовая тема vpn');
    expect(titleKey('Ёлка и Елка')).toBe('елка и елка');
    expect(titleKey('ＲＥ：　Тестовая тема')).toBe('тестовая тема');
    expect(titleKey('Доступ к VPN')).toBe(titleKey('доступ к vpn'));
  });

  it('пунктуация по краям обрезается, внутри остаётся', () => {
    expect(titleKey('RE: «Тестовая тема»!!!')).toBe('тестовая тема');
    expect(titleKey('— Тестовая тема: этап 2 —')).toBe('тестовая тема: этап 2');
    expect(titleKey('RE: - тема.')).toBe('тема');
  });

  it('пустой остаток — ключа нет', () => {
    expect(titleKey('RE: FW:')).toBeNull();
    expect(titleKey('RE: ...')).toBeNull();
    expect(titleKey('   ')).toBeNull();
    expect(titleKey('[EXT]')).toBeNull();
  });
});

describe('stripReplyPrefixes', () => {
  it('сохраняет регистр и символы остатка', () => {
    expect(stripReplyPrefixes('RE: FW: Блокировка учётной записи')).toBe('Блокировка учётной записи');
    expect(stripReplyPrefixes('[EXT] Отв: Заявка №12')).toBe('Заявка №12');
    expect(stripReplyPrefixes('Почему не работает VPN?')).toBe('Почему не работает VPN?');
    expect(stripReplyPrefixes('RE:')).toBe('');
  });
});

describe('похожесть ключей', () => {
  it('Жаккар ≥ 0,6 и два общих слова; порядок слов не важен', () => {
    expect(similarKeys('тестовая тема по доступу', 'доступу тестовая тема', rule)).toBe(true);
    expect(similarKeys('тестовая тема', 'тестовая проверка', rule)).toBe(false);
  });

  it('слова из одной-двух букв не считаются (решение владельца)', () => {
    expect([...keyWords('доступ к vpn иванов')]).toEqual(['доступ', 'vpn', 'иванов']);
    // {доступ, vpn, иванов} и {доступ, vpn, петров}: общих 2 из 4 — 0,5.
    expect(similarKeys('доступ к vpn иванов', 'доступ к vpn петров', rule)).toBe(false);
    expect(similarKeys('доступ к vpn для отдела', 'доступ в vpn отдела', rule)).toBe(true);
  });

  it('ключ из одного слова — только точное совпадение', () => {
    expect(similarKeys('аудит', 'аудит', rule)).toBe(true);
    expect(similarKeys('аудит', 'аудит прав', rule)).toBe(false);
  });

  it('порог из настроек', () => {
    expect(similarKeys('доступ к vpn иванов', 'доступ к vpn петров', { minJaccard: 0.5, minCommonWords: 2 })).toBe(true);
    expect(similarKeys('тестовая тема по доступу', 'доступу тестовая тема', { minJaccard: 0.6, minCommonWords: 4 })).toBe(false);
  });
});

describe('prefilterPattern', () => {
  it('самое длинное слово, «е» — любой символ, спецсимволы LIKE экранированы', () => {
    expect(prefilterPattern('доступ к vpn сотрудника')).toBe('%сотрудника%');
    expect(prefilterPattern('елка')).toBe('%_лка%');
    expect(prefilterPattern('100% план')).toBe('%план%');
    expect(prefilterPattern('a_b')).toBe('%a\\_b%');
  });
});
