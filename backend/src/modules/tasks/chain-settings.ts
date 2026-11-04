// Подсказка цепочек задач (релиз 1.7.0, ADR-0035): порог похожести и срок для закрытых цепочек — в app_settings,
// «Параметры портала», чтобы подстроить без релиза (решение владельца 04.11.2026). Без импортов модулей: файл читает
// и portal-params.ts, и chain-suggest.ts.
import { z } from 'zod';

export const CHAIN_SUGGEST_KEY = 'tasks.chainSuggest';

export const ChainSuggestSchema = z.strictObject({
  minJaccard: z.number({ error: 'minJaccard: нужно число от 0 до 1' }).gt(0, 'minJaccard: больше 0').max(1, 'minJaccard: не больше 1'),
  minCommonWords: z.number({ error: 'minCommonWords: нужно целое число' }).int('minCommonWords: целое число').min(1, 'minCommonWords: не меньше 1').max(10, 'minCommonWords: не больше 10'),
  closedDays: z.number({ error: 'closedDays: нужно целое число дней' }).int('closedDays: целое число дней').min(0, 'closedDays: не меньше 0').max(3650, 'closedDays: не больше 3650'),
});
export type ChainSuggestSettings = z.infer<typeof ChainSuggestSchema>;

export const DEFAULT_CHAIN_SUGGEST: ChainSuggestSettings = { minJaccard: 0.6, minCommonWords: 2, closedDays: 30 };
