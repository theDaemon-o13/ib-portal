import { describe, expect, it } from 'vitest';
import { parseMail, type MailContext } from './mail-parse.js';
import type { WorkCalendar } from './working-days.js';

// Четверг 05.11.2026; 06.11 (пятница) — праздник, 07–08.11 — выходные.
const calendar: WorkCalendar = { weekendDays: [6, 7], days: new Map([['2026-11-06', 'holiday']]) };
const rules = [
  { id: 'access', label: 'Доступ', keywords: ['доступ', 'учётн', 'увольн', 'блокир'], ownerUserId: 'u-access' },
  { id: 'incident', label: 'Инцидент', keywords: ['фишинг', 'вложени', 'подозрит'], ownerUserId: 'u-inc' },
  { id: 'dlp', label: 'DLP', keywords: ['usb', 'флеш'], ownerUserId: null },
];
const ctx: MailContext = { today: '2026-11-05', calendar, rules };
const mail = (body: string, subject = 'Запрос') => `От: Отдел кадров <hr@example.tj>\nОтправлено: 05.11.2026 10:15\nКому: ИБ\nТема: ${subject}\n\n${body}`;
const due = (body: string, c: MailContext = ctx) => {
  const p = parseMail(mail(body), c);
  return [p.due, p.dueReason, p.urgent];
};

describe('почта → задача: заголовки', () => {
  it('«От / Тема / Отправлено», текст без заголовков, название без RE/FW', () => {
    const p = parseMail(mail('Просим заблокировать учётную запись.', 'RE: FW: Блокировка учётной записи'), ctx);
    expect([p.from, p.subject, p.sent]).toEqual(['Отдел кадров <hr@example.tj>', 'RE: FW: Блокировка учётной записи', '05.11.2026 10:15']);
    expect(p.title).toBe('Блокировка учётной записи');
    expect(p.body).toBe('Просим заблокировать учётную запись.');
  });

  it('английские заголовки; без темы — первое предложение; пусто — «Задача из письма»', () => {
    const p = parseMail('From: SOC <soc@example.tj>\nSent: Thursday\nSubject: Fwd: Suspicious login\n\nCheck it', ctx);
    expect([p.from, p.sent, p.title]).toEqual(['SOC <soc@example.tj>', 'Thursday', 'Suspicious login']);
    expect(parseMail('Проверьте права в АБС. Спасибо', ctx).title).toBe('Проверьте права в АБС');
    expect(parseMail('   ', ctx).title).toBe('Задача из письма');
  });

  it('общее снятие префиксов (1.7.0): [EXT], Отв, ВО, Re[2]; исходная тема — как есть', () => {
    const p = parseMail(mail('Текст.', '[EXT] Отв: ВО: Re[2]: Тестовая тема'), ctx);
    expect(p.title).toBe('Тестовая тема');
    expect(p.subject).toBe('[EXT] Отв: ВО: Re[2]: Тестовая тема');
    expect(parseMail(mail('Текст.', 'RE: FW:'), ctx).title).toBe('Задача из письма');
  });
});

describe('почта → задача: срок по производственному календарю', () => {
  it('«до ДД.ММ», «до ДД.ММ.ГГГГ»; дата раньше сегодня без года — следующий год; несуществующая — не срок', () => {
    expect(due('Просим до 27.11 предоставить')[0]).toBe('2026-11-27');
    expect(due('Просим до 27.11 предоставить')[1]).toBe('в письме: «до 27.11»');
    expect(due('Сдать до 05.01')[0]).toBe('2027-01-05');
    expect(due('Сдать до 05.01.2027')[0]).toBe('2027-01-05');
    expect(due('Сдать до 05/12/26')[0]).toBe('2026-12-05');
    expect(due('Сдать до 31.02')[0]).toBe('2026-11-11'); // не дата — срок по умолчанию
  });

  it('«сегодня», «завтра»; завтра — праздник: перенос через выходные на понедельник', () => {
    expect(due('Нужно сегодня')[0]).toBe('2026-11-05');
    const [d, why] = due('Ответьте завтра');
    expect(d).toBe('2026-11-09');
    expect(why).toMatch(/нерабочий день/);
    expect(due('Ответьте завтра', { ...ctx, today: '2026-11-02' })[0]).toBe('2026-11-03');
    expect(due('посмотрим завтрак')[0]).toBe('2026-11-11'); // «завтрак» — не «завтра»
  });

  it('«в течение N дней» — календарные; «в течение N рабочих дней» — через праздник и выходные', () => {
    expect(due('в течение 5 дней')[0]).toBe('2026-11-10');
    expect(due('в течение 2 рабочих дней')[0]).toBe('2026-11-10'); // 06.11 праздник, 07–08 выходные → 09, 10
    expect(due('В течении 1 рабочего дня')[0]).toBe('2026-11-09');
  });

  it('по умолчанию 3 рабочих дня: праздник и выходные не считаются', () => {
    const [d, why, urgent] = due('Просим проверить');
    expect([d, urgent]).toEqual(['2026-11-11', false]);
    expect(why).toMatch(/3 рабочих дня/);
  });

  it('«срочно» без срока — 1 рабочий день и высокий приоритет; со сроком — срок из письма', () => {
    expect(due('Срочно заблокируйте')).toEqual(['2026-11-09', '«срочно» — 1 рабочий день по производственному календарю', true]);
    expect(due('СРОЧНАЯ проверка')[2]).toBe(true);
    expect(due('ASAP please')[2]).toBe(true);
    const [d, why, urgent] = due('Срочно, до 20.11');
    expect([d, urgent]).toEqual(['2026-11-20', true]);
    expect(why).toBe('в письме: «до 20.11»; «срочно» — высокий приоритет');
    expect(due('несрочный вопрос')[2]).toBe(false);
  });
});

describe('почта → задача: категория и ответственный по правилам', () => {
  it('правило с наибольшим числом слов; «ё» = «е»; совпадения показываются', () => {
    const p = parseMail(mail('Увольнение: заблокируйте учетную запись и доступ. Подозрительное вложение', 'Увольнение'), ctx);
    expect(p.rule).toEqual({ id: 'access', label: 'Доступ', hits: ['доступ', 'учётн', 'увольн', 'блокир'], ownerUserId: 'u-access' });
  });

  it('при равенстве — первое правило по порядку справочника; без совпадений — нет правила', () => {
    expect(parseMail(mail('доступ и фишинг'), ctx).rule?.id).toBe('access');
    expect(parseMail(mail('флешка USB'), ctx).rule).toMatchObject({ id: 'dlp', ownerUserId: null });
    expect(parseMail(mail('Просто вопрос'), ctx).rule).toBeNull();
  });
});
