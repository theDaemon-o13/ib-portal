// Минимальное описание archiver@5 — только то, что использует выгрузка zip (modules/registers/export-zip.ts).
// @types/archiver не подключаем: пакет archiver уже был в дереве (зависимость exceljs), новых загрузок нет.
declare module 'archiver' {
  import type { Readable, Transform } from 'node:stream';

  interface EntryData {
    name: string;
    date?: Date;
  }

  interface ArchiverOptions {
    zlib?: { level?: number };
  }

  interface Archiver extends Transform {
    append(source: Readable | Buffer | string, data: EntryData): this;
    finalize(): Promise<void>;
    abort(): this;
    pointer(): number;
  }

  function archiver(format: 'zip', options?: ArchiverOptions): Archiver;
  export default archiver;
  export type { Archiver };
}
