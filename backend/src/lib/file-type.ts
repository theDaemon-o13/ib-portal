// Тип загружаемого файла — по содержимому (сигнатуре), а не по расширению и не по типу от браузера
// (CLAUDE.md 3.7). Разрешены pdf, png, jpg, txt, csv, xlsx, docx; расширение обязано совпасть с содержимым.
// SVG, HTML и офисные файлы с макросами не проходят. Без зависимостей: zip разбирается по центральному каталогу.
import { inflateRawSync } from 'node:zlib';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export type FileExt = 'pdf' | 'png' | 'jpg' | 'txt' | 'csv' | 'xlsx' | 'docx';

export const MIME_BY_EXT: Record<FileExt, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  txt: 'text/plain',
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

const EXT_ALIASES: Record<string, FileExt> = {
  pdf: 'pdf', png: 'png', jpg: 'jpg', jpeg: 'jpg', txt: 'txt', csv: 'csv', xlsx: 'xlsx', docx: 'docx',
};

export const ALLOWED_TEXT = 'PDF, PNG, JPG, TXT, CSV, XLSX, DOCX';

/** Что лежит внутри на самом деле. */
type Content = 'pdf' | 'png' | 'jpg' | 'text' | 'xlsx' | 'docx' | 'markup' | 'macro' | 'zip' | 'unknown';

const CONTENT_NAMES: Record<Content, string> = {
  pdf: 'PDF', png: 'PNG', jpg: 'JPG', text: 'текст', xlsx: 'XLSX', docx: 'DOCX',
  markup: 'HTML/SVG/XML', macro: 'офисный файл с макросами', zip: 'архив ZIP', unknown: 'неизвестный формат',
};

export type FileCheck =
  | { ok: true; ext: FileExt; mime: string; name: string }
  | { ok: false; code: 'BAD_FILE_NAME' | 'BAD_FILE_TYPE' | 'FILE_TYPE_MISMATCH' | 'EMPTY_FILE' | 'FILE_TOO_LARGE'; message: string };

/** Имя для показа и Content-Disposition: без пути и управляющих символов, не длиннее 255. */
export function cleanFileName(raw: string): string {
  const base = raw.normalize('NFC').split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  return base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255);
}

export function extOf(name: string): FileExt | null {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? EXT_ALIASES[m[1]?.toLowerCase() ?? ''] ?? null : null;
}

export function checkFile(rawName: string, buf: Buffer): FileCheck {
  const name = cleanFileName(rawName);
  if (!name || name === '.' || name === '..') return { ok: false, code: 'BAD_FILE_NAME', message: 'У файла нет имени' };
  const ext = extOf(name);
  if (!ext) return { ok: false, code: 'BAD_FILE_TYPE', message: `Такой тип файла загрузить нельзя. Можно: ${ALLOWED_TEXT}` };
  if (buf.length === 0) return { ok: false, code: 'EMPTY_FILE', message: 'Файл пустой' };
  if (buf.length > MAX_FILE_BYTES) return { ok: false, code: 'FILE_TOO_LARGE', message: 'Файл больше 25 МБ' };
  const content = sniff(buf);
  const expected: Content = ext === 'txt' || ext === 'csv' ? 'text' : ext;
  if (content !== expected) {
    return {
      ok: false,
      code: 'FILE_TYPE_MISMATCH',
      message: `Содержимое файла не соответствует расширению .${ext}: внутри — ${CONTENT_NAMES[content]}. Можно: ${ALLOWED_TEXT}`,
    };
  }
  return { ok: true, ext, mime: MIME_BY_EXT[ext], name };
}

const startsWith = (buf: Buffer, bytes: number[], at = 0) => buf.length >= at + bytes.length && bytes.every((b, i) => buf[at + i] === b);

function sniff(buf: Buffer): Content {
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf'; // %PDF-
  // PNG: сигнатура и первый блок IHDR.
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) && startsWith(buf, [0x49, 0x48, 0x44, 0x52], 12)) return 'png';
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'jpg';
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) return sniffOoxml(buf);
  return sniffText(buf);
}

/** Текст: без нулевых байтов и без разметки, которую браузер мог бы исполнить (HTML, SVG, XML). */
function sniffText(buf: Buffer): Content {
  if (buf.includes(0)) return 'unknown';
  const head = decodeText(buf.subarray(0, 4096)).replace(/^\uFEFF/, '').toLowerCase();
  if (/<(!doctype|html|svg|script|iframe|object|embed|body|head|\?xml)[\s>/]/.test(head)) return 'markup';
  return 'text';
}

/** UTF-8 (с BOM или без), иначе Windows-1251 — так сохраняет CSV Excel на русской Windows. */
export function decodeText(buf: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1251').decode(buf);
  }
}

// ---------------------------------------------------------------- docx / xlsx

const MAX_ENTRIES = 20_000;
const MAX_CT_BYTES = 1024 * 1024;

interface ZipEntry { name: string; method: number; compSize: number; localOffset: number }

function zipEntries(buf: Buffer): ZipEntry[] | null {
  // Конец центрального каталога: сигнатура 0x06054b50 в последних 64 КБ + 22 байта.
  const from = Math.max(0, buf.length - 65_557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES || cdOffset + cdSize > buf.length) return null;
  const out: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen > buf.length) return null;
    out.push({ name: buf.toString('utf8', p + 46, p + 46 + nameLen), method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function readEntry(buf: Buffer, e: ZipEntry): Buffer | null {
  const p = e.localOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== 0x04034b50) return null;
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  if (start + e.compSize > buf.length || e.compSize > MAX_CT_BYTES) return null;
  const raw = buf.subarray(start, start + e.compSize);
  try {
    if (e.method === 0) return raw;
    if (e.method === 8) return inflateRawSync(raw, { maxOutputLength: MAX_CT_BYTES });
  } catch {
    return null;
  }
  return null;
}

function sniffOoxml(buf: Buffer): Content {
  const entries = zipEntries(buf);
  if (!entries) return 'zip';
  const names = new Set(entries.map((e) => e.name));
  const lower = entries.map((e) => e.name.toLowerCase());
  if (lower.some((n) => n.endsWith('vbaproject.bin') || n.includes('/activex/'))) return 'macro';
  const ct = entries.find((e) => e.name === '[Content_Types].xml');
  const xml = ct ? readEntry(buf, ct)?.toString('utf8') : undefined;
  if (!xml) return 'zip';
  if (/macroenabled/i.test(xml)) return 'macro';
  if (names.has('word/document.xml') && xml.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml')) return 'docx';
  if (names.has('xl/workbook.xml') && xml.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml')) return 'xlsx';
  return 'zip';
}
