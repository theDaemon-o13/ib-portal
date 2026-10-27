// Фоновое извлечение текста PDF (этап 8б): строки file_texts в статусе pending разбираются по одной вне транзакции
// (разбор — до 30 с в отдельном потоке, lib/pdf-text.ts). Неудача — до трёх попыток, затем failed.
// Повторный прогон безопасен: строка берётся с блокировкой SKIP LOCKED и сразу получает попытку.
import type { Readable } from 'node:stream';
import type { Db } from '../../lib/db.js';
import type { FileStore } from '../../lib/file-store.js';
import { extractPdfText, type PdfTextResult } from '../../lib/pdf-text.js';

export const TEXT_MAX_ATTEMPTS = 3;

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string));
  return Buffer.concat(chunks);
}

export interface TextRunResult {
  processed: number;
  text: number;
  noText: number;
  failed: number;
}

export async function processPendingTexts(
  db: Db, store: FileStore, opts: { limit?: number; extract?: (data: Buffer) => Promise<PdfTextResult> } = {},
): Promise<TextRunResult> {
  const extract = opts.extract ?? extractPdfText;
  const res: TextRunResult = { processed: 0, text: 0, noText: 0, failed: 0 };
  for (let i = 0; i < (opts.limit ?? 20); i++) {
    // Взять одну строку и сразу засчитать попытку: второй экземпляр backend её пропустит.
    const [job] = await db.$queryRaw<{ file_id: string; storage_key: string; attempts: number }[]>`
      UPDATE file_texts t SET attempts = t.attempts + 1
      FROM files f
      WHERE t.file_id = (
        SELECT x.file_id FROM file_texts x JOIN files y ON y.id = x.file_id
        WHERE x.status = 'pending' AND x.attempts < ${TEXT_MAX_ATTEMPTS} AND y.deleted_at IS NULL
        ORDER BY x.created_at LIMIT 1 FOR UPDATE OF x SKIP LOCKED)
        AND f.id = t.file_id
      RETURNING t.file_id::text, f.storage_key, t.attempts`;
    if (!job) break;
    let r: PdfTextResult;
    try {
      r = await extract(await readAll(store.open(job.storage_key)));
    } catch (err) {
      r = { status: 'failed', error: `файл не прочитан: ${(err as Error).message}`.slice(0, 300) };
    }
    res.processed++;
    if (r.status === 'failed' && job.attempts < TEXT_MAX_ATTEMPTS) {
      await db.fileText.update({ where: { fileId: job.file_id }, data: { error: r.error } });
      res.failed++;
      continue;
    }
    await db.fileText.update({
      where: { fileId: job.file_id },
      data: r.status === 'text'
        ? { status: 'text', content: r.text, pages: r.pages, error: null, extractedAt: new Date() }
        : r.status === 'no_text'
          ? { status: 'no_text', content: null, pages: r.pages, error: null, extractedAt: new Date() }
          : { status: 'failed', error: r.error, extractedAt: new Date() },
    });
    if (r.status === 'text') res.text++;
    else if (r.status === 'no_text') res.noText++;
    else res.failed++;
  }
  return res;
}
