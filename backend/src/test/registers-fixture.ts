// Тестовый реестр со всеми типами полей.
import * as structure from '../modules/registers/structure.service.js';
import { loadRegister, type RegisterDef } from '../modules/registers/definition.js';
import { actorFor, makeUser, type Tx } from './db.js';

export interface Fixture {
  actor: Awaited<ReturnType<typeof actorFor>>;
  adminId: string;
  reg: RegisterDef;
  f: Record<'title' | 'status' | 'level' | 'score' | 'found' | 'owner' | 'due' | 'newDue' | 'decision', string>;
  opt: (fieldKey: keyof Fixture['f'], label: string) => string;
  reload: () => Promise<RegisterDef>;
}

export async function makeRegister(tx: Tx, name = `Тестовый реестр ${Date.now().toString(36)}`): Promise<Fixture> {
  const admin = await makeUser(tx, ['super_admin', 'ib_staff']);
  const actor = await actorFor(tx, admin.id);
  let reg = await structure.createRegister(tx, actor, { name });
  const add = async (label: string, type: Parameters<typeof structure.addField>[3]['type'], extra: Partial<Parameters<typeof structure.addField>[3]> = {}) => {
    reg = await structure.addField(tx, actor, reg.id, { label, type, ...extra });
    return reg.fields.find((f) => f.label === label)?.id as string;
  };
  const level = await add('Уровень', 'select', { options: ['Высокий', 'Средний', 'Низкий'], analyticsRole: 'dimension' });
  const score = await add('Баллы', 'number');
  const found = await add('Выявлено', 'date');
  const owner = await add('Ответственный', 'user');
  const newDue = await add('Новый срок', 'date');
  const lv = reg.fields.find((f) => f.id === level);
  const days = Object.fromEntries((lv?.options ?? []).filter((o) => o.label !== 'Низкий').map((o) => [o.id, o.label === 'Высокий' ? 14 : 30]));
  const due = await add('Срок устранения', 'calc', { calcRule: { fromFieldId: found, byFieldId: level, days, overrideFieldId: newDue }, analyticsRole: 'deadline' });
  const decision = await add('Решение ОУР', 'decision', { options: ['Ожидает решения', 'Принят', 'Отклонён'] });
  const title = reg.fields.find((f) => f.isTitle)?.id as string;
  const status = reg.fields.find((f) => f.isStatus)?.id as string;
  const f = { title, status, level, score, found, owner, due, newDue, decision };
  return {
    actor,
    adminId: admin.id,
    reg,
    f,
    opt: (key, label) => {
      const field = reg.fields.find((x) => x.id === f[key]);
      const o = field?.options.find((x) => x.label === label);
      if (!o) throw new Error(`нет варианта ${label}`);
      return o.id;
    },
    reload: async () => (reg = await loadRegister(tx, reg.id)),
  };
}
