import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { env: { DATABASE_URL: 'postgresql://test:test@localhost:54329/weighwise_test', NODE_ENV: 'test' }, globalSetup: ['./test/globalSetup.ts'], fileParallelism: false, testTimeout: 30000, hookTimeout: 120000 } });
