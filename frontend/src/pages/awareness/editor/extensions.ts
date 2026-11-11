// Расширения TipTap для оформления письма (1.13.11, docs/plans/release-1.13.11.md, раздел 5) — на ядре редактора,
// без пакетов text-style, color, highlight, font-family, text-align: их нет в сборке, новых зависимостей не добавляем.
// HTML — тот же, что пропускает санитайзер backend (lib/letter-format.ts).
import { Extension, Mark, type Editor } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import type { ImageAlign, TextAlign } from '../../../api/generated/letter-format';
import { columnWidths, letterStyleCss, resizeColumn, strictHex, styleValue, toFont, toImageAlign, toTextAlign } from './format';

export interface LetterStyleAttrs { fontFamily: string | null; color: string | null; backgroundColor: string | null }
export type LetterStyleKey = keyof LetterStyleAttrs;

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    letterStyle: {
      /** Поставить шрифт, цвет или фон выделенному тексту (null — снять); пустая метка удаляется. */
      setLetterStyle: (attrs: Partial<LetterStyleAttrs>) => ReturnType;
    };
    underlineColor: {
      /** Подчеркнуть цветом (null — цветом текста). */
      setUnderlineColor: (color: string | null) => ReturnType;
    };
    letterTextAlign: {
      setLetterAlign: (align: TextAlign) => ReturnType;
    };
    letterFormatClear: {
      /** «Очистить форматирование»: шрифт, цвет, фон, цвет подчёркивания и выравнивание; жирный, курсив, списки остаются. */
      clearLetterFormatting: () => ReturnType;
    };
  }
}

const styleOf = (el: HTMLElement) => el.getAttribute('style');

/** Метка span: шрифт (только Times New Roman), цвет и фон текста — свойства в одном span, как у backend. */
export const LetterStyle = Mark.create({
  name: 'letterStyle',
  priority: 101,
  addAttributes() {
    return {
      fontFamily: { default: null, parseHTML: (el) => toFont(styleValue(styleOf(el), 'font-family')), renderHTML: () => ({}) },
      color: { default: null, parseHTML: (el) => strictHex(styleValue(styleOf(el), 'color')), renderHTML: () => ({}) },
      backgroundColor: { default: null, parseHTML: (el) => strictHex(styleValue(styleOf(el), 'background-color')), renderHTML: () => ({}) },
    };
  },
  parseHTML() {
    return [{
      tag: 'span[style]',
      getAttrs: (el) => {
        const s = styleOf(el as HTMLElement);
        return toFont(styleValue(s, 'font-family')) || strictHex(styleValue(s, 'color')) || strictHex(styleValue(s, 'background-color')) ? {} : false;
      },
    }];
  },
  renderHTML({ mark }) {
    const css = letterStyleCss(mark.attrs as LetterStyleAttrs);
    return ['span', css ? { style: css } : {}, 0];
  },
  addCommands() {
    return {
      setLetterStyle: (attrs) => ({ tr, state, dispatch }) => {
        const type = state.schema.marks.letterStyle;
        if (!type) return false;
        const { from, to, empty } = state.selection;
        if (empty) {
          // Без выделения — для набираемого текста.
          const cur = (state.storedMarks ?? state.selection.$from.marks()).find((m) => m.type === type);
          const next = { ...(cur?.attrs as LetterStyleAttrs | undefined ?? { fontFamily: null, color: null, backgroundColor: null }), ...attrs };
          if (dispatch) tr.setStoredMarks([...(state.storedMarks ?? state.selection.$from.marks()).filter((m) => m.type !== type), ...(letterStyleCss(next) ? [type.create(next)] : [])]);
          return true;
        }
        if (!dispatch) return true;
        // Каждому отрезку текста — свои прежние значения плюс новые; пустая метка снимается.
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (!node.isText) return;
          const start = Math.max(from, pos);
          const end = Math.min(to, pos + node.nodeSize);
          const cur = node.marks.find((m) => m.type === type);
          const next = { fontFamily: null, color: null, backgroundColor: null, ...(cur?.attrs as LetterStyleAttrs | undefined), ...attrs };
          tr.removeMark(start, end, type);
          if (letterStyleCss(next)) tr.addMark(start, end, type.create(next));
        });
        return true;
      },
    };
  },
});

/** Цвет подчёркивания: атрибут метки underline из starter-kit → `<u style="text-decoration-color:#…">`. */
export const UnderlineColor = Extension.create({
  name: 'underlineColor',
  addGlobalAttributes() {
    return [{
      types: ['underline'],
      attributes: {
        color: {
          default: null,
          parseHTML: (el) => strictHex(styleValue(el.getAttribute('style'), 'text-decoration-color')),
          renderHTML: (a) => (a.color ? { style: `text-decoration-color:${a.color as string}` } : {}),
        },
      },
    }];
  },
  addCommands() {
    return {
      setUnderlineColor: (color) => ({ tr, state, dispatch }) => {
        const type = state.schema.marks.underline;
        if (!type) return false;
        const { from, to, empty } = state.selection;
        if (empty) {
          if (dispatch) tr.setStoredMarks([...(state.storedMarks ?? state.selection.$from.marks()).filter((m) => m.type !== type), type.create({ color })]);
          return true;
        }
        if (dispatch) {
          tr.removeMark(from, to, type);
          tr.addMark(from, to, type.create({ color }));
        }
        return true;
      },
    };
  },
});

