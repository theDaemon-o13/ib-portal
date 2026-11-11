// Сгенерировано из backend/src/lib/letter-format.ts (npm run openapi:export). Вручную не править.
// Правила проверяет backend (санитайзер при сохранении); здесь — для панели редактора, палитры и вставки.
export const LETTER_FONTS = [
  {
    "key": "arial",
    "label": "Arial",
    "css": null
  },
  {
    "key": "times",
    "label": "Times New Roman",
    "css": "'Times New Roman', Times, serif"
  }
] as const;
export const TEXT_DEFAULT = '#0F172A';
export const TEXT_COLORS = [
  {
    "name": "Обычный",
    "hex": "#0F172A"
  },
  {
    "name": "Тёмно-синий",
    "hex": "#1E3A8A"
  },
  {
    "name": "Синий",
    "hex": "#2563EB"
  },
  {
    "name": "Красный",
    "hex": "#DC2626"
  },
  {
    "name": "Оранжевый",
    "hex": "#EA580C"
  },
  {
    "name": "Зелёный",
    "hex": "#16A34A"
  },
  {
    "name": "Серый",
    "hex": "#64748B"
  }
] as const;
export const HIGHLIGHT_COLORS = [
  {
    "name": "Жёлтый",
    "hex": "#FEF08A"
  },
  {
    "name": "Зелёный",
    "hex": "#BBF7D0"
  },
  {
    "name": "Голубой",
    "hex": "#BFDBFE"
  },
  {
    "name": "Розовый",
    "hex": "#FECACA"
  },
  {
    "name": "Серый",
    "hex": "#E2E8F0"
  }
] as const;
export const CELL_COLORS = [
  {
    "name": "Голубой",
    "hex": "#EFF6FF"
  },
  {
    "name": "Розовый",
    "hex": "#FEF2F2"
  },
  {
    "name": "Зелёный",
    "hex": "#F0FDF4"
  },
  {
    "name": "Жёлтый",
    "hex": "#FFFBEB"
  },
  {
    "name": "Серый",
    "hex": "#F1F5F9"
  },
  {
    "name": "Тёмно-серый",
    "hex": "#E2E8F0"
  },
  {
    "name": "Тёмно-синий",
    "hex": "#1E3A8A"
  }
] as const;
export const FAVORITES_MAX = 12;
export const MIN_CONTRAST = 4.5;
export const TEXT_ALIGNS = [
  "left",
  "center",
  "right",
  "justify"
] as const;
export const IMAGE_ALIGNS = [
  "left",
  "center",
  "right",
  "wrap-left",
  "wrap-right"
] as const;
export const IMAGE_WIDTH = {
  "min": 40,
  "max": 544,
  "wrapMax": 280
} as const;
export const COLUMN_WIDTH = {
  "min": 10,
  "max": 100
} as const;
export type TextAlign = (typeof TEXT_ALIGNS)[number];
export type ImageAlign = (typeof IMAGE_ALIGNS)[number];
