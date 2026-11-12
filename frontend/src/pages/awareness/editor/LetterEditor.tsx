// Редактор текста письма, шаблона и «Подписи ИБ» на TipTap 3 (1.9.0, ADR-0039; docs/specs/awareness.md, раздел 15).
// Загружается лениво (React.lazy из index.tsx): остальные страницы портала его не тянут.
// Возможности — белый список санитайзера: заголовки 2–4, жирный, курсив, подчёркнутый, зачёркнутый, списки, ссылка,
// таблица, изображение данными, цитата, линия, блок «Подпись ИБ». Оформление 1.13.11 (шрифт, цвет и фон текста, цветное
// подчёркивание, выравнивание, положение и ширина картинки, ширина столбцов и заливка) — extensions.ts; остальное
// оформление и лишние атрибуты отбрасывает backend.
import { Node, mergeAttributes } from '@tiptap/core';
import { TableKit } from '@tiptap/extension-table';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { IMAGE_WIDTH, TEXT_DEFAULT, type ImageAlign, type TextAlign } from '../../../api/generated/letter-format';
import { useMe } from '../../../auth/useMe';
import { checkImageFile, countLinkedImages, IMAGE_TYPES, imagesWarning, readAsDataUrl, replaceLinkedImages } from './paste';
import { Select } from '../../../components/Select';
import { ColorSplit, DEFAULT_LAST } from './ColorPalette';
import { CellFormat, currentColumn, LetterFormatClear, LetterImage, LetterStyle, LetterTextAlign, setColumnPercent, tableWidths, UnderlineColor } from './extensions';
import type { ColorKind } from './favorites';
import { canonicalEditorHtml, cleanPastedHtml, TNR_CSS } from './format';

export interface LetterEditorProps {
  value: string;
  /** Смена ключа (другая версия, перечитали письмо) — содержимое заменяется value. */
  resetKey: string;
  onChange: (html: string) => void;
  /** Текущая «Подпись ИБ» на языке редактора — показывается внутри блока. */
  signatureHtml: string;
  /** Блок «Подпись ИБ» в панели: в письмах и шаблонах — да, в самой подписи — нет. */
  allowSignature?: boolean;
  /** Лимит изображения, КБ («Параметры портала»): проверка до вставки, решает backend. */
  maxImageKb: number;
  readOnly?: boolean;
  /** Сообщение пользователю: не вставленные картинки, слишком большой файл. */
  onWarning: (text: string) => void;
  label: string;
}

/** Блок «Подпись ИБ»: неделимый, в HTML — `<div data-ib-fragment="signature"></div>`, показывает текущую подпись. */
const SignatureBlock = Node.create<{ html: () => string }>({
  name: 'ibSignature',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addOptions() {
    return { html: () => '' };
  },
  parseHTML() {
    return [{ tag: 'div[data-ib-fragment="signature"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-ib-fragment': 'signature' })];
  },
  addNodeView() {
    return () => {
      const dom = document.createElement('div');
      dom.className = 'aw-sig';
      dom.contentEditable = 'false';
      dom.setAttribute('data-label', 'Подпись ИБ');
      // HTML подписи прошёл санитайзер backend при сохранении.
      dom.innerHTML = this.options.html() || '<p class="muted">Подпись ИБ не заполнена</p>';
      return { dom };
    };
  },
});

/**
 * «Выделенный блок» (1.12.0): `<div data-callout="info|warn">` с абзацами — «Просьба» или «Предупреждение».
 * В письме — таблица с полосой слева (макет backend); санитайзер пропускает только эти два значения.
 */
type CalloutKind = 'info' | 'warn';
const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      kind: {
        default: 'info',
        parseHTML: (el) => (el.getAttribute('data-callout') === 'warn' ? 'warn' : 'info'),
        renderHTML: (attrs) => ({ 'data-callout': attrs.kind === 'warn' ? 'warn' : 'info' }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-callout]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes), 0];
  },
});

const CALLOUT_TITLE: Record<CalloutKind, string> = { info: 'Просьба:', warn: 'Предупреждение:' };

