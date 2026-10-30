// Подпись «Спроектировано» в презентации самооценки (этап Д5, docs/self-assessment.md, раздел 10; решение владельца 2):
// app_settings.presentation.signature без миграции; правит «Настройки → Презентация» (settings.manage), кто менял —
// в журнале аудита. Держатель assessment.manage только читает; строку «Подготовил» frontend берёт из сессии.
import { withTx, type Db } from '../../lib/db.js';
import { badRequest, versionConflict } from '../../lib/errors.js';
import { auditSettings, trimmed, type Actor } from '../settings/common.js';

export const SIGNATURE_KEY = 'presentation.signature';
export const SIGNATURE_DEFAULT = 'И. Машарипов · Отдел информационной безопасности';
export const SIGNATURE_MAX = 200;

export async function getSignature(db: Db): Promise<{ signature: string; version: number }> {
  const row = await db.appSetting.findUnique({ where: { key: SIGNATURE_KEY } });
  return { signature: typeof row?.value === 'string' ? row.value : SIGNATURE_DEFAULT, version: row?.version ?? 0 };
}

export async function setSignature(db: Db, actor: Actor, input: { signature: string; version: number }) {
  const signature = trimmed(input.signature);
  if (!signature) throw badRequest('EMPTY_SIGNATURE', 'Укажите текст подписи');
  if (signature.length > SIGNATURE_MAX) throw badRequest('TOO_LONG', `Подпись — не длиннее ${SIGNATURE_MAX} символов`);
  return withTx(db, async (tx) => {
    const current = await getSignature(tx);
    if (current.version !== input.version) throw versionConflict();
    if (current.signature === signature) return current;
    await tx.appSetting.upsert({
      where: { key: SIGNATURE_KEY },
      create: { key: SIGNATURE_KEY, value: signature },
      update: { value: signature, version: { increment: 1 } },
    });
    await auditSettings(tx, actor, {
      action: 'settings.presentation.updated', entity: 'presentation', entityId: SIGNATURE_KEY,
      summary: `Презентация самооценки: подпись «${current.signature}» → «${signature}»`,
      before: { signature: current.signature }, after: { signature },
    });
    return getSignature(tx);
  });
}
