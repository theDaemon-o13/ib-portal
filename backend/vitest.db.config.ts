import { defineConfig } from 'vitest/config';

// Тесты с настоящим PostgreSQL: npm run test:db (нужен запущенный dev-контейнер db на 127.0.0.1:5433).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.db.test.ts'],
    globalSetup: ['src/test/db-global-setup.ts'],
    // Тесты используют общую базу: файлы по очереди, каждый тест — в своей транзакции с откатом.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
