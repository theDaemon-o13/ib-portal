// Настоящие маленькие файлы для сквозных тестов и загрузка их тем же путём, что и браузер.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { sleep } from './browser.mjs';

/** PDF из одной страницы с текстом (стандартный шрифт Helvetica — pdf.js берёт его из standard_fonts сборки). */
export function tinyPdf(text = 'IB portal e2e PDF') {
  return pagesPdf([text]);
}

/** PDF из нескольких страниц: на каждой — свой текст (просмотрщик, навигация по страницам). */
export function pagesPdf(texts) {
  const n = texts.length;
  // 1 — каталог, 2 — список страниц, 3 — шрифт; дальше по паре объектов на страницу: страница и её содержимое.
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = [];
  texts.forEach((text, i) => {
    const pageNo = 4 + i * 2;
    const content = `BT /F1 24 Tf 72 720 Td (${text.replace(/[()\\]/g, '')}) Tj ET`;
    kids.push(`${pageNo} 0 R`);
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${pageNo + 1} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  objs[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${n} >>`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** ZIP из текстовых файлов (deflate) — основа .docx. */
function makeZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8');
    const comp = deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, comp);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}

/** Минимальный .docx: backend узнаёт его по [Content_Types].xml и word/document.xml. */
export const tinyDocx = () => makeZip({
  '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  'word/document.xml': '<w:document/>',
});

/** PNG 1×1. */
export const tinyPng = () => Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

const dir = mkdtempSync(join(tmpdir(), 'ibportal-e2e-files-'));
process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
/** Записать файл во временный каталог (для выбора в <input type=file>); возвращает путь. */
export function tempFile(name, data) {
  const p = join(dir, name);
  writeFileSync(p, data);
  return p;
}

/** Загрузить файл через API из страницы (вход — текущая cookie браузера). */
export async function uploadViaApi(ui, name, data) {
  const res = await ui.evaluate(`(async () => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(Buffer.from(data).toString('base64'))}), (c) => c.charCodeAt(0));
    const r = await fetch('/api/v1/files', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(${JSON.stringify(name)}) }, body: bytes });
    return { status: r.status, text: await r.text() };
  })()`);
  if (res.status !== 201) throw new Error(`загрузка ${name} → ${res.status} ${res.text}`);
  return JSON.parse(res.text);
}

/** Выбрать файлы в поле загрузки и дождаться ответов POST /files. */
export async function pickFiles(ui, inputSelector, paths) {
  const m = ui.mark();
  await ui.setFiles(inputSelector, paths);
  const t0 = Date.now();
  while (ui.requestsSince(m).filter((r) => r.method === 'POST' && r.url === '/api/v1/files' && r.status !== null).length < paths.length) {
    if (Date.now() - t0 > 8000) throw new Error(`не дождались загрузки: ${paths.join(', ')}`);
    await sleep(50);
  }
  await sleep(150);
  return ui.requestsSince(m).filter((r) => r.method === 'POST' && r.url === '/api/v1/files');
}
