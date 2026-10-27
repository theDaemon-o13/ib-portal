// Форма подтверждения (этап 7): снимок полей шаблона и введённых значений со сверкой требований.
// Снимок хранится в evidence.checks и не меняется (триггер): правка шаблона старые формы не трогает.
import type { CheckKind } from '../form-templates/service.js';

export interface TemplateField {
  id: string;
  label: string;
  checkKind: CheckKind;
  threshold: number | null;
}

export interface CheckItem {
  fieldId: string;
  label: string;
  checkKind: CheckKind;
  threshold: number | null;
  /** Требование словами: «не менее 12», «да», «заполнено». */
  requirement: string;
  value: string;
  ok: boolean;
}

export function requirementText(f: Pick<TemplateField, 'checkKind' | 'threshold'>): string {
  if (f.checkKind === 'min') return `не менее ${f.threshold ?? 0}`;
  if (f.checkKind === 'max') return `не более ${f.threshold ?? 0}`;
  if (f.checkKind === 'yes') return 'да';
  return 'заполнено';
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const t = v.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

function toYesNo(v: unknown): 'да' | 'нет' | null {
  if (v === true) return 'да';
  if (v === false) return 'нет';
  if (typeof v !== 'string') return null;
  const t = v.trim().toLowerCase();
  if (t === 'да' || t === 'yes') return 'да';
  if (t === 'нет' || t === 'no') return 'нет';
  return null;
}

export type FormProblem = { fieldId: string; label: string; message: string };

/** Сверить значения с полями шаблона. Каждое поле обязательно: форма подтверждения заполняется целиком. */
export function buildChecks(fields: readonly TemplateField[], values: Record<string, unknown>): { checks: CheckItem[]; problems: FormProblem[] } {
  const checks: CheckItem[] = [];
  const problems: FormProblem[] = [];
  for (const f of fields) {
    const raw = values[f.id];
    const base = { fieldId: f.id, label: f.label, checkKind: f.checkKind, threshold: f.threshold, requirement: requirementText(f) };
    if (f.checkKind === 'min' || f.checkKind === 'max') {
      const n = toNumber(raw);
      if (n === null) {
        problems.push({ fieldId: f.id, label: f.label, message: 'нужно число' });
        continue;
      }
      const t = f.threshold ?? 0;
      checks.push({ ...base, value: String(n), ok: f.checkKind === 'min' ? n >= t : n <= t });
    } else if (f.checkKind === 'yes') {
      const yn = toYesNo(raw);
      if (yn === null) {
        problems.push({ fieldId: f.id, label: f.label, message: 'выберите «да» или «нет»' });
        continue;
      }
      checks.push({ ...base, value: yn, ok: yn === 'да' });
    } else {
      const text = typeof raw === 'string' ? raw.trim().slice(0, 1000) : typeof raw === 'number' ? String(raw) : '';
      if (!text) {
        problems.push({ fieldId: f.id, label: f.label, message: 'заполните поле' });
        continue;
      }
      checks.push({ ...base, value: text, ok: true });
    }
  }
  return { checks, problems };
}

/** «5 из 6» и список несоответствий. */
export function checksSummary(checks: readonly CheckItem[] | null): { passed: number; total: number; fails: string[] } | null {
  if (!checks) return null;
  return { passed: checks.filter((c) => c.ok).length, total: checks.length, fails: checks.filter((c) => !c.ok).map((c) => c.label) };
}
