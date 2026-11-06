import { describe, expect, it } from 'vitest';
import {
  addMonthsIso, allowedActions, checkDocUrlPrefix, compareTypes, docComparator, docStatus, dueMatches, placeName, routeV3Of, stageDaysKey, stageState, stageTaskDescription, stageTaskText,
  isDocUrl, ROUTE_FROM_LEGACY, stageHolders, stageName, stateOf, type DocRole, type HolderCtx,
} from './status.js';

describe('статус документа', () => {
  const today = '2026-10-27';
  it('без утверждённой версии: черновик на этапе «Драфт», дальше — на согласовании', () => {
    expect(docStatus({ hasApproved: false, workingStage: 21, reviewDue: null }, today)).toBe('draft');
    expect(docStatus({ hasApproved: false, workingStage: 22, reviewDue: null }, today)).toBe('in_approval');
    expect(docStatus({ hasApproved: false, workingStage: 24, reviewDue: null }, today)).toBe('in_approval');
    // Версия маршрута 1.2.0, созданная 1.10.0 после отката и ещё не перенесённая: драфт — по-прежнему черновик.
    expect(docStatus({ hasApproved: false, workingStage: 11, reviewDue: null }, today)).toBe('draft');
  });
  it('утверждён; новая версия в работе — на пересмотре', () => {
    expect(docStatus({ hasApproved: true, workingStage: null, reviewDue: '2027-10-27' }, today)).toBe('approved');
    expect(docStatus({ hasApproved: true, workingStage: 21, reviewDue: '2027-10-27' }, today)).toBe('in_review');
    expect(docStatus({ hasApproved: true, workingStage: 23, reviewDue: '2027-10-27' }, today)).toBe('in_review');
  });
  it('просрочка пересмотра важнее «на пересмотре»; в день пересмотра ещё не просрочен', () => {
    expect(docStatus({ hasApproved: true, workingStage: null, reviewDue: '2026-10-26' }, today)).toBe('review_overdue');
    expect(docStatus({ hasApproved: true, workingStage: 22, reviewDue: '2026-10-26' }, today)).toBe('review_overdue');
    expect(docStatus({ hasApproved: true, workingStage: null, reviewDue: today }, today)).toBe('approved');
  });
});

describe('маршрут 1.11.0 (ADR-0042)', () => {
  const as = (...r: DocRole[]) => new Set(r);
  it('кто что может в каждом месте маршрута; старшие над автором в маршруте не действуют', () => {
    expect(allowedActions(21, 'draft', as('author'))).toEqual(['submit_head']);
    expect(allowedActions(21, 'draft', as('senior', 'head'))).toEqual([]);
    expect(allowedActions(21, 'head_review', as('author', 'senior'))).toEqual([]);
    expect(allowedActions(21, 'head_review', as('head'))).toEqual(['head_approve', 'head_return']);
    expect(allowedActions(22, 'parties', as('author'))).toEqual(['request_recheck', 'to_translation']);
    expect(allowedActions(22, 'parties', as('senior', 'head'))).toEqual([]);
    expect(allowedActions(22, 'head_recheck', as('head'))).toEqual(['head_reapprove', 'recheck_return']);
    expect(allowedActions(22, 'head_recheck', as('author', 'senior'))).toEqual([]);
    expect(allowedActions(23, null, as('author'))).toEqual(['to_approval']);
    expect(allowedActions(23, null, as('senior', 'head'))).toEqual([]);
    // Этап 24 — отдельное действие «Утвердить», переходов нет; старые этапы 11–16 новый маршрут не двигает.
    expect(allowedActions(24, null, as('author', 'senior', 'head'))).toEqual([]);
    for (const st of [11, 12, 13, 14, 15, 16]) expect(allowedActions(st, null, as('author', 'senior', 'head'))).toEqual([]);
  });
  it('состояние: на 21 и 22 из колонки (нет — первое состояние этапа), на 23 и 24 — нет', () => {
    expect(stateOf({ stage: 21, routeState: null })).toBe('draft');
    expect(stateOf({ stage: 21, routeState: 'head_review' })).toBe('head_review');
    expect(stateOf({ stage: 22, routeState: null })).toBe('parties');
    expect(stateOf({ stage: 22, routeState: 'head_recheck' })).toBe('head_recheck');
    expect(stateOf({ stage: 23, routeState: 'draft' })).toBeNull();
    expect(placeName(21, 'head_review')).toBe('Драфт — На проверке у начальника ИБ');
    expect(placeName(21, 'draft')).toBe('Драфт');
    expect(placeName(22, 'parties')).toBe('Согласование');
  });
  it('перенос на 1.11.0: 11 и 12 → 21, 13 → 21 «на проверке», 14 → 22 по отметкам лиц, 15 → 23, 16 → 24; старый маршрут — через 1.2.0', () => {
    expect([11, 12].map((x) => routeV3Of(x, false))).toEqual([{ stage: 21, state: 'draft' }, { stage: 21, state: 'draft' }]);
    expect(routeV3Of(13, false)).toEqual({ stage: 21, state: 'head_review' });
    expect(routeV3Of(14, false)).toEqual({ stage: 22, state: 'parties' });
    expect(routeV3Of(14, true)).toEqual({ stage: 22, state: 'head_recheck' });
    expect(routeV3Of(15, true)).toEqual({ stage: 23, state: null });
    expect(routeV3Of(16, false)).toEqual({ stage: 24, state: null });
    expect(routeV3Of(1, false)).toEqual({ stage: 21, state: 'head_review' });
    expect(routeV3Of(21, false)).toBeNull();
  });
  it('история прежних маршрутов — с прежними подписями', () => {
    expect(ROUTE_FROM_LEGACY).toEqual({ 0: 11, 1: 13, 2: 14, 3: 14 });
    expect([0, 1, 2, 3].map(stageName)).toEqual(['Автор', 'Начальник ИБ', 'Юридический отдел', 'Утверждение правлением']);
    expect([11, 12, 13, 14, 15, 16].map(stageName)).toEqual([
      'Драфт', 'Проверка сотрудниками', 'Согласование начальника ИБ', 'Согласование с ответственными лицами', 'Перевод', 'Подписание',
    ]);
    expect([21, 22, 23, 24].map(stageName)).toEqual(['Драфт', 'Согласование', 'Перевод', 'Утверждение']);
  });
});

