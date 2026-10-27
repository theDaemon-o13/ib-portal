// Статус основания (сверка с DLP, этап 8б): вычисляемое поле kind = link_basis.
// Для записи «Устройства DLP» по каналу (Соцсети, Облако) ищутся разрешения, которые ссылаются на устройство
// полем «Связь с записью» и имеют нужный «Вид». Сверка — по связи, не по ФИО. Вычисляется при чтении, не хранится.
//   closed  — канал закрыт (значение канала не задано или из списка «закрыто»);
//   ok      — есть действующее разрешение (статус «действует», срок не прошёл): №, до;
//   expired — разрешения были, но действующего нет (истекло, отозвано, срок прошёл);
//   none    — канал открыт, разрешений нет.

export interface BasisRule {
  kind: 'link_basis';
  /** Поле-канал записи (список): значение доступа в Device Monitor. */
  channelFieldId: string;
  /** Значения канала, при которых доступ закрыт («Запрещены»). */
  closedOptionIds: string[];
  /** Реестр разрешений и его поля. */
  sourceRegisterId: string;
  /** Поле «Связь с записью» в реестре разрешений, которое ссылается на этот реестр. */
  linkFieldId: string;
  /** Поле «Вид» разрешения и значение, которое подходит каналу. null — любой вид. */
  kindFieldId: string | null;
  kindOptionIds: string[];
  /** Поле статуса разрешения и «действующие» значения. */
  statusFieldId: string;
  activeOptionIds: string[];
  /** Поле «Действует до» (дата); null — срок не проверяется. */
  untilFieldId: string | null;
  /** Поле номера документа — для текста «разрешение №…»; null — номер записи. */
  numberFieldId: string | null;
}

export const BASIS_STATES = ['ok', 'none', 'expired', 'closed'] as const;
export type BasisState = (typeof BASIS_STATES)[number];

export const BASIS_STATE_NAMES: Record<BasisState, string> = {
  ok: 'есть основание',
  none: 'нет основания',
  expired: 'истекло',
  closed: 'канал закрыт',
};

export interface SourceRecord {
  id: string;
  number: number;
  values: Record<string, unknown>;
}

export interface BasisResult {
  state: BasisState;
  /** Разрешение, на котором основан статус: действующее (ok) или последнее по сроку (expired). */
  permission: { id: string; number: number; docNumber: string; until: string | null } | null;
}

export function isBasisRule(rule: unknown): rule is BasisRule {
  return !!rule && typeof rule === 'object' && (rule as { kind?: unknown }).kind === 'link_basis';
}

/** Ссылается ли разрешение на запись (значение поля связи — массив id). */
export function linksTo(values: Record<string, unknown>, fieldId: string, recordId: string): boolean {
  const v = values[fieldId];
  return Array.isArray(v) && v.includes(recordId);
}

export function basisOf(rule: BasisRule, recordId: string, values: Record<string, unknown>, sources: readonly SourceRecord[], today: string): BasisResult {
  const channel = values[rule.channelFieldId];
  if (typeof channel !== 'string' || rule.closedOptionIds.includes(channel)) return { state: 'closed', permission: null };
  const mine = sources.filter((s) => linksTo(s.values, rule.linkFieldId, recordId)
    && (!rule.kindFieldId || rule.kindOptionIds.includes(String(s.values[rule.kindFieldId] ?? ''))));
  if (!mine.length) return { state: 'none', permission: null };
  const until = (s: SourceRecord) => {
    const u = rule.untilFieldId ? s.values[rule.untilFieldId] : null;
    return typeof u === 'string' ? u : null;
  };
  const dto = (s: SourceRecord) => ({
    id: s.id,
    number: s.number,
    docNumber: rule.numberFieldId && typeof s.values[rule.numberFieldId] === 'string' ? String(s.values[rule.numberFieldId]) : `#${s.number}`,
    until: until(s),
  });
  // Поздний срок — первым; без срока — как бессрочное.
  const byUntil = [...mine].sort((a, b) => (until(b) ?? '9999-12-31').localeCompare(until(a) ?? '9999-12-31') || b.number - a.number);
  const active = byUntil.find((s) => rule.activeOptionIds.includes(String(s.values[rule.statusFieldId] ?? ''))
    && (until(s) === null || (until(s) as string) >= today));
  if (active) return { state: 'ok', permission: dto(active) };
  return { state: 'expired', permission: dto(byUntil[0] as SourceRecord) };
}

export function basisText(r: BasisResult): string {
  const p = r.permission;
  const until = p?.until ? ` до ${p.until.split('-').reverse().join('.')}` : '';
  if (r.state === 'ok' && p) return `есть основание — разрешение ${p.docNumber}${until}`;
  if (r.state === 'expired' && p) return `истекло — разрешение ${p.docNumber}${until}`;
  return BASIS_STATE_NAMES[r.state];
}
