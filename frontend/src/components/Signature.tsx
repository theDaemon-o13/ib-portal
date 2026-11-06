// Подпись «designed by» (1.13.0, задание 1.13.0, раздел 4): вектор из docs/design/ocean/signature, локальный файл сборки.
// Цвет — через currentColor: файл служит CSS-маской (mask-image), фон элемента — currentColor; SVG не попадает в JS.
// «Пишется от руки» (sig-write) — только при первой загрузке страницы, не при каждом переходе.

export type SignatureVariant = 'full' | 'autograph' | 'initials';

let written = false;

export function Signature({ variant, animate = false, className = '' }: { variant: SignatureVariant; animate?: boolean; className?: string }) {
  // Первый показ анимированной подписи за загрузку страницы — с анимацией, дальше — сразу.
  const write = animate && !written;
  if (write) written = true;
  return <span className={`sig sig-${variant}${write ? ' sig-write' : ''}${className ? ` ${className}` : ''}`} role="img" aria-label="Iskandar Masharipov" />;
}
