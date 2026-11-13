// Синтетика системных цепочек (1.14.0) для e2e и скриншотов: две группы «Уязвимостей» «E2E-…» по PER_GROUP находок
// с CVE-2099-NNNNN (файл собирается из образца сканера), передача ИКТ сегодня, напоминание за 200 дней до «Срока
// устранения» метке без участников — PER_GROUP × 2 задач «не назначен» в Backlog. Группы и задачи удаляет vulns-cleanup.mjs.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { portalToday } from './browser.mjs';

const SAMPLE = fileURLToPath(new URL('../../backend/test/fixtures/vuln-windows-2026-10-15.xlsx', import.meta.url));
const ExcelJS = createRequire(new URL('../../backend/package.json', import.meta.url))('exceljs');
export const PER_GROUP = 26;

export function chainsKit(ui, tmp) {
  const api = (path, init) => ui.evaluate(`fetch(${JSON.stringify(path)}, ${JSON.stringify(init ?? {})}).then(async (r) => ({ status: r.status, body: r.status === 204 ? null : await r.json() }))`);
  async function call(method, path, body) {
    const r = await api(path, body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.ok(r.status >= 200 && r.status < 300, `${method} ${path} → ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  }
  const q = (s) => `document.querySelector(${JSON.stringify(s)})`;
  const button = (text, within = 'document') => `[...(${within}).querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)} && !b.disabled)`;
  async function open(path, ready, what) {
    await ui.goto(`${path}${path.includes('?') ? '&' : '?'}run=${Date.now()}`);
    await ui.waitFor(ready, what);
  }

  /**
   * Образец сканера → новый файл: лист хостов как есть, на листе находок — первые PER_GROUP строк с CVE-2099-NNNNN
   * (тег группы в номере). Значения копируются (формулы — результатом): exceljs не вырезает строки с общими формулами.
   */
  async function syntheticScan(tag) {
    const src = new ExcelJS.Workbook();
    await src.xlsx.readFile(SAMPLE);
    const out = new ExcelJS.Workbook();
    const plain = (v) => (v && typeof v === 'object' && 'result' in v ? v.result : v && typeof v === 'object' && 'formula' in v ? null : v);
    for (const ws of src.worksheets) {
      const to = out.addWorksheet(ws.name);
      let cveCol = 0;
      ws.getRow(1).eachCell((cell, c) => {
        const v = String(cell.value ?? '').trim().toLowerCase();
        if (v === 'cve' || v.startsWith('идентификатор')) cveCol = c;
      });
      const last = cveCol ? Math.min(ws.rowCount, 1 + PER_GROUP) : ws.rowCount;
      for (let r = 1; r <= last; r++) {
        const values = (ws.getRow(r).values ?? []).map(plain);
        if (cveCol && r > 1) values[cveCol] = `CVE-2099-${tag}${String(r - 1).padStart(3, '0')}`;
        to.getRow(r).values = values;
      }
    }
    const file = join(tmp, `vuln-windows-${portalToday()}-${tag}.xlsx`);
    await out.xlsx.writeFile(file);
    return file;
  }

  async function groupWithScan(name, tag) {
    const types = (await call('GET', '/api/v1/catalogs/system_types/items')).items;
    const windows = types.find((t) => t.value === 'Windows');
    const g = await call('POST', '/api/v1/vulns/groups', { name, kind: tag === '10' ? 'service' : 'department', systemTypeIds: [windows.id] });
    const node = g.nodes[0];
    await open(`/vulns/node/${node.id}`, `!!${button('Импорт скана')}`, 'экран узла');
    await ui.click(button('Импорт скана'));
    await ui.waitFor(`!!${q('[role=dialog][aria-label="Импорт скана"]')}`, 'окно импорта');
    await ui.setFiles('[role=dialog] input[type=file]', [await syntheticScan(tag)]);
    await ui.waitFor(`!!document.querySelector('[role=dialog] .v-dcards')`, 'предпросмотр', 20_000);
    await ui.click(`document.querySelector('[role=dialog] .btn.primary')`, 'Загрузить');
    await ui.waitFor(`location.pathname.startsWith('/vulns/scan/')`, 'экран скана', 30_000);
    const scanId = await ui.evaluate(`location.pathname.split('/').pop()`);
    await call('POST', `/api/v1/vulns/scans/${scanId}/handover`, { date: portalToday() });
    return { ...g, node, title: `Уязвимости · ${name}` };
  }

  /** Две группы со сканами и правило напоминания; прогон правил. Возвращает группы и правило. */
  async function setup(run) {
    const a = await groupWithScan(`${run} Сервис А`, '10');
    const b = await groupWithScan(`${run} Отдел Б`, '20');
    const label = await call('POST', '/api/v1/catalogs/notify_recipients/items', { value: `${run} Дежурные` });
    // Реестр «Уязвимости» — системный, systemKey есть только в карточке реестра.
    let reg;
    for (const r of (await call('GET', '/api/v1/registers')).items.filter((x) => x.system)) {
      const d = await call('GET', `/api/v1/registers/${r.id}`);
      if (d.systemKey === 'vulns') reg = d;
    }
    const due = reg.fields.find((f) => f.label === 'Срок устранения');
    const rule = await call('POST', `/api/v1/registers/${reg.id}/automations`, {
      condition: { kind: 'before', fieldId: due.id, days: 200 },
      action: { eventType: 'remind', recipients: [{ kind: 'label', itemId: label.id }] },
    });
    const result = await call('POST', `/api/v1/registers/${reg.id}/automations/run`);
    assert.ok(result.tasksCreated >= 2 * PER_GROUP, `напоминаний ${result.tasksCreated}`);
    return { groups: { a, b }, rule };
  }

  return { call, q, button, open, setup };
}
