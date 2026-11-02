// Профили сканирования VM (релиз 1.6.0): профиль скана — значение «Типов систем». Один отчёт — один профиль,
// сравнение с реестром узла корректно только внутри профиля. Всё считается при чтении; настройки — app_settings.vulns.
import type { Db } from '../../lib/db.js';
import { conflict, notFound } from '../../lib/errors.js';
import { SYSTEM_TYPES_CATALOG } from './groups.service.js';

export const VULN_SETTINGS_KEY = 'vulns';
export const DEFAULT_SCAN_MAX_AGE_DAYS = 90;

export interface ProfileType {
  id: string;
  label: string;
}

export interface VulnSettings {
  scanMaxAgeDays: number;
  /** { "<id типа>": ["postgres", "pg"] } */
  profileAliases: Record<string, string[]>;
}

/** Название как отдельное слово, можно с префиксом «Scan»: Scan_Linux, scan-linux, ScanLinux, …_Linux_2026_10_15. */
function nameRegex(name: string): RegExp {
  const body = name.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s_.-]+');
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:scan[\\s_-]*)?${body}(?![\\p{L}\\p{N}])`, 'iu');
}

/** Тип по имени файла. Не нашли или подходят два типа — null: без угадывания. */
export function detectProfile(fileName: string, types: readonly ProfileType[], aliases: VulnSettings['profileAliases'] = {}): ProfileType | null {
  const base = fileName.replace(/\.[^.]+$/, '');
  const found = types.filter((t) => [t.label, ...(aliases[t.id] ?? [])].some((name) => name.trim() && nameRegex(name).test(base)));
  return found.length === 1 ? found[0] as ProfileType : null;
}

export const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Сколько дней прошло с последнего скана и превышен ли порог. Сканов нет — порог превышен: узел не сканировали. */
export function scanFreshness(lastScanDate: string | null, today: string, maxAgeDays: number): { ageDays: number | null; stale: boolean } {
  if (!lastScanDate) return { ageDays: null, stale: true };
  const ageDays = Math.round((Date.parse(today) - Date.parse(lastScanDate)) / 86_400_000);
  return { ageDays, stale: ageDays > maxAgeDays };
}

/** Нет настройки или значение негодное — значение по умолчанию: регулярность считается всегда. */
export async function getVulnSettings(db: Db): Promise<VulnSettings> {
  const row = await db.appSetting.findUnique({ where: { key: VULN_SETTINGS_KEY } });
  const v = (row?.value ?? {}) as Partial<VulnSettings>;
  const days = v.scanMaxAgeDays;
  const aliases = v.profileAliases && typeof v.profileAliases === 'object' ? v.profileAliases : {};
  return {
    scanMaxAgeDays: typeof days === 'number' && Number.isInteger(days) && days > 0 ? days : DEFAULT_SCAN_MAX_AGE_DAYS,
    profileAliases: Object.fromEntries(Object.entries(aliases).map(([id, list]) => [id, Array.isArray(list) ? list.filter((a): a is string => typeof a === 'string') : []])),
  };
}

/** Профиль файла среди действующих значений справочника. */
export async function detectFileProfile(db: Db, fileName: string): Promise<ProfileType | null> {
  const items = await db.catalogItem.findMany({ where: { catalogCode: SYSTEM_TYPES_CATALOG, deletedAt: null, archivedAt: null }, select: { id: true, value: true } });
  const { profileAliases } = await getVulnSettings(db);
  return detectProfile(fileName, items.map((i) => ({ id: i.id, label: i.value })), profileAliases);
}

/** Импорт со страницы группы: какой профиль у файла и есть ли его узел в группе. */
export async function groupScanTarget(db: Db, groupId: string, fileName: string) {
  const group = await db.vulnGroup.findUnique({ where: { id: groupId }, include: { nodes: { where: { deletedAt: null }, select: { id: true, systemTypeId: true } } } });
  if (!group || group.deletedAt) throw notFound('Группа');
  if (group.systemKey) throw conflict('LEGACY_NODE', 'В «Без группы» сканы не загружаются. Откройте другую группу');
  const detected = await detectFileProfile(db, fileName);
  return { detected, nodeId: detected ? group.nodes.find((n) => n.systemTypeId === detected.id)?.id ?? null : null };
}
