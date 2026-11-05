// Редактор текста письма, шаблона и «Подписи ИБ» на TipTap 3 (1.9.0, ADR-0039; docs/specs/awareness.md, раздел 15).
// Загружается лениво (React.lazy из index.tsx): остальные страницы портала его не тянут.
// Возможности — белый список санитайзера: заголовки 2–4, жирный, курсив, подчёркнутый, зачёркнутый, списки, ссылка,
// таблица, изображение данными, цитата, линия, блок «Подпись ИБ». Оформление и лишние атрибуты отбрасывает backend.
import { Node, mergeAttributes } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { checkImageFile, countLinkedImages, IMAGE_TYPES, imagesWarning, readAsDataUrl, replaceLinkedImages } from './paste';

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

const isEmptyDoc = (e: Editor) => e.isEmpty && !e.getHTML().includes('<img') && !e.getHTML().includes('data-ib-fragment');

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
  const [link, setLink] = useState<string | null>(null);

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
      Image.configure({ allowBase64: true, inline: false }),
      SignatureBlock.configure({ html: () => sigRef.current }),
    ],
    editorProps: {
      attributes: { class: 'aw-doc', 'aria-label': p.label, role: 'textbox', 'aria-multiline': 'true' },
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
            const r = replaceLinkedImages(html, await Promise.all(usable.map(readAsDataUrl)));
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
    onUpdate: ({ editor: e }) => props.current.onChange(isEmptyDoc(e) ? '' : e.getHTML()),
  });

  // Другая версия или перечитанное письмо — заменить содержимое без события правки.
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.commands.setContent(p.value, { emitUpdate: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, p.resetKey]);
  useEffect(() => {
    editor?.setEditable(!p.readOnly);
  }, [editor, p.readOnly]);
  // Подпись загрузилась или изменилась — блоки рисуются заново (вид узла создаётся один раз), без события правки.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const html = editor.getHTML();
    if (html.includes('data-ib-fragment')) editor.commands.setContent(html, { emitUpdate: false });
  }, [editor, p.signatureHtml]);

  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => (e ? {
      h: e.isActive('heading', { level: 2 }) ? 2 : e.isActive('heading', { level: 3 }) ? 3 : e.isActive('heading', { level: 4 }) ? 4 : 0,
      bold: e.isActive('bold'), italic: e.isActive('italic'), underline: e.isActive('underline'), strike: e.isActive('strike'),
      bullet: e.isActive('bulletList'), ordered: e.isActive('orderedList'), quote: e.isActive('blockquote'), link: e.isActive('link'),
      table: e.isActive('table'), undo: e.can().undo(), redo: e.can().redo(),
    } : null),
  });

  if (!editor) return <div className="aw-editor loading">Загружаем редактор…</div>;
  const c = () => editor.chain().focus();
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
          <select className="inp sm" aria-label="Стиль абзаца" value={s.h}
            onChange={(e) => { const lv = Number(e.target.value); if (lv) c().setHeading({ level: lv as 2 | 3 | 4 }).run(); else c().setParagraph().run(); }}>
            <option value={0}>Обычный текст</option>
            <option value={2}>Заголовок 1</option>
            <option value={3}>Заголовок 2</option>
            <option value={4}>Заголовок 3</option>
          </select>
          <span className="aw-sep" />
          <Btn on={s.bold} title="Жирный" onClick={() => c().toggleBold().run()}><b>Ж</b></Btn>
          <Btn on={s.italic} title="Курсив" onClick={() => c().toggleItalic().run()}><i>К</i></Btn>
          <Btn on={s.underline} title="Подчёркнутый" onClick={() => c().toggleUnderline().run()}><u>Ч</u></Btn>
          <Btn on={s.strike} title="Зачёркнутый" onClick={() => c().toggleStrike().run()}><s>З</s></Btn>
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
      <EditorContent editor={editor} />
    </div>
  );
}
