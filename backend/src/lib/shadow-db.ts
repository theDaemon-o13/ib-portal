// Теневая база Prisma (migrate diff, migrate dev) очищается Prisma целиком. Поэтому она всегда отдельная
// одноразовая: имя оканчивается на _shadow, скрипт сам её создаёт и удаляет (CLAUDE.md, раздел 3.1).

const SHADOW_NAME = /^[a-z0-9_]+_shadow$/;

/** Имя базы из адреса postgresql://…/<имя>?… */
export function dbNameOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

/** Отказ, если теневая база — не одноразовая _shadow или совпадает с рабочей базой. */
export function assertShadowDb(shadowName: string, targetName: string): void {
  if (!SHADOW_NAME.test(shadowName)) {
    throw new Error(`Теневая база Prisma должна называться *_shadow (латиница, цифры, _), а не «${shadowName}»: Prisma очищает её целиком`);
  }
  if (shadowName === targetName) {
    throw new Error(`Теневая база «${shadowName}» совпадает с проверяемой базой`);
  }
}
