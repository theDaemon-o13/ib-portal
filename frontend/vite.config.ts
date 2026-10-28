/// <reference types="vitest/config" />
import { cpSync, createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * Ресурсы pdf.js (шрифты, CMap, ICC, JS-декодеры) входят в сборку: закрытый контур, без CDN (CLAUDE.md, раздел 2).
 * В dev раздаются из node_modules по /pdfjs/*, при сборке копируются в dist/pdfjs/.
 */
const PDFJS_DIRS = ['cmaps', 'standard_fonts', 'iccs', 'wasm'];
const pdfjsRoot = join(process.cwd(), 'node_modules', 'pdfjs-dist');
function pdfjsAssets(): Plugin {
  let outDir = 'dist';
  let building = false;
  return {
    name: 'ibportal-pdfjs-assets',
    configResolved(c) {
      outDir = c.build.outDir;
      // Копировать только при vite build: vitest тоже поднимает Vite (с фиктивным outDir).
      building = c.command === 'build' && !process.env.VITEST;
    },
    configureServer(server) {
      server.middlewares.use('/pdfjs', (req, res, next) => {
        const rel = normalize(decodeURIComponent((req.url ?? '').split('?')[0] ?? '')).replace(/^([/\\]|\.\.)+/, '');
        const dir = rel.split(/[/\\]/)[0] ?? '';
        const file = join(pdfjsRoot, rel);
        if (!PDFJS_DIRS.includes(dir) || !file.startsWith(pdfjsRoot) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      if (!building) return;
      for (const d of PDFJS_DIRS) cpSync(join(pdfjsRoot, d), join(outDir, 'pdfjs', d), { recursive: true });
    },
  };
}

/**
 * Версия, коммит и дата сборки для подписи и окна «О портале» (src/build-info.ts). Релиз: APP_VERSION, APP_COMMIT,
 * APP_BUILD_DATE из make-release.sh (build-args образа). Dev: VERSION репозитория (если виден) и «dev».
 */
const repoVersion = (() => {
  const file = join(process.cwd(), '..', 'VERSION');
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
})();
const build = {
  __APP_VERSION__: process.env.APP_VERSION || (repoVersion ? `${repoVersion}-dev` : 'dev'),
  __APP_COMMIT__: process.env.APP_COMMIT || 'dev',
  __APP_BUILD_DATE__: process.env.APP_BUILD_DATE || '',
};

// В dev /api проксируется на backend; в продукте это делает nginx.
const backend = process.env.VITE_BACKEND_URL ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react(), pdfjsAssets()],
  define: Object.fromEntries(Object.entries(build).map(([k, v]) => [k, JSON.stringify(v)])),
  server: {
    host: process.env.VITE_HOST ?? '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: backend, changeOrigin: false, xfwd: true } },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        // Worker pdf.js приходит как .mjs, а в mime.types nginx такого расширения нет (отдал бы octet-stream,
        // и браузер не запустил бы module worker): в сборке он — .js.
        assetFileNames: (info) => (info.names.some((n) => n.endsWith('.mjs')) ? 'assets/[name]-[hash].js' : 'assets/[name]-[hash][extname]'),
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