describe('дата пересмотра', () => {
  it('прибавляет месяцы; несуществующий день — последний день месяца', () => {
    expect(addMonthsIso('2026-10-27', 12)).toBe('2027-10-27');
    expect(addMonthsIso('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsIso('2027-01-31', 13)).toBe('2028-02-29');
    expect(addMonthsIso('2028-02-29', 12)).toBe('2029-02-28');
    expect(addMonthsIso('2026-11-30', 3)).toBe('2027-02-28');
    expect(addMonthsIso('2026-12-15', 1)).toBe('2027-01-15');
  });
});

describe('ссылка OnlyOffice', () => {
  it('только http(s) без пробелов', () => {
    expect(isDocUrl('https://office.example.local/doc/123?x=1')).toBe(true);
    expect(isDocUrl('http://10.0.0.5/products/files/doceditor.aspx?fileid=7')).toBe(true);
    expect(isDocUrl('javascript:alert(1)')).toBe(false);
    expect(isDocUrl('file:///etc/passwd')).toBe(false);
    expect(isDocUrl('https://office.local/a b')).toBe(false);
    expect(isDocUrl('office.local/doc')).toBe(false);
  });

  it('ONLYOFFICE_URL_PREFIX: тот же протокол, сервер и порт, путь с префикса', () => {
    const P = 'https://office.example.local/products/';
    expect(isDocUrl('https://office.example.local/products/files/doceditor.aspx?fileid=7', P)).toBe(true);
    expect(isDocUrl('https://OFFICE.example.local/products/x', P)).toBe(true);
    expect(isDocUrl('http://office.example.local/products/x', P)).toBe(false);
    expect(isDocUrl('https://office.example.local:8443/products/x', P)).toBe(false);
    expect(isDocUrl('https://office.example.local/other/x', P)).toBe(false);
    expect(isDocUrl('https://office.example.local.evil.tj/products/x', P)).toBe(false);
    expect(isDocUrl('https://office.example.local@evil.tj/products/x', P)).toBe(false);
    expect(isDocUrl('https://user@office.example.local/products/x', P)).toBe(false);
    // Пустой префикс — как раньше, любая http(s).
    expect(isDocUrl('http://10.0.0.5/x', '')).toBe(true);
  });

  it('префикс из .env проверяется при старте', () => {
    expect(checkDocUrlPrefix('')).toBeNull();
    expect(checkDocUrlPrefix('https://office.example.local/')).toBeNull();
    expect(checkDocUrlPrefix('ftp://office.example.local/')).toMatch(/http/);
    expect(checkDocUrlPrefix('https://office.example.local/?a=1')).toMatch(/параметров/);
    expect(checkDocUrlPrefix('office.example.local')).toMatch(/адрес/);
  });
});

describe('stageHolders — «Сейчас у» (маршрут 1.11.0)', () => {
  const owner = { id: 'o', fullName: 'Автор' };
  const head = { id: 'h', fullName: 'Начальник' };
  const chief = { id: 'c', fullName: 'Руководитель' };
  const base: HolderCtx = { owner, head, seniors: [chief] };
  const names = (stage: number, state: Parameters<typeof stageHolders>[1], c = base) => stageHolders(stage, state, c).people.map((p) => p.fullName);

  it('начальник ИБ — только «на проверке» и «на повторной проверке», остальное — автор; старшие не держат документ', () => {
    expect([names(21, 'draft'), names(22, 'parties'), names(23, null), names(24, null)]).toEqual([['Автор'], ['Автор'], ['Автор'], ['Автор']]);
    expect([names(21, 'head_review'), names(22, 'head_recheck')]).toEqual([['Начальник'], ['Начальник']]);
    expect(stageHolders(21, 'head_review', { ...base, head: null })).toEqual({ people: [], missingHead: true });
    expect(stageHolders(22, 'head_recheck', { ...base, head: null })).toEqual({ people: [], missingHead: true });
    // Старые этапы (версия 1.10.0 после отката, ещё не перенесённая) — никого.
    expect(stageHolders(13, null, base)).toEqual({ people: [], missingHead: false });
  });
});

describe('реестр: срок пересмотра и порядок', () => {
  const today = '2026-11-03';
  it('срок: прошёл, в ближайшие N дней, не позже даты; без даты пересмотра — не подходит', () => {
    expect(dueMatches('2026-11-02', today, 'overdue')).toBe(true);
    expect(dueMatches(today, today, 'overdue')).toBe(false);
    expect(dueMatches(today, today, 'd30')).toBe(true);
    expect(dueMatches('2026-12-03', today, 'd30')).toBe(true);
    expect(dueMatches('2026-12-04', today, 'd30')).toBe(false);
    expect(dueMatches('2026-11-02', today, 'd30')).toBe(false);
    expect(dueMatches('2027-01-31', today, undefined, '2027-01-31')).toBe(true);
    expect(dueMatches('2027-02-01', today, undefined, '2027-01-31')).toBe(false);
    expect(dueMatches('2026-11-10', today, 'd30', '2026-11-05')).toBe(false);
    expect(dueMatches(null, today, 'd365')).toBe(false);
    expect(dueMatches(null, today)).toBe(true);
  });
  it('по типам — сначала «Политика» (без регистра), остальные и документы внутри — по алфавиту', () => {
    const d = (number: number, title: string, type: string) => ({ number, title, type: { value: type } });
    const docs = [d(1, 'Яблоко', 'Инструкция'), d(2, 'банан', ' политика '), d(3, 'Апельсин', 'Методика'), d(4, 'Арбуз', 'Политика'), d(5, 'Арбуз', 'Политика')];
    expect([...docs].sort(docComparator('type')).map((x) => x.number)).toEqual([4, 5, 2, 1, 3]);
    expect([...docs].sort(docComparator('title')).map((x) => x.number)).toEqual([3, 4, 5, 2, 1]);
    expect(compareTypes('Аудит', 'Политика')).toBeGreaterThan(0);
  });
});

describe('задачи этапов маршрута (1.6.3, маршрут 1.11.0)', () => {
  const x = { label: '#7 «Политика ИБ»', versionNo: 3, languages: ['Английский', 'Таджикский'] };
  it('название и «что требуется» по этапу и состоянию', () => {
    expect(stageTaskText(21, 'head_review', x)).toEqual({
      title: 'Проверить: документ #7 «Политика ИБ»',
      requirement: 'проверить версию 3 по ссылке OnlyOffice: «Одобрить» или «Вернуть на доработку» с комментарием.',
    });
    expect(stageTaskText(22, 'head_recheck', x).title).toBe('Повторно проверить: документ #7 «Политика ИБ»');
    expect(stageTaskText(21, 'draft', x).title).toBe('Подготовить драфт: документ #7 «Политика ИБ»');
    expect(stageTaskText(22, 'parties', x).title).toBe('Согласовать с ответственными лицами: документ #7 «Политика ИБ»');
    expect(stageTaskText(23, null, x)).toEqual(stageTaskText(23, null, { ...x, languages: [] }));
    expect(stageTaskText(23, null, x).title).toBe('Перевести и отправить на утверждение: документ #7 «Политика ИБ»');
    expect(stageTaskText(24, null, x).title).toBe('Утвердить документ: документ #7 «Политика ИБ»');
  });
  it('описание: документ, тип, место маршрута с номером этапа, что требуется; ключ состояния и срока', () => {
    expect(stageTaskDescription({ label: x.label, type: 'Политика', stage: 21, state: 'head_review', versionNo: 3, requirement: 'проверить.' }).split('\n').slice(0, 4)).toEqual([
      'Документ: #7 «Политика ИБ»', 'Тип: Политика', 'Этап: Драфт — На проверке у начальника ИБ (1 из 4), версия 3', 'Что требуется: проверить.',
    ]);
    expect(stageState({ id: 'v', round: 2, stage: 22 }, 'head_recheck')).toBe('v:2:22:head_recheck');
    expect(stageState({ id: 'v', round: 1, stage: 23 }, null)).toBe('v:1:23');
    expect([stageDaysKey(21, 'draft'), stageDaysKey(21, 'head_review'), stageDaysKey(22, 'parties'), stageDaysKey(22, 'head_recheck'), stageDaysKey(23, null), stageDaysKey(24, null)])
      .toEqual(['21', '21h', null, '22h', '23', '24']);
  });
});