const ALIGNS: { key: TextAlign; title: string; ico: string }[] = [
  { key: 'left', title: 'По левому краю (Ctrl+L)', ico: '⇤' },
  { key: 'center', title: 'По центру (Ctrl+E)', ico: '↔' },
  { key: 'right', title: 'По правому краю (Ctrl+R)', ico: '⇥' },
  { key: 'justify', title: 'По ширине (Ctrl+J)', ico: '☰' },
];
const IMAGE_POSITIONS: { key: ImageAlign; title: string; ico: string }[] = [
  { key: 'left', title: 'По левому краю', ico: '⇤' },
  { key: 'center', title: 'По центру', ico: '↔' },
  { key: 'right', title: 'По правому краю', ico: '⇥' },
  { key: 'wrap-left', title: 'Слева, текст справа', ico: '◧' },
  { key: 'wrap-right', title: 'Справа, текст слева', ico: '◨' },
];
/** Последний выбранный цвет по видам — общий для обоих редакторов (RU и TJ) на странице. */
const lastColors: Record<ColorKind, string | null> = { ...DEFAULT_LAST };

const isEmptyDoc = (e: Editor) => e.isEmpty && !canonicalEditorHtml(e.getHTML()).includes('<img') && !canonicalEditorHtml(e.getHTML()).includes('data-ib-fragment');

function Btn({ on, title, onClick, children, disabled }: { on?: boolean; title: string; onClick: () => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <button type="button" className={`aw-tb${on ? ' on' : ''}`} title={title} aria-label={title} aria-pressed={on} disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      {children}
    </button>
  );
}

