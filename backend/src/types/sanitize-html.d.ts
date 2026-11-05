// Минимальное описание sanitize-html@2.18 — только то, что использует санитайзер писем
// (modules/awareness-letters/sanitize.ts). @types/sanitize-html не подключаем: решение владельца 05.11.2026.
declare module 'sanitize-html' {
  type Attributes = Record<string, string>;

  interface Tag {
    tagName: string;
    attribs: Attributes;
    text?: string;
  }

  interface Frame {
    tag: string;
    attribs: Attributes;
    text: string;
  }

  interface Options {
    allowedTags?: string[];
    allowedAttributes?: Record<string, string[]>;
    allowedSchemes?: string[];
    allowedSchemesByTag?: Record<string, string[]>;
    allowedSchemesAppliedToAttributes?: string[];
    allowProtocolRelative?: boolean;
    disallowedTagsMode?: 'discard' | 'completelyDiscard';
    nonTextTags?: string[];
    transformTags?: Record<string, (tagName: string, attribs: Attributes) => Tag>;
    exclusiveFilter?: (frame: Frame) => boolean;
  }

  function sanitizeHtml(dirty: string, options?: Options): string;
  export default sanitizeHtml;
}
