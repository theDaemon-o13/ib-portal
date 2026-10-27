// Маленькие настоящие файлы для тестов загрузки: PDF, PNG, JPG, docx/xlsx (zip собирается здесь же).
import { crc32, deflateRawSync } from 'node:zlib';

/** PDF из одной страницы с текстом (латиница: стандартный шрифт Helvetica). */
export function tinyPdf(text = 'IB portal test PDF'): Buffer {
  const content = `BT /F1 24 Tf 72 720 Td (${text.replace(/[()\\]/g, '')}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** PNG 1×1 (красная точка). */
export const tinyPng = (): Buffer => Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);

/** Начало JPEG: сигнатуры достаточно для проверки типа. */
export const tinyJpg = (): Buffer => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0', 'latin1'), Buffer.alloc(32)]);

/** ZIP из переданных файлов (deflate), как у Office. */
export function makeZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8');
    const comp = deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, comp);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}

const CT = (main: string, extra = '') =>
  `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
  + `<Override PartName="/main" ContentType="${main}"/>${extra}</Types>`;

export const tinyDocx = (): Buffer => makeZip({
  '[Content_Types].xml': CT('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'),
  'word/document.xml': '<w:document/>',
});

export const tinyXlsx = (): Buffer => makeZip({
  '[Content_Types].xml': CT('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'),
  'xl/workbook.xml': '<workbook/>',
});

/** docm под видом docx: макросы. */
export const macroDocx = (): Buffer => makeZip({
  '[Content_Types].xml': CT('application/vnd.ms-word.document.macroEnabled.main+xml'),
  'word/document.xml': '<w:document/>',
  'word/vbaProject.bin': 'VBA',
});

function pdfFromObjects(objs: string[]): Buffer {
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'utf8');
}

/**
 * PDF с текстовым слоем на любом языке: однобайтовые коды и карта ToUnicode (как у PDF из Word).
 * Строки — отдельными строками страницы.
 */
export function textPdf(lines: string[]): Buffer {
  const chars = [...new Set([...lines.join('')])];
  if (chars.length > 200) throw new Error('textPdf: не больше 200 разных символов');
  const code = new Map(chars.map((c, i) => [c, i + 33]));
  const hex = (s: string) => [...s].map((c) => (code.get(c) as number).toString(16).padStart(2, '0')).join('');
  const bf = chars.map((c) => `<${(code.get(c) as number).toString(16).padStart(2, '0')}> <${(c.codePointAt(0) as number).toString(16).padStart(4, '0')}>`).join('\n');
  const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /ibportal-test def
1 begincodespacerange <00> <FF> endcodespacerange
${chars.length} beginbfchar
${bf}
endbfchar endcmap CMapName currentdict /CMap defineresource pop end end`;
  const content = `BT /F1 12 Tf 50 750 Td 16 TL ${lines.map((l) => `<${hex(l)}> Tj T*`).join(' ')} ET`;
  return pdfFromObjects([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 6 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    `<< /Length ${Buffer.byteLength(cmap)} >>\nstream\n${cmap}\nendstream`,
  ]);
}

/** «Скан»: страница только с графикой, без текстового слоя. */
export function scanPdf(): Buffer {
  const content = '0.5 g 50 50 500 700 re f 0 g 100 600 200 100 re S';
  return pdfFromObjects([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]);
}
