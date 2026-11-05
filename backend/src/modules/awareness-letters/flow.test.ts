import { describe, expect, it } from 'vitest';
import { AppError } from '../../lib/errors.js';
import { approve, assertEditable, checkLanguages, langFill, markSent, returnForRework, submit, withdraw, type LetterState } from './flow.js';
import { SIGNATURE_BLOCK } from './variables.js';

const AUTHOR = 'author';
const HEAD = { id: 'head', isIbHead: true };
const s = (o: Partial<LetterState> = {}): LetterState => ({
  status: 'draft', kind: 'planned', frozen: false, archived: false, createdBy: AUTHOR, submittedBy: null, latestIsApproved: true, ...o,
});
const both = { subjectRu: 'Тема', subjectTj: 'Мавзӯъ', htmlRu: '<p>Текст</p>', htmlTj: '<p>Матн</p>' };
const onlyRu = { ...both, subjectTj: '', htmlTj: '' };
const TODAY = '2026-11-05';

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return `${e.statusCode} ${e.code}`;
    throw e;
  }
  return 'ok';
}

describe('языки (ответ 9)', () => {
  it('язык заполнен, если есть и тема, и текст; подпись одна — не текст; изображение — текст', () => {
    expect(langFill('Тема', '<p>Текст</p>')).toBe('full');
    expect(langFill('Тема', `<p></p>${SIGNATURE_BLOCK}`)).toBe('half');
    expect(langFill('', '<p><img src="data:image/png;base64,x" /></p>')).toBe('half');
    expect(langFill(' ', '<p> </p>')).toBe('empty');
  });

  it('плановому — оба языка; срочному — один, с пометкой «только RU/TJ»; половина языка — ошибка', () => {
    expect(checkLanguages('planned', both)).toBeNull();
    expect(code(() => checkLanguages('planned', onlyRu))).toBe('400 LANG_REQUIRED');
    expect(checkLanguages('urgent', onlyRu)).toBe('only_ru');
    expect(checkLanguages('urgent', { ...both, subjectRu: '', htmlRu: '' })).toBe('only_tj');
    expect(checkLanguages('urgent', both)).toBeNull();
    expect(code(() => checkLanguages('urgent', { ...onlyRu, subjectTj: 'Мавзӯъ' }))).toBe('400 LANG_REQUIRED');
    expect(code(() => checkLanguages('urgent', { subjectRu: '', subjectTj: '', htmlRu: '', htmlTj: '' }))).toBe('400 LANG_REQUIRED');
  });
});

describe('правка и заморозка', () => {
  it('черновик правится; на согласовании — нет; утверждённое — только с подтверждением, утверждение снимается', () => {
    expect(assertEditable(s())).toEqual({ dropsApproval: false });
    expect(code(() => assertEditable(s({ status: 'review' })))).toBe('409 LETTER_STATE');
    expect(code(() => assertEditable(s({ status: 'approved' })))).toBe('409 APPROVAL_DROP_CONFIRM');
    expect(assertEditable(s({ status: 'approved' }), true)).toEqual({ dropsApproval: true });
  });

  it('отправленное заморожено: правка, согласование, утверждение, возврат — LETTER_FROZEN', () => {
    const sent = s({ status: 'sent', frozen: true });
    expect(code(() => assertEditable(sent, true))).toBe('409 LETTER_FROZEN');
    expect(code(() => submit(sent, both, []))).toBe('409 LETTER_FROZEN');
    expect(code(() => approve(sent, HEAD, false))).toBe('409 LETTER_FROZEN');
    expect(code(() => returnForRework(sent, HEAD, 'x'))).toBe('409 LETTER_FROZEN');
    expect(code(() => withdraw(sent, { id: AUTHOR, isIbHead: false }))).toBe('409 LETTER_FROZEN');
  });

  it('архивное письмо не правится и не отправляется на согласование', () => {
    expect(code(() => assertEditable(s({ archived: true })))).toBe('409 LETTER_ARCHIVED');
    expect(code(() => submit(s({ archived: true }), both, []))).toBe('409 LETTER_ARCHIVED');
  });
});