export default function LetterEditor(p: LetterEditorProps) {
  const sigRef = useRef(p.signatureHtml);
  sigRef.current = p.signatureHtml;
  const props = useRef(p);
  props.current = p;
  const fileInput = useRef<HTMLInputElement>(null);
  /**
   * Загруженное содержимое и его вид после разбора редактором: TipTap нормализует HTML (атрибуты, обёртки), и без
   * этого открытое письмо сразу считалось бы изменённым. Совпадение с нормализованным видом — исходное значение.
   */
  const baseline = useRef<{ value: string; html: string }>({ value: p.value, html: '' });
  const [link, setLink] = useState<string | null>(null);
  const [last, setLast] = useState<Record<ColorKind, string | null>>(() => ({ ...lastColors }));
  const [alignMenu, setAlignMenu] = useState(false);
  const me = useMe();
  const userId = me.data?.id ?? 'anon';

  const insertFiles = async (editor: Editor, files: File[]) => {
    const ok: File[] = [];
    for (const f of files) {
      const problem = checkImageFile(f, props.current.maxImageKb);
      if (problem) props.current.onWarning(problem);
      else ok.push(f);
    }
    for (const f of ok) editor.chain().focus().setImage({ src: await readAsDataUrl(f) }).run();
  };

  const editor = useEditor({
    editable: !p.readOnly,
    content: p.value,
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3, 4] },
        code: false,
        codeBlock: false,
        link: { openOnClick: false, autolink: true, defaultProtocol: 'https', protocols: ['mailto'] },
      }),
      TableKit.configure({ table: { resizable: false } }),
      LetterImage.configure({ allowBase64: true, inline: false }),
      SignatureBlock.configure({ html: () => sigRef.current }),
      Callout,
      LetterStyle, UnderlineColor, LetterTextAlign, LetterFormatClear, CellFormat,
    ],
    editorProps: {
      attributes: { class: 'aw-doc', 'aria-label': p.label, role: 'textbox', 'aria-multiline': 'true' },
      // Вставка из Word и Outlook: из стилей — только разрешённое (1.13.11), избранное не меняется.
      transformPastedHTML: (html) => cleanPastedHtml(html),
      handlePaste: (_view, event) => {
        const data = event.clipboardData;
        if (!data || !editor) return false;
        const files = [...data.files].filter((f) => (IMAGE_TYPES as readonly string[]).includes(f.type));
        const html = data.getData('text/html');
        if (!files.length && !(html && countLinkedImages(html))) return false;
        event.preventDefault();
        void (async () => {
          const usable = files.filter((f) => !checkImageFile(f, props.current.maxImageKb));
          if (html) {
            // Картинки из буфера подставляются вместо ссылок cid:, file://, внешних — по порядку.
            const r = replaceLinkedImages(cleanPastedHtml(html), await Promise.all(usable.map(readAsDataUrl)));
            editor.chain().focus().insertContent(r.html).run();
            const w = imagesWarning(r.missing);
            if (w) props.current.onWarning(w);
          } else {
            await insertFiles(editor, files);
          }
        })();
        return true;
      },
      handleDrop: (_view, event) => {
        const files = [...(event.dataTransfer?.files ?? [])];
        if (!files.length || !editor) return false;
        event.preventDefault();
        void insertFiles(editor, files);
        return true;
      },
    },
    onCreate: ({ editor: e }) => { baseline.current = { value: props.current.value, html: canonicalEditorHtml(e.getHTML()) }; },
    onUpdate: ({ editor: e }) => {
      const html = canonicalEditorHtml(e.getHTML());
      props.current.onChange(html === baseline.current.html ? baseline.current.value : isEmptyDoc(e) ? '' : html);
    },
  });

  // Другая версия или перечитанное письмо — заменить содержимое без события правки.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.commands.setContent(p.value, { emitUpdate: false });
    baseline.current = { value: p.value, html: canonicalEditorHtml(editor.getHTML()) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, p.resetKey]);
  useEffect(() => {
    // Без события правки: иначе переключение «только чтение» отдавало бы нормализованный HTML как изменение.
    editor?.setEditable(!p.readOnly, false);
  }, [editor, p.readOnly]);
  // Подпись загрузилась или изменилась — блоки рисуются заново (вид узла создаётся один раз), без события правки.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const html = canonicalEditorHtml(editor.getHTML());
    if (html.includes('data-ib-fragment')) editor.commands.setContent(html, { emitUpdate: false });
    if (html === baseline.current.html) baseline.current = { ...baseline.current, html: canonicalEditorHtml(editor.getHTML()) };
  }, [editor, p.signatureHtml]);

  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => (e ? {
      h: e.isActive('heading', { level: 2 }) ? 2 : e.isActive('heading', { level: 3 }) ? 3 : e.isActive('heading', { level: 4 }) ? 4 : 0,
      bold: e.isActive('bold'), italic: e.isActive('italic'), underline: e.isActive('underline'), strike: e.isActive('strike'),
      bullet: e.isActive('bulletList'), ordered: e.isActive('orderedList'), quote: e.isActive('blockquote'), link: e.isActive('link'),
      table: e.isActive('table'), undo: e.can().undo(), redo: e.can().redo(),
      font: (e.getAttributes('letterStyle').fontFamily as string | null | undefined) ? 'times' : 'arial',
      color: (e.getAttributes('letterStyle').color as string | null | undefined) ?? null,
      background: (e.getAttributes('letterStyle').backgroundColor as string | null | undefined) ?? null,
      underlineColor: (e.getAttributes('underline').color as string | null | undefined) ?? null,
      align: ((['paragraph', 'heading', 'listItem'] as const).map((t) => e.getAttributes(t).textAlign as TextAlign | null | undefined).find(Boolean) ?? 'left') as TextAlign,
      image: e.isActive('image') ? e.getAttributes('image') as { align?: ImageAlign | null; width?: number | string | null } : null,
      cellBg: e.isActive('table') ? ((e.getAttributes('tableCell').background ?? e.getAttributes('tableHeader').background) as string | null | undefined) ?? null : null,
      column: e.isActive('table') ? (() => {
        const col = currentColumn(e.state);
        return col ? tableWidths(col.table, col.tablePos)[col.index] ?? null : null;
      })() : null,
      callout: e.isActive('callout') ? ((e.getAttributes('callout').kind as CalloutKind | undefined) ?? 'info') : null,
    } : null),
  });

  if (!editor) return <div className="aw-editor loading">Загружаем редактор…</div>;
  const c = () => editor.chain().focus();
  const remember = (kind: ColorKind, color: string | null) => {
    lastColors[kind] = color;
    setLast((l) => ({ ...l, [kind]: color }));
  };
  /** Применить цвет вида; «Обычный» цвет текста снимает цвет. */
  const apply = (kind: ColorKind, color: string | null) => {
    if (color !== null) remember(kind, color);
    if (kind === 'text') c().setLetterStyle({ color: color === TEXT_DEFAULT ? null : color }).run();
    else if (kind === 'highlight') c().setLetterStyle({ backgroundColor: color }).run();
    else if (kind === 'underline') {
      if (color === null) remember(kind, null);
      c().setUnderlineColor(color).run();
    } else c().setCellAttribute('background', color).run();
  };
  const imgWidth = s?.image ? Number(s.image.width) || null : null;
  const setImage = (attrs: { align?: ImageAlign | null; width?: number | null }) => {
    editor.chain().updateAttributes('image', { ...attrs, ...(attrs.width !== undefined ? { height: null } : {}) }).run();
  };
  const wrapTooWide = !!s?.image?.align?.startsWith('wrap') && (imgWidth === null || imgWidth > IMAGE_WIDTH.wrapMax);
  const submitLink = (ev: FormEvent) => {
    ev.preventDefault();
    const href = (link ?? '').trim();
    if (!href) c().extendMarkRange('link').unsetLink().run();
    else c().extendMarkRange('link').setLink({ href: /^(https?:|mailto:)/i.test(href) ? href : `https://${href}` }).run();
    setLink(null);
  };

  return (
    <div className={`aw-editor${p.readOnly ? ' ro' : ''}`}>
      {!p.readOnly && s && (
        <div className="aw-toolbar" role="toolbar" aria-label={`Оформление: ${p.label}`}>
          <Select className="inp sm" aria-label="Стиль абзаца" value={s.h}
            onChange={(e) => { const lv = Number(e.target.value); if (lv) c().setHeading({ level: lv as 2 | 3 | 4 }).run(); else c().setParagraph().run(); }}>
            <option value={0}>Обычный текст</option>
            <option value={2}>Заголовок 1</option>
            <option value={3}>Заголовок 2</option>
            <option value={4}>Заголовок 3</option>
          </Select>
          <Select className="inp sm aw-font" aria-label="Шрифт" title="Шрифт" value={s.font}
            onChange={(e) => c().setLetterStyle({ fontFamily: e.target.value === 'times' ? TNR_CSS : null }).run()}>
            <option value="arial">Arial</option>
            <option value="times">Times New Roman</option>
          </Select>
          <span className="aw-sep" />
          <Btn on={s.bold} title="Жирный" onClick={() => c().toggleBold().run()}><b>Ж</b></Btn>
          <Btn on={s.italic} title="Курсив" onClick={() => c().toggleItalic().run()}><i>К</i></Btn>
          <ColorSplit kind="underline" label="Подчёркнутый" userId={userId} last={last.underline} active={s.underline} onWarning={p.onWarning}
            icon={<u style={last.underline ? { textDecorationColor: last.underline } : undefined}>Ч</u>}
            onMain={() => (s.underline ? c().unsetUnderline().run() : apply('underline', last.underline))}
            onApply={(col) => apply('underline', col)} />
          <Btn on={s.strike} title="Зачёркнутый" onClick={() => c().toggleStrike().run()}><s>З</s></Btn>
          <ColorSplit kind="text" label="Цвет текста" userId={userId} last={last.text} active={!!s.color} onWarning={p.onWarning}
            icon={<span className="aw-ico-a">A</span>} onApply={(col) => apply('text', col)} />
          <ColorSplit kind="highlight" label="Цвет фона текста" userId={userId} last={last.highlight} active={!!s.background} onWarning={p.onWarning}
            textColor={s.color} icon={<span className="aw-ico-a aw-ico-hl">ab</span>} onApply={(col) => apply('highlight', col)} />
          <span className="aw-split">
            <Btn on={s.align !== 'left'} title={`Выравнивание: ${ALIGNS.find((a) => a.key === s.align)?.title ?? ''}`} onClick={() => setAlignMenu((v) => !v)}>
              {ALIGNS.find((a) => a.key === s.align)?.ico}▾
            </Btn>
            {alignMenu && (
              <span className="aw-menu" role="menu" aria-label="Выравнивание">
                {ALIGNS.map((a) => (
                  <button key={a.key} type="button" role="menuitemradio" aria-checked={s.align === a.key} className={`aw-tb${s.align === a.key ? ' on' : ''}`}
                    title={a.title} aria-label={a.title} onMouseDown={(e) => e.preventDefault()}
                    onClick={() => { setAlignMenu(false); c().setLetterAlign(a.key).run(); }}>{a.ico}</button>
                ))}
              </span>
            )}
          </span>
          <Btn title="Очистить форматирование (шрифт, цвет, фон, цвет подчёркивания, выравнивание)" onClick={() => c().clearLetterFormatting().run()}>
            <span className="aw-ico-clear">T<sub>×</sub></span>
          </Btn>
          <span className="aw-sep" />
          <Btn on={s.bullet} title="Маркированный список" onClick={() => c().toggleBulletList().run()}>•</Btn>
          <Btn on={s.ordered} title="Нумерованный список" onClick={() => c().toggleOrderedList().run()}>1.</Btn>
          <Btn on={s.quote} title="Цитата" onClick={() => c().toggleBlockquote().run()}>❝</Btn>
          <Btn title="Горизонтальная линия" onClick={() => c().setHorizontalRule().run()}>—</Btn>
          <span className="aw-sep" />
          <Btn on={s.link} title="Ссылка" onClick={() => setLink(link === null ? (editor.getAttributes('link').href as string | undefined) ?? '' : null)}>🔗</Btn>
          <Btn title="Изображение из файла" onClick={() => fileInput.current?.click()}>🖼</Btn>
          <Btn title="Таблица 3 × 3 с заголовком" onClick={() => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>▦</Btn>
          {p.allowSignature !== false && <Btn title="Вставить блок «Подпись ИБ»" onClick={() => c().insertContent({ type: 'ibSignature' }).run()}>✍</Btn>}
          {p.allowSignature !== false && (['info', 'warn'] as const).map((k) => (
            <Btn key={k} on={s.callout === k} title={`Выделенный блок «${k === 'info' ? 'Просьба' : 'Предупреждение'}»`}
              onClick={() => (s.callout
                ? c().updateAttributes('callout', { kind: k }).run()
                : c().insertContent({
                  type: 'callout', attrs: { kind: k },
                  content: [
                    { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: CALLOUT_TITLE[k] }] },
                    { type: 'paragraph', content: [{ type: 'text', text: 'Текст блока' }] },
                  ],
                }).run())}>
              <span className={`aw-callout-ico ${k}`} aria-hidden="true">▍</span>{k === 'info' ? 'Просьба' : 'Внимание'}
            </Btn>
          ))}
          {s.callout && <Btn title="Убрать выделенный блок (текст останется)" onClick={() => c().lift('callout').run()}>убрать блок</Btn>}
          <span className="aw-sep" />
          <Btn title="Отменить" disabled={!s.undo} onClick={() => c().undo().run()}>↶</Btn>
          <Btn title="Повторить" disabled={!s.redo} onClick={() => c().redo().run()}>↷</Btn>
          {s.table && (
            <span className="aw-tbl-tools" role="group" aria-label="Таблица">
              <Btn title="Строка ниже" onClick={() => c().addRowAfter().run()}>+ строка</Btn>
              <Btn title="Столбец справа" onClick={() => c().addColumnAfter().run()}>+ столбец</Btn>
              <Btn title="Удалить строку" onClick={() => c().deleteRow().run()}>− строка</Btn>
              <Btn title="Удалить столбец" onClick={() => c().deleteColumn().run()}>− столбец</Btn>
              <Btn title="Объединить или разделить ячейки" onClick={() => c().mergeOrSplit().run()}>⊞</Btn>
              <Btn title="Строка заголовка" onClick={() => c().toggleHeaderRow().run()}>заголовок</Btn>
              <ColorSplit kind="cell" label="Заливка ячейки" userId={userId} last={last.cell} active={!!s.cellBg} onWarning={p.onWarning}
                textColor={null} icon={<span className="aw-ico-cell">▦</span>} onApply={(col) => apply('cell', col)} />
              <label className="aw-colw" title="Ширина столбца, % — остальные пересчитаются пропорционально">
                <span>Ширина, %</span>
                <input key={`${s.column ?? ''}`} className="inp sm" type="number" min={10} max={100} defaultValue={s.column ?? ''} aria-label="Ширина столбца, %"
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); const v = Number((e.target as HTMLInputElement).value); if (v) setColumnPercent(editor, v); } }}
                  onBlur={(e) => { const v = Number(e.target.value); if (v && v !== s.column) setColumnPercent(editor, v); }} />
              </label>
              <Btn title="Удалить таблицу" onClick={() => c().deleteTable().run()}>удалить</Btn>
            </span>
          )}
          <input ref={fileInput} type="file" hidden accept={IMAGE_TYPES.join(',')} multiple
            onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ''; void insertFiles(editor, files); }} />
        </div>
      )}
      {link !== null && (
        <form className="row aw-link" onSubmit={submitLink}>
          <input className="inp grow" autoFocus aria-label="Адрес ссылки" placeholder="https://… или mailto:…" value={link} onChange={(e) => setLink(e.target.value)} />
          <button className="btn sm primary" type="submit">{link.trim() ? 'Применить' : 'Убрать ссылку'}</button>
          <button className="btn sm" type="button" onClick={() => setLink(null)}>Отмена</button>
        </form>
      )}
      {!p.readOnly && (
        <BubbleMenu editor={editor} pluginKey="letterImage" shouldShow={({ editor: e }) => e.isEditable && e.isActive('image')}
          options={{ placement: 'bottom', offset: 8 }}>
          <div className="aw-img-panel" role="toolbar" aria-label="Картинка: положение и ширина" data-testid="image-panel">
            {IMAGE_POSITIONS.map((pos) => (
              <Btn key={pos.key} on={(s?.image?.align ?? 'left') === pos.key && (s?.image?.align != null || pos.key === 'left')} title={pos.title}
                onClick={() => setImage({ align: pos.key === 'left' ? 'left' : pos.key })}>{pos.ico}</Btn>
            ))}
            <span className="aw-sep" />
            <label className="aw-colw">
              <span>Ширина, px</span>
              <input key={`${imgWidth ?? ''}`} className="inp sm" type="number" min={IMAGE_WIDTH.min} max={IMAGE_WIDTH.max} defaultValue={imgWidth ?? ''} placeholder="авто"
                aria-label={`Ширина картинки, px (от ${IMAGE_WIDTH.min} до ${IMAGE_WIDTH.max})`}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }}
                onBlur={(e) => {
                  const v = Math.round(Number(e.target.value));
                  if (!e.target.value) setImage({ width: null });
                  else if (v >= IMAGE_WIDTH.min && v <= IMAGE_WIDTH.max) setImage({ width: v });
                  else p.onWarning(`Ширина картинки — от ${IMAGE_WIDTH.min} до ${IMAGE_WIDTH.max} px`);
                }} />
            </label>
            {[25, 50, 75, 100].map((pct) => (
              <Btn key={pct} on={imgWidth === Math.round((IMAGE_WIDTH.max * pct) / 100)} title={`${pct}% ширины письма`}
                onClick={() => setImage({ width: Math.round((IMAGE_WIDTH.max * pct) / 100) })}>{pct}%</Btn>
            ))}
            {wrapTooWide && (
              <span className="aw-img-warn" role="status">
                С обтеканием — не шире {IMAGE_WIDTH.wrapMax} px.
                <button type="button" className="btn sm" onMouseDown={(e) => e.preventDefault()} onClick={() => setImage({ width: IMAGE_WIDTH.wrapMax })}>Уменьшить до {IMAGE_WIDTH.wrapMax}</button>
              </span>
            )}
          </div>
        </BubbleMenu>
      )}
      <EditorContent editor={editor} />
    </div>
  );
}
