/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// В dev /api проксируется на backend; в продукте это делает nginx.
const backend = process.env.VITE_BACKEND_URL ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    host: process.env.VITE_HOST ?? '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: backend, changeOrigin: false } },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    assetsInlineLimit: 0,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
