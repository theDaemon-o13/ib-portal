// Настоящие маленькие файлы для сквозных тестов и загрузка их тем же путём, что и браузер.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sleep } from './browser.mjs';

/** PDF из одной страницы с текстом (стандартный шрифт Helvetica — pdf.js берёт его из standard_fonts сборки). */
export function tinyPdf(text = 'IB portal e2e PDF') {
  const content = `BT /F1 24 Tf 72 720 Td (${text.replace(/[()\\]/g, '')}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

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
