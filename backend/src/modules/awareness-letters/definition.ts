// Системные объекты учебных писем (1.9.0; docs/specs/awareness.md, разделы 11, 17.3, 18): реестр «Рассылки»,
// фрагмент «Подпись ИБ», категория задач. Поля находят по ключу (systemKey), не по названию.
// Данных банка нет: подпись в seed — заглушка, её правят в «Настройки → Подпись ИБ».
import type { AwarenessFieldSpec } from '../awareness/definition.js';

export const AWARENESS_MAILINGS_KEY = 'awareness_mailings';
export const MAILINGS_NAME = 'Рассылки';

/** Категория задач модуля (системное значение справочника task_categories). */
export const AWARENESS_CATEGORY_KEY = 'awareness';

export const MAILING_KIND = { planned: 'Плановое', urgent: 'Срочное' } as const;
/** «Согласование» в «Рассылках»: виден в выгрузке руководству и проверяющим (решение владельца 05.11.2026). */
export const MAILING_APPROVAL = { approved: 'Согласовано', self: 'Без независимого согласования', none: 'Без согласования' } as const;
export type MailingApproval = keyof typeof MAILING_APPROVAL;

export const MAILING_FIELDS: AwarenessFieldSpec[] = [
  { key: 'sentOn', label: 'Дата отправки', type: 'date', analyticsRole: 'date' },
  { key: 'letter', label: 'Письмо', type: 'text', hint: '«№ 12, версия 3» — ссылка на карточку учебного письма; ставит отметка «Отправлено»' },
  { key: 'subject', label: 'Тема', type: 'text', isTitle: true },
  {
    key: 'kind', label: 'Тип', type: 'select', analyticsRole: 'dimension',
    options: [{ label: MAILING_KIND.planned, key: 'planned' }, { label: MAILING_KIND.urgent, key: 'urgent' }],
  },
  { key: 'reason', label: 'Повод', type: 'text' },
  { key: 'audience', label: 'Аудитория', type: 'text', analyticsRole: 'dimension', hint: '«Все сотрудники» или подразделения через запятую' },
  { key: 'preparedBy', label: 'Подготовил', type: 'user' },
  { key: 'task', label: 'Задача', type: 'text', hint: '«Задача #123», если письмо было по задаче' },
  {
    key: 'approval', label: 'Согласование', type: 'select', analyticsRole: 'dimension',
    hint: 'Ставит отметка «Отправлено»; в истории прошлых рассылок — необязательно',
    options: [
      { label: MAILING_APPROVAL.approved, key: 'approved' },
      { label: MAILING_APPROVAL.self, key: 'self' },
      { label: MAILING_APPROVAL.none, key: 'none' },
    ],
  },
];

export const SIGNATURE_CODE = 'signature';
/** Заглушка «Подписи ИБ»: настоящий текст и контакты вводят на портале. */
export const SIGNATURE_PLACEHOLDER = {
  htmlRu: '<p>Отдел информационной безопасности</p>',
  htmlTj: '<p>Шуъбаи амнияти иттилоотӣ</p>',
} as const;
