import { describe, expect, it } from 'vitest';
import type { DocDetail } from '../../api/documents';
import { ACTION_LABEL, approversLabel, byPersonName, isReturn, matchPerson, personKey, sameNamePeople, groupByType, historyText, holdersLabel, parseSort, reviewLabel, stageHint, versionLabel } from './logic';

const h = (extra: Partial<DocDetail['history'][number]>): DocDetail['history'][number] => ({
  id: '1', at: '2026-10-27T05:00:00Z', actor: 'Юрист', stage: 2, stageName: 'Юридический отдел', decision: 'approved', comment: '', versionNo: 2, round: 1, pdfSha256: null, toStage: null, toStageName: null, selfApproved: false, event: null, ...extra,
});

describe('документы: подписи', () => {
  it('версия: номер и редакция', () => {
    expect(versionLabel({ no: 3, edition: '3.1' })).toBe('3 · ред. 3.1');
    expect(versionLabel({ no: 1, edition: '' })).toBe('1');
  });
  it('история согласования', () => {
    expect(historyText(h({ decision: 'submitted', stage: 0 }))).toBe('отправил(а) версию 2 на согласование');
    expect(historyText(h({}))).toBe('согласовал(а) этап «Юридический отдел», версия 2');
    expect(historyText(h({ stage: 3 }))).toBe('утвердил(а) версию 2');
    expect(historyText(h({ decision: 'returned', comment: 'Нет раздела 4' }))).toBe('вернул(а) версию 2 на доработку с этапа «Юридический отдел»: Нет раздела 4');
    expect(historyText(h({ decision: 'revision_started', stage: 0, comment: '' }))).toBe('создал(а) версию 2 для пересмотра');
    expect(historyText(h({ decision: 'skipped', stage: 1, stageName: 'Начальник ИБ', comment: 'Не требуется: автор — Начальник ИБ.' })))
      .toBe('этап «Начальник ИБ» не требуется (версия 2). Не требуется: автор — Начальник ИБ.');
  });
  it('история маршрута 1.2.0', () => {
    const m = { stage: 11, stageName: 'Драфт', toStage: 12, toStageName: 'Проверка сотрудниками' };
    expect(historyText(h({ ...m, decision: 'moved' }))).toBe('перевёл(а) версию 2: «Драфт» → «Проверка сотрудниками»');
    expect(historyText(h({ decision: 'approved', stage: 13, selfApproved: true })))
      .toBe('согласовал(а) версию 2 сам(а) как автор и начальник ИБ — без независимого согласования');
    expect(historyText(h({ decision: 'approved', stage: 14 }))).toBe('ознакомлен(а) с финальной версией 2');
    expect(historyText(h({ decision: 'cancelled', stage: 13, comment: 'Не нужно' }))).toBe('отменил(а) пересмотр, версия 2 — в истории: Не нужно');
    expect(historyText(h({ decision: 'signed', stage: 16, comment: 'Подписан 20.10.2026' }))).toBe('загрузил(а) подписанную версию 2. Подписан 20.10.2026');
  });
  it('пересмотр и подпись этапа', () => {
    expect(reviewLabel({ reviewDue: null, status: 'draft' })).toBe('—');
    expect(reviewLabel({ reviewDue: '2027-10-27', status: 'approved' })).toBe('27.10.2027');
    expect(reviewLabel({ reviewDue: '2026-01-01', status: 'review_overdue' })).toBe('просрочен с 01.01.2026');
    expect(stageHint({ waitingForMe: true, stageName: 'Начальник ИБ' })).toBe('ждёт вас');
    expect(stageHint({ waitingForMe: false, stageName: 'Начальник ИБ' })).toBe('Начальник ИБ');
    expect(stageHint({ waitingForMe: false, stageName: null })).toBe('');
  });
});

describe('«Сейчас у» (1.4.0)', () => {
  it('люди через запятую; этап начальника ИБ без отметки; никого', () => {
    expect(holdersLabel({ people: [{ fullName: 'Начальник' }, { fullName: 'Руководитель' }], missingHead: false })).toBe('Начальник, Руководитель');
    expect(holdersLabel({ people: [], missingHead: true })).toBe('Начальник ИБ не назначен');
    expect(holdersLabel({ people: [], missingHead: false })).toBe('никто');
    expect(holdersLabel(null)).toBe('');
    expect(approversLabel({ approvers: [], missingHead: true })).toBe('Начальник ИБ не назначен');
    expect(approversLabel({ approvers: ['Автор'], missingHead: false })).toBe('Автор');
  });
});

