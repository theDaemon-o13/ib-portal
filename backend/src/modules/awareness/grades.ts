// Пороги оценки результатов INDIGO (релиз 1.8.0, спецификация docs/specs/awareness.md, раздел 3.2): в app_settings,
// «Параметры портала», меняет супер-администратор (решение владельца 10). Без импортов модулей: файл читают
// и portal-params.ts, и адаптер импорта.
import { z } from 'zod';

export const AWARENESS_GRADES_KEY = 'awareness.grades';

/** Целое или с одним знаком после запятой: 89,9 — да, 89,95 — нет. */
const oneDecimal = (v: number) => Math.abs(v * 10 - Math.round(v * 10)) < 1e-9;

const pct = (name: string) => z
  .number({ error: `${name}: нужно число от 0 до 100` })
  .min(0, `${name}: не меньше 0`)
  .max(100, `${name}: не больше 100`)
  .refine(oneDecimal, `${name}: целое число или с одним знаком после запятой`);

export const GradesSchema = z
  .strictObject({
    excellent: pct('excellent'),
    good: pct('good'),
    satisfactory: pct('satisfactory'),
    /** Порог пересдачи хранится отдельно от порогов оценки и с ними не связан. */
    retakeBelow: pct('retakeBelow'),
  })
  .refine((g) => g.excellent > g.good && g.good > g.satisfactory, {
    message: 'Пороги оценки по убыванию: excellent > good > satisfactory',
  });
export type GradeSettings = z.infer<typeof GradesSchema>;

export const DEFAULT_GRADES: GradeSettings = { excellent: 90, good: 70, satisfactory: 50, retakeBelow: 50 };
