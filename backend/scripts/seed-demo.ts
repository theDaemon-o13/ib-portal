// Демо-данные для dev (CLAUDE.md 3.8): только база *_dev и не production. Повторный запуск ничего не дублирует.
// 1.12.0: два вымышленных шаблона учебных писем с выделенными блоками обоих видов («Просьба» и «Предупреждение»).
// Данных банка нет: тексты вымышленные, адрес — example.org.
//   npm run seed:demo   (в dev-контейнере backend: docker exec ibportal-dev-backend-1 npm run seed:demo)
import { createPrisma } from '../src/lib/db.js';

export const DEMO_TEMPLATES = [
  {
    title: 'Срочное предупреждение',
    subjectRu: 'Внимание: поддельные письма от имени «службы поддержки»',
    subjectTj: 'Диққат: мактубҳои қалбакӣ аз номи «хадамоти дастгирӣ»',
    headerRu: 'Поддельные письма', headerTj: 'Мактубҳои қалбакӣ',
    htmlRu: '<p><strong>Уважаемые коллеги!</strong></p><p>Сегодня злоумышленники рассылают письма с просьбой «подтвердить учётную запись». Ссылка ведёт на поддельную страницу входа.</p>'
      + '<div data-callout="warn"><p><strong>Не делайте этого:</strong></p><p>Не переходите по ссылке и не вводите пароль. Отдел ИБ никогда не запрашивает пароли.</p></div>'
      + '<div data-callout="info"><p><strong>Просьба:</strong></p><p>Перешлите такое письмо на <a href="mailto:security@example.org">security@example.org</a> и удалите его.</p></div>',
    htmlTj: '<p><strong>Ҳамкорони муҳтарам!</strong></p><p>Имрӯз қаллобон мактубҳо мефиристанд, ки «ҳисобро тасдиқ кунед». Пайванд ба саҳифаи қалбакӣ мебарад.</p>'
      + '<div data-callout="warn"><p><strong>Ин корро накунед:</strong></p><p>Ба пайванд гузаред ва рамзро ворид накунед.</p></div>'
      + '<div data-callout="info"><p><strong>Хоҳиш:</strong></p><p>Мактубро ба <a href="mailto:security@example.org">security@example.org</a> фиристед ва нест кунед.</p></div>',
  },
  {
    title: 'Плановая памятка',
    subjectRu: 'Памятка: {{тема памятки}}',
    subjectTj: 'Ёддошт: {{тема памятки}}',
    headerRu: '', headerTj: '',
    htmlRu: '<p><strong>Уважаемые коллеги!</strong></p><p>Напоминаем простые правила: {{тема памятки}}.</p>'
      + '<div data-callout="info"><p><strong>Что сделать:</strong></p><ul><li><p>Используйте разные пароли для разных систем.</p></li><li><p>Блокируйте компьютер, когда отходите.</p></li></ul></div>'
      + '<div data-callout="warn"><p><strong>Важно:</strong></p><p>Никому не сообщайте коды из SMS.</p></div>',
    htmlTj: '<p><strong>Ҳамкорони муҳтарам!</strong></p><p>Қоидаҳои соддаро хотиррасон мекунем: {{тема памятки}}.</p>'
      + '<div data-callout="info"><p><strong>Чӣ бояд кард:</strong></p><ul><li><p>Барои системаҳои гуногун рамзҳои гуногун истифода баред.</p></li></ul></div>'
      + '<div data-callout="warn"><p><strong>Муҳим:</strong></p><p>Рамзҳои SMS-ро ба касе нагӯед.</p></div>',
  },
] as const;

/** Отказ: production или база не *_dev. */
export function demoGuard(env: NodeJS.ProcessEnv): string | null {
  if (env.NODE_ENV === 'production') return 'seed:demo не работает при NODE_ENV=production';
  const name = (() => {
    try {
      return new URL(env.DATABASE_URL ?? '').pathname.replace(/^\//, '');
    } catch {
      return '';
    }
  })();
  if (!name.endsWith('_dev')) return `seed:demo работает только с базой *_dev (сейчас: «${name || 'не задана'}»)`;
  return null;
}

async function main() {
  const refuse = demoGuard(process.env);
  if (refuse) {
    console.error(refuse);
    process.exit(1);
  }
  const prisma = createPrisma();
  try {
    const author = await prisma.user.findFirst({ where: { isActive: true, roles: { some: { role: { code: 'super_admin' } } } }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    if (!author) throw new Error('нет активного супер-администратора — сначала create-admin');
    const done: string[] = [];
    for (const t of DEMO_TEMPLATES) {
      if (await prisma.awarenessTemplate.findFirst({ where: { title: t.title } })) continue;
      await prisma.awarenessTemplate.create({ data: { ...t, createdBy: author.id, updatedBy: author.id } });
      done.push(`«${t.title}»`);
    }
    console.log(done.length ? `Демо-шаблоны писем: ${done.join(', ')}` : 'Демо-шаблоны писем уже есть');
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1]?.endsWith('seed-demo.ts') || process.argv[1]?.endsWith('seed-demo.js')) void main();
