// HEALTHCHECK контейнера backend: код 0, если /api/health отвечает 200.
const port = process.env.PORT ?? '3000';

try {
  const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) });
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}
