import { describe, expect, it } from 'vitest';
import { actorFor, expectCode, inTx, makeUser, must } from '../../test/db.js';
import { vulnRegister } from '../../test/vulns-fixture.js';
import * as records from '../registers/records.service.js';
import * as tasks from '../tasks/service.js';
import * as slides from './slides.service.js';

// Релиз 1.1.0, задача 6: слайды мониторинга — набор, порядок, фильтры, пустой слайд.

const input = (over: Partial<slides.SlideInput> = {}): slides.SlideInput => ({
  kind: 'tasks', title: 'Просроченные задачи', seconds: 5, filter: { period: 'overdue' }, enabled: true, skipEmpty: false, ...over,
});

describe('слайды мониторинга', () => {
  it('seed: 6 слайдов прежнего экрана по порядку; экран отдаёт включённые с данными и подписью набора', () =>
    inTx(async (tx) => {
      const list = await slides.listSlides(tx);
      expect(list.map((s) => s.kind)).toEqual(['kpis', 'vulns', 'tasks', 'documents', 'risks', 'evidence']);
      expect(list.every((s) => s.seconds === 12 && s.enabled)).toBe(true);
      const screen = await slides.monitorScreen(tx);
      expect(screen.slides).toHaveLength(6);
      expect(screen.slides[0]?.data).toMatchObject({ kind: 'kpis' });
      expect((screen.slides[0]?.data as { items: unknown[] }).items).toHaveLength(slides.WALL_KPIS.length);
      expect(screen.signature).toContain(must(list[0]).id);
    }));

  it('добавить, изменить с версией, порядок, выключить и удалить (мягко); журнал; подпись набора меняется', () =>
    inTx(async (tx) => {
      const admin = await makeUser(tx, ['super_admin', 'ib_staff']);
      const actor = await actorFor(tx, admin.id);
      const before = (await slides.monitorScreen(tx)).signature;
      await expectCode(slides.createSlide(tx, actor, input({ seconds: 4 })), 'BAD_SLIDE');
      await expectCode(slides.createSlide(tx, actor, input({ filter: { period: 'within', days: 0 } })), 'BAD_SLIDE');
      await expectCode(slides.createSlide(tx, actor, input({ kind: 'dlp', filter: {} })), 'BAD_SLIDE');
      const s = await slides.createSlide(tx, actor, input());
      expect(s.sortOrder).toBe(7);
      expect((await slides.monitorScreen(tx)).signature).not.toBe(before);

      const moved = await slides.moveSlide(tx, actor, s.id, 'up');
      expect(moved.map((x) => x.id).indexOf(s.id)).toBe(5);
      const cur = must(moved.find((x) => x.id === s.id));
      await expectCode(slides.updateSlide(tx, actor, s.id, cur.version + 1, input()), 'VERSION_CONFLICT');
      const off = await slides.updateSlide(tx, actor, s.id, cur.version, input({ enabled: false, skipEmpty: true }));
      expect([off.enabled, off.skipEmpty]).toEqual([false, true]);
      expect((await slides.monitorScreen(tx)).slides.map((x) => x.id)).not.toContain(s.id);
      await slides.deleteSlide(tx, actor, s.id, off.version);
      expect((await slides.listSlides(tx)).map((x) => x.id)).not.toContain(s.id);
      expect(await tx.monitorSlide.findUnique({ where: { id: s.id } })).toMatchObject({ deletedAt: expect.any(Date) });
      expect(await tx.auditLog.count({ where: { entityId: s.id, action: { startsWith: 'monitor.slide.' } } })).toBe(4);
    }));

  it('фильтры: просроченные задачи по категории; уязвимости по критичности; пустой слайд — empty', () =>
    inTx(async (tx) => {
      const admin = await makeUser(tx, ['super_admin', 'ib_staff']);
      const actor = await actorFor(tx, admin.id);
      const project = await tx.catalogItem.findFirstOrThrow({ where: { catalogCode: 'task_categories', value: 'Проект' } });
      const other = await tx.catalogItem.findFirstOrThrow({ where: { catalogCode: 'task_categories', id: { not: project.id } } });
      const late = await tasks.createTask(tx, actor, { title: 'Просроченная проектная', categoryId: project.id, dueDate: '2020-01-10' });
      await tasks.createTask(tx, actor, { title: 'Будущая проектная', categoryId: project.id, dueDate: '2099-01-10' });
      await tasks.createTask(tx, actor, { title: 'Просроченная другая', categoryId: other.id, dueDate: '2020-01-10' });

      const p = await slides.previewSlide(tx, input({ filter: { period: 'overdue', categories: [project.id] } }));
      expect(p.empty).toBe(false);
      expect((p.data as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([late.id]);
      // Решений ОУР с просроченным пересмотром нет — пустой слайд (экран покажет «Нет …» или пропустит его).
      const none = await slides.previewSlide(tx, input({ kind: 'risks', title: 'Решения ОУР', filter: { period: 'overdue' } }));
      expect([none.empty, (none.data as { items: unknown[] }).items]).toEqual([true, []]);

      const x = await vulnRegister(tx);
      const crit = x.opt('crit', 'critical');
      await records.createRecord(tx, x.actor, x.reg.id, { values: { [x.vf.cve.id]: 'CVE-2026-0001', [x.vf.crit.id]: crit, [x.vf.notified.id]: '2020-01-01' } });
      await records.createRecord(tx, x.actor, x.reg.id, { values: { [x.vf.cve.id]: 'CVE-2026-0002', [x.vf.crit.id]: x.opt('crit', 'low'), [x.vf.notified.id]: '2020-01-01' } });
      const v = await slides.previewSlide(tx, input({ kind: 'vulns', title: 'Критические', filter: { period: 'overdue', crit: [crit] } }));
      const block = (v.data as { vulns: { items: { title: string }[] } | null }).vulns;
      expect(block?.items.map((i) => i.title)).toEqual(['CVE-2026-0001']);
      await expectCode(slides.previewSlide(tx, input({ kind: 'vulns', filter: { crit: ['00000000-0000-4000-8000-000000000000'] } })), 'BAD_SLIDE');
    }));
});
