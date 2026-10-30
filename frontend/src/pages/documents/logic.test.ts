import { describe, expect, it } from 'vitest';
import type { DocDetail } from '../../api/documents';
import { historyText, reviewLabel, stageHint, versionLabel } from './logic';

const h = (extra: Partial<DocDetail['history'][number]>): DocDetail['history'][number] => ({
  id: '1', at: '2026-10-27T05:00:00Z', actor: 'Юрист', stage: 2, stageName: 'Юридический отдел', decision: 'approved', comment: '', versionNo: 2, round: 1, pdfSha256: null, toStage: null, toStageName: null, selfApproved: false, ...extra,
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
