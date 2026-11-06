// seed:demo (CLAUDE.md 3.8): отказ на production и на базе не *_dev; шаблоны с выделенными блоками обоих видов.
import { describe, expect, it } from 'vitest';
import { sanitizeLetterHtml } from './sanitize.js';
import { DEMO_TEMPLATES, demoGuard } from '../../../scripts/seed-demo.js';

describe('seed:demo', () => {
  it('работает только с *_dev и не в production', () => {
    expect(demoGuard({ DATABASE_URL: 'postgresql://u:p@h:5433/ibportal_dev' })).toBeNull();
    expect(demoGuard({ DATABASE_URL: 'postgresql://u:p@h:5432/ibportal' })).toMatch(/_dev/);
    expect(demoGuard({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://u:p@h:5433/ibportal_dev' })).toMatch(/production/);
    expect(demoGuard({})).toMatch(/не задана/);
  });

  it('шаблоны вымышленные, проходят санитайзер без потерь, в каждом — «Просьба» и «Предупреждение»', () => {
    for (const t of DEMO_TEMPLATES) {
      for (const html of [t.htmlRu, t.htmlTj]) {
        expect(sanitizeLetterHtml(html).html).toBe(html);
        expect(html).toContain('data-callout="info"');
        expect(html).toContain('data-callout="warn"');
      }
    }
  });
});