describe('согласование', () => {
  it('на согласование — только черновик, без незаполненных переменных', () => {
    expect(submit(s(), both, [])).toEqual({ langMark: null });
    expect(code(() => submit(s({ status: 'approved' }), both, []))).toBe('409 LETTER_STATE');
    expect(code(() => submit(s(), both, ['дата']))).toBe('400 UNFILLED_VARIABLES');
    expect(code(() => submit(s(), onlyRu, []))).toBe('400 LANG_REQUIRED');
    expect(submit(s({ kind: 'urgent' }), onlyRu, [])).toEqual({ langMark: 'only_ru' });
  });

  it('отозвать — отправивший или автор', () => {
    const r = s({ status: 'review', submittedBy: 'colleague' });
    expect(code(() => withdraw(r, { id: 'colleague', isIbHead: false }))).toBe('ok');
    expect(code(() => withdraw(r, { id: AUTHOR, isIbHead: false }))).toBe('ok');
    expect(code(() => withdraw(r, { id: 'other', isIbHead: true }))).toBe('403 LETTER_FORBIDDEN');
  });

  it('утверждает и возвращает только начальник ИБ; своё письмо — self_approved', () => {
    const r = s({ status: 'review' });
    expect(code(() => approve(r, { id: 'x', isIbHead: false }, false))).toBe('403 NOT_IB_HEAD');
    expect(approve(r, HEAD, false)).toEqual({ selfApproved: false });
    // Автор по createdBy не решает: решает участие (считает сервис).
    expect(approve(s({ status: 'review', createdBy: HEAD.id }), HEAD, false)).toEqual({ selfApproved: false });
    expect(approve(r, HEAD, true)).toEqual({ selfApproved: true });
    expect(code(() => approve(s(), HEAD, false))).toBe('409 LETTER_STATE');
  });

  it('возврат — с обязательным комментарием', () => {
    const r = s({ status: 'review' });
    expect(code(() => returnForRework(r, HEAD, '   '))).toBe('400 COMMENT_REQUIRED');
    expect(code(() => returnForRework(r, { id: 'x', isIbHead: false }, 'причина'))).toBe('403 NOT_IB_HEAD');
    expect(returnForRework(r, HEAD, '  Уточнить повод ')).toEqual({ comment: 'Уточнить повод' });
  });
});

describe('«Отметить отправленным»', () => {
  const input = { sentOn: '2026-11-05', audience: '  Все   сотрудники ' };

  it('утверждённое: первая отметка замораживает; после правки утверждённой версии — нельзя', () => {
    expect(markSent(s({ status: 'approved' }), input, TODAY))
      .toEqual({ firstSend: true, withoutApproval: false, sentOn: '2026-11-05', audience: 'Все сотрудники', comment: '' });
    expect(code(() => markSent(s({ status: 'approved', latestIsApproved: false }), input, TODAY))).toBe('409 LETTER_STATE');
  });

  it('плановое без утверждения — нельзя; срочное — можно с комментарием', () => {
    expect(code(() => markSent(s(), input, TODAY))).toBe('409 NOT_APPROVED');
    expect(code(() => markSent(s({ kind: 'urgent' }), input, TODAY))).toBe('400 COMMENT_REQUIRED');
    expect(markSent(s({ kind: 'urgent', status: 'review' }), { ...input, comment: 'Отправлено без согласования: атака идёт сейчас' }, TODAY))
      .toMatchObject({ firstSend: true, withoutApproval: true });
  });

  it('повторная отметка отправленного — новая запись, без заморозки заново', () => {
    expect(markSent(s({ status: 'sent', frozen: true }), { sentOn: '2026-11-04', audience: 'Филиал' }, TODAY))
      .toEqual({ firstSend: false, withoutApproval: false, sentOn: '2026-11-04', audience: 'Филиал', comment: '' });
  });

  it('дата не позже сегодня и существует; аудитория обязательна; архив — нельзя', () => {
    expect(code(() => markSent(s({ status: 'approved' }), { ...input, sentOn: '2026-11-06' }, TODAY))).toBe('400 BAD_DATE');
    expect(code(() => markSent(s({ status: 'approved' }), { ...input, sentOn: '2026-02-30' }, TODAY))).toBe('400 BAD_DATE');
    expect(code(() => markSent(s({ status: 'approved' }), { ...input, audience: ' ' }, TODAY))).toBe('400 AUDIENCE_REQUIRED');
    expect(code(() => markSent(s({ status: 'approved', archived: true }), input, TODAY))).toBe('409 LETTER_ARCHIVED');
  });
});
