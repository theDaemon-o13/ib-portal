// «Почта → задача» (CLAUDE.md, раздел 7, п. 9): разбор вставленного текста письма в черновик задачи.
// Чистые функции без БД: правила разбора почты и производственный календарь передаются снаружи.
import { addWorkingDays, isoDate, onOrNextWorkingDay, parseIsoDate, type WorkCalendar } from './working-days.js';
import { addDays, isIsoDate } from './register-values.js';

export interface MailRule {
  id: string;
  label: string;
  keywords: readonly string[];
  ownerUserId: string | null;
}

export interface MailContext {
  /** Сегодня 'YYYY-MM-DD' по часовому поясу портала. */
  today: string;
  calendar: WorkCalendar;
  /** Правила в порядке справочника: при равном числе совпадений побеждает первое. */
  rules: readonly MailRule[];
}

export interface ParsedMail {
  from: string;
  subject: string;
  sent: string;
  body: string;
  title: string;
  due: string;
  /** Почему такой срок — показывается в черновике и сохраняется с письмом. */
  dueReason: string;
  urgent: boolean;
  rule: { id: string; label: string; hits: string[]; ownerUserId: string | null } | null;
}

export const DEFAULT_WORKDAYS = 3;
export const TITLE_MAX = 140;

const HEADER = {
  from: /^(?:от|from|отправитель)\s*:\s*(.+)$/im,
  subject: /^(?:тема|subject)\s*:\s*(.+)$/im,
  sent: /^(?:отправлено|дата|date|sent)\s*:\s*(.+)$/im,
};
const HEADER_LINE = /^(?:от|from|отправитель|тема|subject|отправлено|дата|date|sent|кому|to|копия|cc)\s*:/i;
const REPLY_PREFIX = /^(?:(?:re|fw|fwd|ответ|пересл\.?|переслать)\s*:\s*)+/i;
/** Слово целиком: \b в JS не работает с кириллицей. */
const word = (w: string) => new RegExp(`(?:^|[^а-яёa-z0-9])${w}(?:[^а-яёa-z0-9]|$)`, 'i');
const URGENT = /(?:^|[^а-яё])(?:срочн\S*|немедленно|безотлагательно)|(?:^|[^a-z])(?:asap|urgent)(?:[^a-z]|$)/i;

const header = (raw: string, re: RegExp) => re.exec(raw)?.[1]?.trim() ?? '';

/** «до 27.10», «до 27.10.2026», «до 05/01/27»; без года — ближайшая такая дата не раньше сегодня. */
function untilDate(text: string, today: string): { iso: string; quote: string } | null {
  const re = /(?:^|[^а-яё])до\s+(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?/gi;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const [d, mo] = [Number(m[1]), Number(m[2])];
    let y = m[3] ? Number(m[3]) : Number(today.slice(0, 4));
    if (m[3] && y < 100) y += 2000;
    const iso = (yy: number) => `${yy}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (!isIsoDate(iso(y))) continue;
    // «до 05.01» в октябре — это январь следующего года.
    if (!m[3] && iso(y) < today && isIsoDate(iso(y + 1))) y += 1;
    return { iso: iso(y), quote: m[0].replace(/^[^д]*/i, '').trim() };
  }
  return null;
}

function bestRule(text: string, rules: readonly MailRule[]): ParsedMail['rule'] {
  let best: ParsedMail['rule'] = null;
  for (const r of rules) {
    const hits = r.keywords.filter((k) => k && text.includes(k.toLowerCase().replace(/ё/g, 'е')));
    if (hits.length && (!best || hits.length > best.hits.length)) best = { id: r.id, label: r.label, hits, ownerUserId: r.ownerUserId };
  }
  return best;
}

export function parseMail(raw: string, ctx: MailContext): ParsedMail {
  const text0 = raw.replace(/\r\n?/g, '\n');
  const from = header(text0, HEADER.from);
  const subject = header(text0, HEADER.subject);
  const sent = header(text0, HEADER.sent);
  const body = text0.split('\n').filter((l) => !HEADER_LINE.test(l.trim())).join('\n').trim();
  const firstSentence = body.split(/[.!?\n]/).map((s) => s.trim()).find(Boolean) ?? '';
  const title = ((subject || firstSentence).replace(REPLY_PREFIX, '').trim() || 'Задача из письма').slice(0, TITLE_MAX);

  // Ключевые слова и сроки ищутся в теме и тексте; «ё» и «е» не различаются.
  const text = `${subject}\n${body}`.toLowerCase().replace(/ё/g, 'е');
  const today = parseIsoDate(ctx.today);
  const work = (n: number) => isoDate(addWorkingDays(today, n, ctx.calendar));

  let due: string;
  let dueReason: string;
  let explicit = true;
  const until = untilDate(text, ctx.today);
  const within = /(?:^|[^а-я])в\s+течени[ие]\s+(\d{1,3})\s*(рабоч\S*\s+)?(?:дн\S*|день|суток)/i.exec(text);
  if (until) {
    due = until.iso;
    dueReason = `в письме: «${until.quote}»`;
  } else if (word('сегодня').test(text)) {
    due = ctx.today;
    dueReason = 'в письме: «сегодня»';
  } else if (word('завтра').test(text)) {
    // Завтра — выходной или праздник: срок на ближайший рабочий день.
    const tomorrow = addDays(ctx.today, 1);
    due = isoDate(onOrNextWorkingDay(parseIsoDate(tomorrow), ctx.calendar));
    dueReason = due === tomorrow ? 'в письме: «завтра»' : 'в письме: «завтра» — нерабочий день, перенос на ближайший рабочий';
  } else if (within) {
    const n = Number(within[1]);
    due = within[2] ? work(n) : addDays(ctx.today, n);
    dueReason = `в письме: «${within[0].replace(/^[^в]*/i, '').trim()}»${within[2] ? ' — по производственному календарю' : ''}`;
  } else {
    explicit = false;
    due = work(DEFAULT_WORKDAYS);
    dueReason = `срок в письме не найден — ${DEFAULT_WORKDAYS} рабочих дня по производственному календарю`;
  }
  const urgent = URGENT.test(text);
  if (urgent && !explicit) {
    due = work(1);
    dueReason = '«срочно» — 1 рабочий день по производственному календарю';
  } else if (urgent) {
    dueReason += '; «срочно» — высокий приоритет';
  }
  return { from, subject, sent, body, title, due, dueReason, urgent, rule: bestRule(text, ctx.rules) };
}
