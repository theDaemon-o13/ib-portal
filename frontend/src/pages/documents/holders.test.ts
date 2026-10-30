// «Сейчас у» и «кто действует» под этапами — рендер с подставными данными (без backend и dev-базы).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HoldersLine, StageWho } from './Holders';

const text = (html: string) => html.replace(/<[^>]+>/g, '');
const noHead = { people: [], missingHead: true };

describe('«Начальник ИБ не назначен» (подставные данные)', () => {
  it('строка реестра: «Сейчас у: Начальник ИБ не назначен», красным', () => {
    const html = renderToStaticMarkup(createElement(HoldersLine, { holders: noHead, testId: 'doc-holders' }));
    expect(text(html)).toBe('Сейчас у: Начальник ИБ не назначен');
    expect(html).toContain('late-t');
    expect(html).toContain('data-testid="doc-holders"');
  });

  it('карточка: над маршрутом — то же, имя жирным', () => {
    const html = renderToStaticMarkup(createElement(HoldersLine, { holders: noHead, testId: 'doc-now-at', className: 'now-at' }));
    expect(html).toContain('<b>Начальник ИБ не назначен</b>');
    expect(html).toContain('class="now-at late-t"');
  });

  it('этапы 13 и 14: под этапом — «Начальник ИБ не назначен»; с отметкой — ФИО', () => {
    const hint = 'начальник ИБ (отметка в карточке пользователя)';
    for (const stage of [13, 14]) {
      const html = renderToStaticMarkup(createElement(StageWho, { hint, approvers: [], missingHead: true }));
      expect(text(html), `этап ${stage}`).toBe(`${hint}: Начальник ИБ не назначен`);
    }
    expect(text(renderToStaticMarkup(createElement(StageWho, { hint, approvers: ['Иванов И. И.'], missingHead: false })))).toBe(`${hint}: Иванов И. И.`);
  });

  it('отключённый автор: «<ФИО> (отключён)» и подсказка «Владельца можно сменить»', () => {
    const html = renderToStaticMarkup(createElement(HoldersLine, { holders: { people: [{ id: 'o', fullName: 'Автор', inactive: true }], missingHead: false }, testId: 'doc-holders' }));
    expect(text(html)).toBe('Сейчас у: Автор (отключён)');
    expect(html).toContain('title="Владельца можно сменить"');
  });
});
