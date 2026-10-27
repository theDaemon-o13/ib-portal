// nginx портала передаёт backend только адрес соединения: присланный клиентом X-Forwarded-For не проходит (ADR-0012).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const conf = readFileSync(new URL('../nginx.conf', import.meta.url), 'utf8');

describe('nginx.conf', () => {
  it('X-Forwarded-For — только $remote_addr, без дописывания к заголовку клиента', () => {
    const lines = conf.split('\n').filter((l) => /X-Forwarded-For/i.test(l) && !l.trim().startsWith('#'));
    expect(lines.map((l) => l.trim())).toEqual(['proxy_set_header X-Forwarded-For $remote_addr;']);
    expect(conf).not.toContain('$proxy_add_x_forwarded_for;');
  });
});
