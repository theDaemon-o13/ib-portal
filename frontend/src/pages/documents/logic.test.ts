import { describe, expect, it } from 'vitest';
import type { DocDetail } from '../../api/documents';
import { historyText, reviewLabel, stageHint, versionLabel } from './logic';

const h = (extra: Partial<DocDetail['history'][number]>): DocDetail['history'][number] => ({
  id: '1', at: '2026-10-27T05:00:00Z', actor: 'Юрист', stage: 2, stageName: 'Юридический отдел', decision: 'approved', comment: '', versionNo: 2, round: 1, ...extra,
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
