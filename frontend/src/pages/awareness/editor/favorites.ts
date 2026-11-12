// Избранные цвета редактора писем (1.13.11, docs/plans/release-1.13.11.md, раздел 0). Два набора: «текст» — цвет текста
// и подчёркивание, «фон» — фон текста и заливка ячейки. Личные: localStorage браузера с ключом по пользователю
// (серверного хранилища личных настроек интерфейса нет; это состояние интерфейса, CLAUDE.md, раздел 2).
import { useSyncExternalStore } from 'react';
import { FAVORITES_MAX } from '../../../api/generated/letter-format';
import { strictHex } from './format';

export type FavoriteSet = 'text' | 'bg';
/** Где выбирается цвет → набор избранного. */
export type ColorKind = 'text' | 'underline' | 'highlight' | 'cell';
export const FAVORITE_SET: Record<ColorKind, FavoriteSet> = { text: 'text', underline: 'text', highlight: 'bg', cell: 'bg' };
export const FAVORITES_FULL = `В избранном не больше ${FAVORITES_MAX} цветов, удалите лишний`;

/** Добавить цвет: повтор не добавляется; больше 12 — ошибка с текстом. */
export function addFavorite(list: readonly string[], color: string): { list: string[]; error: string | null } {
  const hex = strictHex(color);
  if (!hex) return { list: [...list], error: 'Цвет — шесть знаков: #RRGGBB' };
  if (list.includes(hex)) return { list: [...list], error: null };
  if (list.length >= FAVORITES_MAX) return { list: [...list], error: FAVORITES_FULL };
  return { list: [...list, hex], error: null };
}

export function removeFavorite(list: readonly string[], color: string): string[] {
  const hex = strictHex(color);
  return list.filter((c) => c !== hex);
}

/** Прочитанный набор: только #RRGGBB, без повторов, не больше 12 (испорченное хранилище не ломает палитру). */
export function cleanFavorites(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    const hex = typeof v === 'string' ? strictHex(v) : null;
    if (hex && !out.includes(hex) && out.length < FAVORITES_MAX) out.push(hex);
  }
  return out;
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const favoritesKey = (userId: string, set: FavoriteSet) => `ibportal.awareness.favoriteColors.${userId}.${set}`;

export function readFavorites(store: KeyValueStore | null, userId: string, set: FavoriteSet): string[] {
  try {
    const raw = store?.getItem(favoritesKey(userId, set));
    return raw ? cleanFavorites(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

export function writeFavorites(store: KeyValueStore | null, userId: string, set: FavoriteSet, list: readonly string[]): void {
  try {
    store?.setItem(favoritesKey(userId, set), JSON.stringify(cleanFavorites(list)));
  } catch {
    // Хранилище недоступно (приватный режим): избранное живёт до перезагрузки страницы.
  }
}

// ---------------------------------------------------------------- общий источник для обоих редакторов (RU и TJ)

const listeners = new Set<() => void>();
const memory = new Map<string, string[]>();
const storage = (): KeyValueStore | null => {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
};

function current(userId: string, set: FavoriteSet): string[] {
  const key = favoritesKey(userId, set);
  let v = memory.get(key);
  if (!v) {
    v = readFavorites(storage(), userId, set);
    memory.set(key, v);
  }
  return v;
}

function save(userId: string, set: FavoriteSet, list: string[]) {
  memory.set(favoritesKey(userId, set), list);
  writeFavorites(storage(), userId, set, list);
  for (const l of listeners) l();
}

/** Избранные цвета набора и действия: add возвращает текст ошибки (12 цветов) или null. */
export function useFavorites(userId: string, set: FavoriteSet) {
  const list = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current(userId, set),
  );
  return {
    list,
    add: (color: string): string | null => {
      const r = addFavorite(current(userId, set), color);
      if (!r.error) save(userId, set, r.list);
      return r.error;
    },
    remove: (color: string) => save(userId, set, removeFavorite(current(userId, set), color)),
  };
}
