// «Экземпляр» компонента (1.6.1) — заголовок записи «Компонентов»: пересчитывается при любой записи (форма, импорт),
// когда меняются «Компонент», «Среда», «IP-адрес» или «Порт». Вручную поле не правится (служебное).
import type { Values } from '../../lib/register-values.js';
import type { RegisterDef } from '../registers/definition.js';
import { ASSET_COMPONENTS_KEY } from './definition.js';
import { componentInstance } from './service-registry.js';

const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function deriveComponentInstance(reg: RegisterDef, values: Values, edited: readonly string[], isNew: boolean): string[] {
  if (reg.systemKey !== ASSET_COMPONENTS_KEY) return [];
  const f = (k: string) => reg.fields.find((x) => x.systemKey === k);
  const [instance, title, env, ip, port] = ['instance', 'title', 'env', 'ip', 'port'].map(f);
  if (!instance || !title) return [];
  if (!isNew && ![title, env, ip, port].some((x) => x && edited.includes(x.id))) return [];
  const envLabel = env?.options.find((o) => o.id === values[env.id])?.label ?? '';
  const want = componentInstance(str(values[title.id]), envLabel, ip ? str(values[ip.id]) : '', port ? str(values[port.id]) : '');
  const have = values[instance.id];
  if ((want || undefined) === have) return [];
  // Пустой экземпляр (нет «Компонента») — поле очищается, как null в форме.
  if (want) values[instance.id] = want;
  else Reflect.deleteProperty(values, instance.id);
  return [instance.id];
}

/** Обязательное для новой записи поле: обычно заголовок; у «Компонентов» — «Компонент», из него считается «Экземпляр». */
export function requiredTitleField<F extends { isTitle: boolean; archived: boolean; systemKey: string | null }>(reg: { systemKey: string | null; fields: F[] }): F | undefined {
  const title = reg.fields.find((f) => f.isTitle && !f.archived);
  if (reg.systemKey !== ASSET_COMPONENTS_KEY || title?.systemKey !== 'instance') return title;
  return reg.fields.find((f) => f.systemKey === 'title' && !f.archived) ?? title;
}
