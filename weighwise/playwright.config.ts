import { defineConfig } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

const outbox = path.join(os.tmpdir(), 'weighwise-e2e-outbox.json');

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  timeout: 90_000,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    // Uses the Edge already installed on the machine, so no browser download is needed.
    channel: 'msedge',
    locale: 'he-IL',
    viewport: { width: 1280, height: 800 },
  },
  webServer: [
    {
      command: 'npx tsx e2e/start-api.ts',
      cwd: './server',
      url: 'http://localhost:4000/health',
      timeout: 120_000,
      reuseExistingServer: false,
      env: { E2E_OUTBOX: outbox },
    },
    { command: 'npm run dev -w web', url: 'http://localhost:5173', timeout: 60_000, reuseExistingServer: false },
  ],
});
