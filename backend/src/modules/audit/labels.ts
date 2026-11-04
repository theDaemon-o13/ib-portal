// Подписи раздела «Журнал» (ADR-0021): русские названия действий и разделов для фильтров, таблицы и Excel.
// Коды действий в audit_log не меняются — меняется только подпись. Неизвестный код показывается как есть.

/** Разделы портала по entity записи журнала. */
export const ENTITY_LABELS: Record<string, string> = {
  session: 'Вход и сессии',
  user: 'Пользователи',
  role: 'Роли и права',
  catalog_item: 'Справочники',
  calendar_day: 'Производственный календарь',
  work_week: 'Производственный календарь',
  form_template: 'Шаблоны форм',
  form_template_field: 'Шаблоны форм',
  register: 'Реестры',
  register_field: 'Реестры: поля',
  register_option: 'Реестры: значения списков',
  register_automation: 'Реестры: автоматизации',
  register_import: 'Реестры: импорт',
  scan_report: 'Реестры: отчёты сканера',
  register_record: 'Записи реестров',
  task: 'Задачи',
  task_chain: 'Задачи: цепочки',
  document: 'Документы',
  evidence: 'Доказательства',
  file: 'Файлы',
  dashboard_tile: 'Дашборд',
  dashboard_layout: 'Дашборд',
  monitor_slide: 'Экран мониторинга',
  audit: 'Журнал',
  notification: 'Уведомления',
  assessment: 'Самооценка',
  assessment_methodology: 'Самооценка',
  presentation: 'Презентация самооценки',
};

/** Разделы настроек: прежняя вкладка «Настройки → Журнал изменений» — пункт фильтра «Настройки — всё». */
export const SETTINGS_ENTITIES = ['user', 'role', 'catalog_item', 'calendar_day', 'work_week', 'form_template', 'form_template_field', 'presentation'] as const;

/** Действия, у которых подпись не выводится из кода по общему правилу. */
const ACTION_LABELS: Record<string, string> = {
  'assessment.created': 'Самооценка создана',
  'assessment.updated': 'Самооценка: шапка и профиль',
  'assessment.answer_updated': 'Самооценка: ответ раздела',
  'assessment.finalized': 'Самооценка зафиксирована',
  'assessment.reopened': 'Самооценка возвращена в черновик',
  'assessment.archived': 'Самооценка в архиве',
  'assessment.task_linked': 'Самооценка: задача по разделу',
  'assessment.imported': 'Самооценка: импорт из Excel',
  'assessment.exported': 'Самооценка: выгрузка в Excel',
  'assessment.methodology_loaded': 'Самооценка: загружена методика',
  'auth.login': 'Вход',
  'auth.logout': 'Выход',
  'auth.login_failed': 'Неудачный вход',
  'auth.locked': 'Вход заблокирован после неудачных попыток',
  'auth.password_changed': 'Смена пароля',
  'auth.password_change_failed': 'Неудачная смена пароля',
  'auth.session_expired': 'Сессия завершена по бездействию',
  'auth.admin_ip_denied': 'Вход администратора с неразрешённого адреса',
  'auth.kiosk_ip_denied': 'Вход монитора с неразрешённого адреса',
  'user.password_reset': 'Пароль сброшен',
  'user.unlocked': 'Блокировка входа снята',
  'user.enabled': 'Пользователь включён',
  'user.disabled': 'Пользователь отключён',
  'user.ib_head.set': 'Отмечен начальник ИБ',
  'user.ib_head.cleared': 'Снята отметка «Начальник ИБ»',
  'user.ib_head.transferred': 'Отметка «Начальник ИБ» передана',
  'role.permission.granted': 'Право выдано роли',
  'role.permission.revoked': 'Право снято с роли',
  'catalog.item_made_system': 'Значение стало системным',
  'calendar.week.updated': 'Изменены выходные дни недели',
  'settings.presentation.updated': 'Изменена подпись презентации самооценки',
  'automation.run': 'Запуск автоматизаций',
  'automation.skipped': 'Запуск автоматизаций пропущен',
  'automation.runs_cleared': 'Журнал запусков очищен',
  'automation_event.processed': 'Событие автоматизации обработано',
  'register.field.type_changed': 'Изменён тип поля',
  'register.import.previewed': 'Предпросмотр импорта Excel',
  'register.import.applied': 'Импорт Excel применён',
  'register.import.cancelled': 'Импорт Excel отменён',
  'register.scan.previewed': 'Предпросмотр отчёта сканера',
  'register.scan.applied': 'Отчёт сканера загружен',
  'register.compare.run': 'Сравнение с реестром',
  'register.exported_zip': 'Выгрузка для проверки (zip)',
  'register_record.decision_added': 'Добавлено решение другого отдела',
  'register_records.bulk_archive': 'Записи отправлены в архив (выбранные)',
  'register_records.bulk_restore': 'Записи возвращены из архива (выбранные)',
  'register_records.bulk_delete': 'Записи удалены (выбранные)',
  'register_records.compare_status': 'Статус по результату сравнения',
  'tasks.bulk_archive': 'Задачи отправлены в архив (выбранные)',
  'tasks.bulk_delete': 'Задачи удалены (выбранные)',
  'tasks.report_exported': 'Отчёт по задачам выгружен в Excel',
  'notifications.cleaned': 'Удалены старые уведомления',
  'task.commented': 'Комментарий к задаче',
  'task.transition': 'Задача: переход между колонками',
  'task.reviewer_replaced': 'Задача: проверяющий заменён',
  'task.chain_linked': 'Задача добавлена в цепочку',
  'task.chain_unlinked': 'Задача отвязана от цепочки',
  'task.chain_moved': 'Задача перенесена в другую цепочку',
  'task_chain.closed': 'Цепочка задач закрыта',
  'task_chain.reopened': 'Цепочка задач открыта заново',
  'task_chain.discovered': 'Цепочки найдены среди старых задач',
  'tasks.reviewers_assigned': 'Проверяющие назначены задачам на проверке (обновление 1.4.0)',
  'document.submitted': 'Документ отправлен на согласование',
  'document.approved_stage': 'Этап документа согласован',
  'document.approved': 'Документ утверждён',
  'document.returned': 'Документ возвращён на доработку',
  'document.stage_skipped': 'Этап документа не требуется',
  'document.revision_started': 'Начата новая версия документа',
  'document.pdf_attached': 'Приложен итоговый PDF',
  'document.review_check': 'Проверка сроков пересмотра',
  'evidence.expiry_check': 'Проверка сроков доказательств',
  'evidence.accepted': 'Доказательство принято',
  'evidence.rejected': 'Доказательство отклонено',
  'evidence.files_added': 'К доказательству добавлены файлы',
  'evidence.file_removed': 'Из доказательства убран файл',
  'file.downloaded': 'Файл скачан',
  'file.uploaded': 'Файл загружен',
  'file.orphan_deleted': 'Непривязанный файл помечен удалённым',
  'dashboard.layout.saved': 'Раскладка дашборда сохранена',
  'dashboard.layout.reset': 'Раскладка дашборда сброшена',
  'dashboard.role_layout.saved': 'Раскладка роли сохранена',
  'dashboard.role_layout.reset': 'Раскладка роли сброшена',
  'audit.exported': 'Журнал выгружен в Excel',
};

