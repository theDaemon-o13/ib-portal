// Синтетический отчёт сканера Linux (Debian) для тестов массового импорта (1.13.9, docs/tasks/1.13.9-vuln-import-timeout.md).
// Структура — как у реального отчёта, данные вымышленные: пакеты pkg-0001…, идентификаторы CVE-2099-NNNNN,
// хост test-host.example.com (192.0.2.10 — адрес из TEST-NET-1). Реальные отчёты банка в репозиторий не попадают.
import ExcelJS from 'exceljs';

export const SYNTHETIC_HEADERS = ['Пакет', 'CVE', 'Уровень', 'CVSS', 'Эксплойт', 'Вектор', 'Обновить до версии', 'Задача №', 'Описание (из CVE, англ.)'] as const;
export const SYNTHETIC_VECTORS = ['Сеть', 'Локально', 'Смежная сеть', 'Физический'] as const;
export const SYNTHETIC_HOST = { name: 'test-host.example.com', ip: '192.0.2.10', os: 'Debian 12' };

export interface SyntheticRow {
  pkg: string;
  cve: string;
  level: string;
  cvss: number | null;
  exploit: string;
  vector: string | null;
  fixVersion: string | null;
  task: string | null;
  desc: string;
}

/** Детерминированный генератор (mulberry32): один и тот же размер — один и тот же файл. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ['buffer', 'overflow', 'in', 'the', 'parser', 'allows', 'remote', 'attackers', 'to', 'cause', 'denial', 'of', 'service', 'via', 'crafted', 'input', 'memory', 'corruption', 'privilege', 'escalation', 'local', 'users', 'information', 'disclosure', 'use-after-free', 'integer', 'handling'];

function levelOf(cvss: number): string {
  if (cvss >= 9) return 'Критическая';
  if (cvss >= 7) return 'Важная';
  if (cvss >= 4) return 'Средняя';
  return 'Низкая';
}

/**
 * Строки отчёта: ключи «Пакет + CVE» уникальны; одна CVE — у 1–3 пакетов; около 38 % строк — без CVSS и вектора
 * с Уровнем «Нет оценки»; описания до 300 символов.
 */
export function syntheticRows(count: number, seed = 1339): SyntheticRow[] {
  const rand = rng(seed + count);
  const packages = Math.max(10, Math.ceil(count / 8));
  const pkgName = (i: number) => `pkg-${String(i + 1).padStart(4, '0')}`;
  const rows: SyntheticRow[] = [];
  let cveNo = 10_000;
  while (rows.length < count) {
    const cve = `CVE-2099-${cveNo++}`;
    const share = Math.min(count - rows.length, 1 + Math.floor(rand() * 3));
    const used = new Set<number>();
    while (used.size < share) used.add(Math.floor(rand() * packages));
    const unscored = rand() < 0.38;
    const cvss = unscored ? null : Math.round((1 + rand() * 9) * 10) / 10;
    for (const p of used) {
      const words = Array.from({ length: 5 + Math.floor(rand() * 45) }, () => WORDS[Math.floor(rand() * WORDS.length)]);
      const r = rand();
      rows.push({
        pkg: pkgName(p),
        cve,
        level: cvss === null ? 'Нет оценки' : levelOf(cvss),
        cvss,
        exploit: r < 0.7 ? 'Нет данных' : r < 0.93 ? 'Есть' : 'Есть, эксплуатируется',
        vector: cvss === null ? null : SYNTHETIC_VECTORS[Math.floor(rand() * SYNTHETIC_VECTORS.length)] ?? null,
        fixVersion: rand() < 0.8 ? `${1 + Math.floor(rand() * 9)}.${Math.floor(rand() * 20)}-${1 + Math.floor(rand() * 5)}+deb12u${1 + Math.floor(rand() * 4)}` : null,
        task: rand() < 0.1 ? String(1000 + Math.floor(rand() * 9000)) : null,
        desc: words.join(' ').slice(0, 300).trim(),
      });
    }
  }
  return rows;
}

/** Книга .xlsx: лист «Хост» (заголовок в первой строке, без строки-названия) и лист «Все уязвимости». */
export async function syntheticReport(count: number, seed?: number): Promise<{ buffer: Buffer; rows: SyntheticRow[]; fileName: string }> {
  const rows = syntheticRows(count, seed);
  const wb = new ExcelJS.Workbook();
  const host = wb.addWorksheet('Хост');
  host.addRow(['Имя хоста', 'IP-адрес', 'ОС']);
  host.addRow([SYNTHETIC_HOST.name, SYNTHETIC_HOST.ip, SYNTHETIC_HOST.os]);
  const ws = wb.addWorksheet('Все уязвимости');
  ws.addRow([...SYNTHETIC_HEADERS]);
  for (const r of rows) ws.addRow([r.pkg, r.cve, r.level, r.cvss, r.exploit, r.vector, r.fixVersion, r.task, r.desc]);
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), rows, fileName: `synthetic-${count}-2026_11_10.xlsx` };
}
