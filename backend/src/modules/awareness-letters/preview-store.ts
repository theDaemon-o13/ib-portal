// Предпросмотр «как в почте» несохранённого содержимого (1.12.0): HTML кладётся в память на 10 минут под случайным
// ключом и открывается в iframe отдельным документом со своим CSP. srcdoc и blob: не подходят: они наследуют CSP
// страницы портала (style-src 'self'), и inline-стили письма не применились бы. Только тот же пользователь.
import { randomBytes } from 'node:crypto';

const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 200;
const entries = new Map<string, { userId: string; html: string; at: number }>();

function sweep(now: number) {
  for (const [k, v] of entries) if (now - v.at > TTL_MS) entries.delete(k);
  while (entries.size > MAX_ENTRIES) {
    const first = entries.keys().next().value;
    if (first === undefined) break;
    entries.delete(first);
  }
}

export function putPreview(userId: string, html: string, now = Date.now()): string {
  sweep(now);
  const token = randomBytes(24).toString('base64url');
  entries.set(token, { userId, html, at: now });
  sweep(now);
  return token;
}

export function takePreview(userId: string, token: string, now = Date.now()): string | null {
  sweep(now);
  const e = entries.get(token);
  return e && e.userId === userId ? e.html : null;
}

/** CSP документа предпросмотра: без скриптов и запросов, стили письма inline, изображения data:, только в iframe портала. */
export const PREVIEW_CSP = "sandbox; default-src 'none'; img-src data: 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'";