describe('маршрут 1.11.0: кнопки и история', () => {
  it('возвраты — вторичные кнопки; подписи — как в backend', () => {
    expect(Object.keys(ACTION_LABEL).filter((a) => isReturn(a as keyof typeof ACTION_LABEL))).toEqual(['head_return', 'recheck_return']);
    expect(ACTION_LABEL.submit_head).toBe('Отправить на проверку начальнику ИБ');
  });
  it('решения нового маршрута — по виду (event), прежние — по decision', () => {
    expect(historyText(h({ decision: 'submitted', stage: 21, event: 'head_review_requested' }))).toBe('отправил(а) версию 2 на проверку начальнику ИБ');
    expect(historyText(h({ decision: 'approved', stage: 21, event: 'head_approved', selfApproved: true })))
      .toBe('одобрил(а) версию 2 сам(а) как автор и начальник ИБ — без независимого согласования');
    expect(historyText(h({ decision: 'approved', stage: 22, event: 'head_reapproved' }))).toBe('повторно одобрил(а) версию 2');
    expect(historyText(h({ decision: 'moved', stage: 22, event: 'unchanged_confirmed', comment: 'Автор подтвердил: документ не изменялся после проверки начальником ИБ' })))
      .toBe('отправил(а) версию 2 на перевод. Автор подтвердил: документ не изменялся после проверки начальником ИБ');
    expect(historyText(h({ decision: 'signed', stage: 24, event: 'approved_final', comment: 'Утверждён 05.11.2026' }))).toBe('утвердил(а) версию 2. Утверждён 05.11.2026');
    expect(historyText(h({ decision: 'returned', stage: 22, stageName: 'Согласование', event: 'recheck_returned', comment: 'Раздел 3' })))
      .toBe('вернул(а) версию 2 на доработку с этапа «Согласование»: Раздел 3');
  });
});

describe('документы: дерево по типам и порядок', () => {
  const d = (id: string, typeId: string) => ({ id, type: { id: typeId, value: typeId } });
  it('соседние документы одного типа — одна ветка, порядок сохраняется', () => {
    const g = groupByType([d('1', 'Политика'), d('2', 'Политика'), d('3', 'Инструкция')]);
    expect(g.map((x) => [x.type.value, x.items.map((i) => i.id)])).toEqual([['Политика', ['1', '2']], ['Инструкция', ['3']]]);
    expect(groupByType([])).toEqual([]);
  });
  it('по умолчанию — по типам', () => {
    expect([parseSort(null), parseSort('title'), parseSort('junk')]).toEqual(['type', 'title', 'type']);
  });
});

describe('справочник «Ответственные лица» (1.6.7)', () => {
  const p = (id: string, fullName: string, position: string) => ({ id, fullName, position });
  it('тот же человек — ФИО и должность без учёта регистра и пробелов; однофамилец с другой должностью — другой', () => {
    expect(personKey(' иванов  И.И.', 'ТЕХНИЧЕСКИЙ директор')).toBe(personKey('Иванов И.И.', 'Технический директор'));
    expect(personKey('Иванов И.И.', 'Главный бухгалтер')).not.toBe(personKey('Иванов И.И.', 'Технический директор'));
  });
  it('«ё» и «е» — одна буква, как на сервере (1.13.5); поиск тоже', () => {
    expect(personKey('Королёв П.Ё.', 'Начальник отдела учёта')).toBe(personKey('королев п.е.', 'НАЧАЛЬНИК ОТДЕЛА УЧЕТА'));
    expect(matchPerson(p('1', 'Королёв П.П.', 'Главный бухгалтер'), 'королев')).toBe(true);
  });
  it('поиск — по ФИО и должности, все слова запроса', () => {
    const a = p('1', 'Иванов И.И.', 'Технический директор');
    expect(matchPerson(a, 'иван')).toBe(true);
    expect(matchPerson(a, 'технич')).toBe(true);
    expect(matchPerson(a, 'иван директор')).toBe(true);
    expect(matchPerson(a, 'петров')).toBe(false);
    expect(matchPerson(a, '  ')).toBe(true);
  });
  it('сортировка по ФИО по-русски; однофамильцы — предупреждение', () => {
    const list = [p('1', 'Сидорова С.С.', ''), p('2', 'Иванов И.И.', 'Технический директор'), p('3', 'Иванов И.И.', 'Главный бухгалтер')];
    expect([...list].sort(byPersonName).map((x) => x.id)).toEqual(['3', '2', '1']);
    expect(sameNamePeople(list, ' иванов и.и. ').map((x) => x.id)).toEqual(['2', '3']);
    expect(sameNamePeople(list, 'Иванов И.И.', '2').map((x) => x.id)).toEqual(['3']);
    expect(sameNamePeople(list, '')).toEqual([]);
  });
});
