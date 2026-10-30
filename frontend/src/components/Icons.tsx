// Иконки разделов из прототипа (docs/prototype/portal-demo.html).
import type { ReactElement } from 'react';
import type { IconName } from '../nav';

const paths: Record<IconName, ReactElement> = {
  dash: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </>
  ),
  monitor: (
    <>
      <rect x="2.5" y="4" width="19" height="12.5" rx="1.5" />
      <path d="M8 20h8M12 16.5V20M6.5 12.5l3-3 2.5 2 4.5-4.5" />
    </>
  ),
  builder: (
    <>
      <path d="M4 6h10M4 12h16M4 18h7" />
      <circle cx="17" cy="6" r="2" />
      <circle cx="14" cy="18" r="2" />
    </>
  ),
  tasks: (
    <>
      <rect x="3" y="4" width="5" height="16" rx="1.5" />
      <rect x="10" y="4" width="5" height="10" rx="1.5" />
      <rect x="17" y="4" width="4" height="13" rx="1.5" />
    </>
  ),
  bug: (
    <>
      <path d="M9 9a3 3 0 016 0v6a3 3 0 01-6 0z" />
      <path d="M12 9v9M5 12h4M15 12h4M6 7l3 2M18 7l-3 2M6 18l3-2M18 18l-3-2" />
    </>
  ),
  docs: (
    <>
      <path d="M7 3h7l5 5v13H7z" />
      <path d="M14 3v5h5M10 13h6M10 17h6" />
    </>
  ),
  evidence: (
    <>
      <path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z" />
      <path d="M8.5 12l2.5 2.5 4.5-5" />
    </>
  ),
  journal: (
    <>
      <path d="M6 3h11a1 1 0 011 1v16a1 1 0 01-1 1H6z" />
      <path d="M9 3v18M12 8h3M12 12h3M12 16h2" />
    </>
  ),
  // Как в прототипе: щит с галочкой (docs/prototype/portal-demo.html, icons.assess).
  assess: (
    <>
      <path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z" />
      <path d="M8.5 12l2.5 2.5 4.5-5" />
    </>
  ),
  settings: (
    <>
      <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
      <circle cx="15" cy="6" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="17" cy="18" r="2" />
    </>
  ),
};

export function Icon({ name }: { name: IconName }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}