const ALIGN_TYPES = ['paragraph', 'heading', 'listItem'];

/** Выравнивание абзаца, заголовка и пункта списка: style text-align, по левому краю — без атрибута. */
export const LetterTextAlign = Extension.create({
  name: 'letterTextAlign',
  addGlobalAttributes() {
    return [{
      types: ALIGN_TYPES,
      attributes: {
        textAlign: {
          default: null,
          parseHTML: (el) => toTextAlign(styleValue(el.getAttribute('style'), 'text-align') ?? el.getAttribute('align')),
          renderHTML: (a) => (a.textAlign ? { style: `text-align:${a.textAlign as string}` } : {}),
        },
      },
    }];
  },
  addCommands() {
    return {
      setLetterAlign: (align) => ({ commands }) => ALIGN_TYPES
        .map((t) => commands.updateAttributes(t, { textAlign: align === 'left' ? null : align }))
        .some(Boolean),
    };
  },
  addKeyboardShortcuts() {
    const set = (a: TextAlign) => () => this.editor.commands.setLetterAlign(a);
    // Как в Word: Ctrl+L / E / R / J (и Ctrl+Shift+… — если браузер забрал сочетание себе).
    return {
      'Mod-l': set('left'), 'Mod-e': set('center'), 'Mod-r': set('right'), 'Mod-j': set('justify'),
      'Mod-Shift-l': set('left'), 'Mod-Shift-e': set('center'), 'Mod-Shift-r': set('right'), 'Mod-Shift-j': set('justify'),
    };
  },
});

/** «Очистить форматирование» для выделения. */
export const LetterFormatClear = Extension.create({
  name: 'letterFormatClear',
  addCommands() {
    return {
      clearLetterFormatting: () => ({ chain }) => chain()
        .unsetMark('letterStyle')
        .command(({ tr, state }) => {
          const type = state.schema.marks.underline;
          if (!type) return true;
          const { from, to } = state.selection;
          // Подчёркивание остаётся, цвет снимается.
          state.doc.nodesBetween(from, to, (node, pos) => {
            if (!node.isText || !node.marks.some((m) => m.type === type && m.attrs.color)) return;
            const start = Math.max(from, pos);
            const end = Math.min(to, pos + node.nodeSize);
            tr.removeMark(start, end, type).addMark(start, end, type.create({ color: null }));
          });
          return true;
        })
        .command(({ commands }) => {
          ALIGN_TYPES.forEach((t) => commands.updateAttributes(t, { textAlign: null }));
          return true;
        })
        .run(),
    };
  },
});

/** Картинка: положение `data-align` из списка и ширина в px (высота снимается — пропорции сохраняет браузер). */
export const LetterImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      align: {
        default: null,
        parseHTML: (el: HTMLElement) => toImageAlign(el.getAttribute('data-align')),
        renderHTML: (a: { align?: ImageAlign | null }) => (a.align ? { 'data-align': a.align } : {}),
      },
    };
  },
});

/** Ячейка таблицы: заливка (style background-color) и ширина столбца в % (атрибут width у первой строки). */
export const CellFormat = Extension.create({
  name: 'cellFormat',
  addGlobalAttributes() {
    return [{
      types: ['tableCell', 'tableHeader'],
      attributes: {
        background: {
          default: null,
          parseHTML: (el) => strictHex(styleValue(el.getAttribute('style'), 'background-color')),
          renderHTML: (a) => (a.background ? { style: `background-color:${a.background as string}` } : {}),
        },
        widthPct: {
          default: null,
          parseHTML: (el) => {
            const m = /^(\d{1,3})%$/.exec(el.getAttribute('width') ?? '');
            return m ? Number(m[1]) : null;
          },
          renderHTML: (a) => (a.widthPct ? { width: `${a.widthPct as number}%` } : {}),
        },
      },
    }];
  },
  addProseMirrorPlugins() {
    return [columnResizePlugin(this.editor)];
  },
});

// ---------------------------------------------------------------- таблица: ширина столбцов

/** Таблица вокруг позиции: узел и его позиция. */
export function tableAt(state: EditorState, pos = state.selection.from): { node: PMNode; pos: number } | null {
  const $pos = state.doc.resolve(pos);
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    if (node.type.name === 'table') return { node, pos: $pos.before(d) };
  }
  return null;
}