type Gender = 'm' | 'f' | 'n';

/** Объект по первой части кода действия: «task.created» → «Задача создана». */
const SUBJECTS: [prefix: string, subject: string, gender: Gender][] = [
  ['register.automation.', 'Автоматизация', 'f'],
  ['register.field.', 'Поле реестра', 'n'],
  ['register.option.', 'Значение списка', 'n'],
  ['register.scan.', 'Отчёт сканера', 'm'],
  ['register_record.', 'Запись реестра', 'f'],
  ['register.', 'Реестр', 'm'],
  ['form_template.field.', 'Поле шаблона', 'n'],
  ['form_template.', 'Шаблон формы', 'm'],
  ['catalog.item.', 'Значение справочника', 'n'],
  ['calendar.day.', 'День календаря', 'm'],
  ['monitor.slide.', 'Слайд мониторинга', 'm'],
  ['dashboard.tile.', 'Плитка дашборда', 'f'],
  ['task_chain.', 'Цепочка задач', 'f'],
  ['task.', 'Задача', 'f'],
  ['document.', 'Документ', 'm'],
  ['evidence.', 'Доказательство', 'n'],
  ['file.', 'Файл', 'm'],
  ['user.', 'Пользователь', 'm'],
  ['role.', 'Роль', 'f'],
];

const VERBS: Record<string, Record<Gender, string>> = {
  created: { m: 'создан', f: 'создана', n: 'создано' },
  updated: { m: 'изменён', f: 'изменена', n: 'изменено' },
  deleted: { m: 'удалён', f: 'удалена', n: 'удалено' },
  archived: { m: 'отправлен в архив', f: 'отправлена в архив', n: 'отправлено в архив' },
  restored: { m: 'возвращён из архива', f: 'возвращена из архива', n: 'возвращено из архива' },
  moved: { m: 'перемещён', f: 'перемещена', n: 'перемещено' },
};

export function actionLabel(action: string): string {
  const fixed = ACTION_LABELS[action];
  if (fixed) return fixed;
  const verb = VERBS[action.slice(action.lastIndexOf('.') + 1)];
  const subject = SUBJECTS.find(([p]) => action.startsWith(p));
  if (verb && subject) return `${subject[1]} ${verb[subject[2]]}`;
  return action;
}

export function entityLabel(entity: string | null): string {
  if (!entity) return '—';
  return ENTITY_LABELS[entity] ?? entity;
}
