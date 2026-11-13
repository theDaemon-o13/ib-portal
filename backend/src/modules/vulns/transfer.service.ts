// «Перенести» и «Перенести выбранные» (релиз 1.5.0, ADR-0029): записи из «Без группы / Из прежнего реестра» — в узел.
// Ключ «Пакет + Идентификатор» уникален в узле: запись, ключ которой в узле уже есть (или повторяется среди
// выбранных), не переносится — отказ по строке, остальные переносятся. «Срок из прежнего реестра» сохраняется.
import { BULK_TX, withTx, type Db } from '../../lib/db.js';
import { badRequest, conflict } from '../../lib/errors.js';
import type { Values } from '../../lib/register-values.js';
import { loadRegister } from '../registers/definition.js';
import { auditSettings, auditSettingsMany, type Actor, type SettingsAuditEntry } from '../settings/common.js';
import { VULN_REGISTER_KEY, vulnFields } from './definition.js';
import { loadNode, nodeLabel } from './groups.service.js';
import { keyNorm } from './keys.js';
import { followRecordsToGroup } from '../tasks/system-chains.js';

export const TRANSFER_MAX = 1000;

export interface TransferResult {
  moved: { id: string; number: number }[];
  rejected: { id: string; number: number | null; title: string; reason: string }[];
}

export async function transferRecords(db: Db, actor: Actor, input: { recordIds: string[]; nodeId: string }): Promise<TransferResult> {
  const ids = [...new Set(input.recordIds)];
  if (!ids.length) throw badRequest('NOTHING_SELECTED', 'Выберите записи для переноса');
  if (ids.length > TRANSFER_MAX) throw badRequest('TOO_MANY', `Не больше ${TRANSFER_MAX} записей за раз`);
  return withTx(db, async (tx) => {
    const target = await loadNode(tx, input.nodeId);
    if (target.systemKey) throw conflict('LEGACY_TARGET', 'Переносят в узел группы, а не в «Без группы»');
    const regRow = await tx.register.findUniqueOrThrow({ where: { systemKey: VULN_REGISTER_KEY } });
    const reg = await loadRegister(tx, regRow.id);
    const vf = vulnFields(reg);
    const rows = await tx.$queryRaw<{ id: string; number: number; values: Values; archived_at: Date | null; deleted_at: Date | null; node_key: string | null }[]>`
      SELECT r.id::text, r.number, r."values", r.archived_at, r.deleted_at, n.system_key AS node_key
      FROM vuln_records v JOIN register_records r ON r.id = v.record_id JOIN vuln_nodes n ON n.id = v.node_id
      WHERE v.record_id = ANY(${ids}::uuid[]) FOR UPDATE OF v`;
    const taken = new Map((await tx.vulnRecord.findMany({
      where: { nodeId: target.id, keyNorm: { not: null } }, select: { keyNorm: true, record: { select: { number: true } } },
    })).map((r) => [r.keyNorm as string, r.record.number]));
    const result: TransferResult = { moved: [], rejected: [] };
    // Пачкой (1.13.9): узел и ключ — одним запросом, журнал — createMany, в прежнем порядке.
    const moves: { id: string; k: string }[] = [];
    const audits: SettingsAuditEntry[] = [];
    const reject = (id: string, number: number | null, title: string, reason: string) => result.rejected.push({ id, number, title, reason });
    for (const id of ids) {
      const r = rows.find((x) => x.id === id);
      if (!r) {
        reject(id, null, '', 'Запись не найдена в разделе «Уязвимости»');
        continue;
      }
      const values = r.values ?? {};
      const pkg = vf.pkg.options.find((o) => o.id === values[vf.pkg.id])?.label;
      const cve = typeof values[vf.cve.id] === 'string' ? (values[vf.cve.id] as string) : '';
      const title = [pkg?.trim(), cve.trim()].filter(Boolean).join(' · ') || `#${r.number}`;
      if (r.node_key !== 'legacy') reject(id, r.number, title, 'Переносятся только записи из «Без группы»');
      else if (r.deleted_at) reject(id, r.number, title, 'Запись удалена');
      else if (r.archived_at) reject(id, r.number, title, 'Запись в архиве — верните её, чтобы перенести');
      else if (!pkg || !cve.trim()) reject(id, r.number, title, 'Нет пакета или идентификатора — ключ «Пакет + Идентификатор» не определить');
      else {
        const key = keyNorm(pkg, cve);
        const other = taken.get(key);
        if (other !== undefined) {
          reject(id, r.number, title, `В узле уже есть «${title}» (#${other})`);
          continue;
        }
        taken.set(key, r.number);
        moves.push({ id, k: key });
        audits.push({
          action: 'vuln.record.transferred', entity: 'register_record', entityId: id,
          summary: `«${reg.name}», запись #${r.number}: перенесена из «Без группы» в «${nodeLabel(target)}»`,
          after: { nodeId: target.id, via: 'transfer' },
        });
        result.moved.push({ id, number: r.number });
      }
    }
    if (moves.length) {
      await tx.$executeRaw`
        UPDATE vuln_records AS v SET node_id = ${target.id}::uuid, key_norm = d.k, version = v.version + 1, updated_at = now()
        FROM jsonb_to_recordset(${JSON.stringify(moves)}::jsonb) AS d(id uuid, k text)
        WHERE v.record_id = d.id`;
    }
    await auditSettingsMany(tx, actor, audits);
    // Системные цепочки (1.14.0, ADR-0053): незавершённые задачи записей — в цепочку новой группы.
    await followRecordsToGroup(tx, actor, result.moved, { id: target.group.id, name: target.group.name });
    if (result.moved.length > 1 || result.rejected.length) {
      await auditSettings(tx, actor, {
        action: 'vuln.records.transferred', entity: 'vuln_node', entityId: target.id,
        summary: `Уязвимости: в «${nodeLabel(target)}» перенесено из «Без группы» ${result.moved.length}, не перенесено ${result.rejected.length}`,
        after: { moved: result.moved.map((m) => m.number), rejected: result.rejected.map((x) => ({ number: x.number, reason: x.reason })) },
      });
    }
    return result;
  }, BULK_TX);
}
