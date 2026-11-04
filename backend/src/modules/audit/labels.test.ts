import { describe, expect, it } from 'vitest';
import { actionLabel, entityLabel } from './labels.js';
import { sanitizeDiff } from './service.js';

// Все коды действий, которые пишет код на 1.2.0 (включая собираемые из частей: evidence.*, tasks.bulk_*, register_records.bulk_*).
const ACTIONS = `auth.admin_ip_denied auth.kiosk_ip_denied auth.locked auth.login_failed auth.login auth.logout auth.password_change_failed
auth.password_changed auth.session_expired automation.run automation.runs_cleared automation.skipped automation_event.processed
calendar.day.created calendar.day.deleted calendar.day.updated calendar.week.updated catalog.item_made_system catalog.item.created
catalog.item.deleted catalog.item.updated catalog.item.archived catalog.item.restored dashboard.layout.reset dashboard.layout.saved
dashboard.role_layout.reset dashboard.role_layout.saved dashboard.tile.created dashboard.tile.deleted dashboard.tile.updated
document.approved_stage document.approved document.created document.pdf_attached document.returned document.review_check
document.revision_started document.stage_skipped document.submitted document.updated document.archived document.restored
evidence.expiry_check evidence.accepted evidence.created evidence.file_removed evidence.files_added evidence.rejected evidence.updated
evidence.archived evidence.restored file.deleted file.downloaded file.orphan_deleted file.uploaded
form_template.created form_template.deleted form_template.field.created form_template.field.deleted form_template.field.moved
form_template.field.updated form_template.updated form_template.archived form_template.restored monitor.slide.created
monitor.slide.deleted monitor.slide.moved monitor.slide.updated register_record.archived register_record.created
register_record.decision_added register_record.deleted register_record.restored register_record.updated register_records.bulk_archive
register_records.bulk_restore register_records.bulk_delete register_records.compare_status register.automation.created
register.automation.deleted register.automation.updated register.automation.archived register.automation.restored register.compare.run
register.created register.exported_zip register.field.created register.field.deleted register.field.moved register.field.type_changed
register.field.updated register.field.archived register.field.restored register.import.applied register.import.cancelled
register.import.previewed register.option.created register.option.deleted register.option.moved register.option.updated
register.option.archived register.option.restored register.scan.applied register.scan.previewed register.scan.archived
register.scan.restored register.updated register.archived register.restored role.created role.deleted role.permission.granted
role.permission.revoked role.updated task.archived task.restored task.commented task.created task.deleted task.transition task.reviewer_replaced task.updated
task.chain_linked task.chain_unlinked task.chain_moved task_chain.created task_chain.updated task_chain.closed task_chain.reopened
task_chain.deleted task_chain.discovered
tasks.bulk_archive tasks.reviewers_assigned tasks.bulk_delete tasks.report_exported notifications.cleaned user.created user.password_reset user.unlocked user.updated user.enabled user.disabled
user.ib_head.set user.ib_head.cleared user.ib_head.transferred
audit.exported`.split(/\s+/);

describe('подписи журнала', () => {
  it('у каждого действия — русская подпись, а не код', () => {
    const missing = ACTIONS.filter((a) => actionLabel(a) === a || /^[a-z_.]+$/.test(actionLabel(a)));
    expect(missing).toEqual([]);
  });

  it('род согласуется: «Задача создана», «Поле реестра удалено», «Документ отправлен в архив»', () => {
    expect(actionLabel('task.created')).toBe('Задача создана');
    expect(actionLabel('register.field.deleted')).toBe('Поле реестра удалено');
    expect(actionLabel('document.archived')).toBe('Документ отправлен в архив');
  });

  it('неизвестный код и раздел показываются как есть', () => {
    expect(actionLabel('new.thing')).toBe('new.thing');
    expect(entityLabel('mystery')).toBe('mystery');
    expect(entityLabel(null)).toBe('—');
  });
});

describe('подробности записи: защита в глубину', () => {
  it('вырезает ключи с паролями, хешами, токенами и секретами на любой глубине', () => {
    expect(sanitizeDiff({
      summary: 'ok', password: 'x', newPasswordHash: 'y',
      after: { token: 't', nested: [{ clientSecret: 's', keep: 1 }], login: 'l' },
    })).toEqual({ summary: 'ok', after: { nested: [{ keep: 1 }], login: 'l' } });
  });
});
