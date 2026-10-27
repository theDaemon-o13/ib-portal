// Хранилище содержимого файлов (CLAUDE.md 3.7): FILES_DIR/<yyyy>/<mm>/<uuid>, исходное имя в пути не используется.
// Запись атомарная: временный файл → fsync → rename. Удаления здесь нет: файлы физически не удаляются.
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

const KEY_RE = /^\d{4}\/\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface FileStore {
  /** Сохранить содержимое; возвращает ключ «yyyy/mm/uuid». */
  put(data: Buffer, now?: Date): Promise<string>;
  open(key: string): Readable;
  /** Размер файла на диске; null — файла нет. */
  size(key: string): Promise<number | null>;
  readonly root: string;
}

function pathOf(root: string, key: string): string {
  if (!KEY_RE.test(key)) throw new Error(`недопустимый ключ файла: ${key}`);
  return join(root, ...key.split('/'));
}

export function diskFileStore(root: string): FileStore {
  return {
    root,
    async put(data, now = new Date()) {
      const yyyy = String(now.getUTCFullYear());
      const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
      const id = randomUUID();
      const key = `${yyyy}/${mm}/${id}`;
      const dir = join(root, yyyy, mm);
      const tmpDir = join(root, 'tmp');
      await mkdir(dir, { recursive: true, mode: 0o750 });
      await mkdir(tmpDir, { recursive: true, mode: 0o750 });
      const tmp = join(tmpDir, `${id}.part`);
      const fh = await open(tmp, 'wx', 0o640);
      try {
        await fh.writeFile(data);
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, pathOf(root, key));
      return key;
    },
    open(key) {
      return createReadStream(pathOf(root, key));
    },
    async size(key) {
      try {
        return (await stat(pathOf(root, key))).size;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
  };
}