/** Ячейки первой строки таблицы: позиции и ширины. */
function firstRow(table: PMNode, tablePos: number): { pos: number; node: PMNode }[] {
  const row = table.firstChild;
  if (!row) return [];
  const cells: { pos: number; node: PMNode }[] = [];
  // Таблица с позиции tablePos, первая строка — tablePos + 1, её ячейки — с tablePos + 2.
  row.forEach((cell, offset) => cells.push({ pos: tablePos + 2 + offset, node: cell }));
  return cells;
}

/** Текущие ширины столбцов таблицы (по первой строке), %; не заданы — равные. */
export function tableWidths(table: PMNode, tablePos: number): number[] {
  return columnWidths(firstRow(table, tablePos).map((c) => (c.node.attrs.widthPct as number | null) ?? null));
}

/** Записать ширины первой строки. */
export function setTableWidths(tr: Transaction, table: PMNode, tablePos: number, widths: readonly number[]): Transaction {
  firstRow(table, tablePos).forEach((c, i) => {
    tr.setNodeMarkup(c.pos, undefined, { ...c.node.attrs, widthPct: widths[i] ?? null });
  });
  return tr;
}

/** Номер столбца ячейки с курсором (по ячейкам строки) и таблица. */
export function currentColumn(state: EditorState): { table: PMNode; tablePos: number; index: number } | null {
  const t = tableAt(state);
  if (!t) return null;
  const $pos = state.selection.$from;
  for (let d = $pos.depth; d > 0; d--) {
    const n = $pos.node(d);
    if (n.type.name === 'tableCell' || n.type.name === 'tableHeader') return { table: t.node, tablePos: t.pos, index: $pos.index(d - 1) };
  }
  return null;
}

/** Поле «Ширина столбца, %»: столбец получает значение, остальные — пропорционально. */
export function setColumnPercent(editor: Editor, percent: number): boolean {
  const c = currentColumn(editor.state);
  if (!c) return false;
  const widths = resizeColumn(tableWidths(c.table, c.tablePos), c.index, percent);
  editor.view.dispatch(setTableWidths(editor.state.tr, c.table, c.tablePos, widths));
  return true;
}

const RESIZE_KEY = new PluginKey('letterColumnResize');
const HANDLE_PX = 5;

/**
 * Перетаскивание границы столбца мышью. Во время перетаскивания меняется только вид (ширины ячеек первой строки в DOM),
 * в конце — одна правка документа (одна запись в истории «Отменить»).
 */
function columnResizePlugin(editor: Editor) {
  let hover: { tableEl: HTMLTableElement; index: number } | null = null;
  const boundaryAt = (view: EditorView, e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    const tableEl = target?.closest('table');
    if (!tableEl || !view.dom.contains(tableEl)) return null;
    const cells = [...(tableEl.rows[0]?.cells ?? [])];
    for (let i = 0; i < cells.length - 1; i++) {
      const r = (cells[i] as HTMLTableCellElement).getBoundingClientRect();
      if (Math.abs(e.clientX - r.right) <= HANDLE_PX) return { tableEl, index: i };
    }
    return null;
  };
  return new Plugin({
    key: RESIZE_KEY,
    props: {
      handleDOMEvents: {
        mousemove: (view, e) => {
          if (!view.editable) return false;
          hover = boundaryAt(view, e);
          view.dom.classList.toggle('aw-col-resize', !!hover);
          return false;
        },
        mouseleave: (view) => {
          hover = null;
          view.dom.classList.remove('aw-col-resize');
          return false;
        },
        mousedown: (view, e) => {
          if (!hover || !view.editable || e.button !== 0) return false;
          const { tableEl, index } = hover;
          const pos = view.posAtDOM(tableEl.rows[0]?.cells[0] as Node, 0);
          const t = tableAt(view.state, pos);
          if (!t) return false;
          e.preventDefault();
          const start = tableWidths(t.node, t.pos);
          let widths = start;
          const rect = tableEl.getBoundingClientRect();
          const cells = [...(tableEl.rows[0]?.cells ?? [])] as HTMLTableCellElement[];
          const left = (cells[index] as HTMLTableCellElement).getBoundingClientRect().left;
          tableEl.classList.add('aw-resizing');
          const move = (ev: MouseEvent) => {
            const pct = ((ev.clientX - left) / rect.width) * 100;
            widths = resizeColumn(start, index, pct);
            cells.forEach((c, i) => c.setAttribute('width', `${widths[i] ?? 0}%`));
          };
          const up = () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
            tableEl.classList.remove('aw-resizing');
            const cur = tableAt(editor.state, pos);
            if (cur) editor.view.dispatch(setTableWidths(editor.state.tr, cur.node, cur.pos, widths));
          };
          window.addEventListener('mousemove', move);
          window.addEventListener('mouseup', up);
          return true;
        },
      },
    },
  });
}
