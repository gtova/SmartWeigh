// Boots the API against a throwaway embedded Postgres, with fast timings and a file-based outbox so
// Playwright can read the one-time codes and result links. For end-to-end tests only.
import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = path.join(os.tmpdir(), `weighwise-e2e-pg-${process.pid}`);
const outboxFile = process.env.E2E_OUTBOX ?? path.join(os.tmpdir(), 'weighwise-e2e-outbox.json');
fs.writeFileSync(outboxFile, '[]');

const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'e2e', password: 'e2e', port: 54330, persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'] });
await pg.initialise();
await pg.start();
await pg.createDatabase('weighwise_e2e');

Object.assign(process.env, {
  DATABASE_URL: 'postgresql://e2e:e2e@localhost:54330/weighwise_e2e',
  PORT: '4000',
  DRY_MS: '1200',
  MEASURE_DURATION_MS: '1500',
  IDLE_RESET_MS: '2500',
  WEB_ORIGIN: 'http://localhost:5173',
  LLM_PROVIDER: 'mock', // e2e never calls a paid model
});

const { providers } = await import('../src/providers/message.js');
const push = (kind: string, to: string, text: string) => {
  const all = JSON.parse(fs.readFileSync(outboxFile, 'utf8'));
  all.push({ kind, to, text });
  fs.writeFileSync(outboxFile, JSON.stringify(all));
};
providers.email = { sendEmail: async (to, subject, body) => push('email', to, `${subject}\n${body}`) };
providers.message = {
  sendSms: async (to, text) => push('sms', to, text),
  sendVoice: async (to, digits) => push('voice', to, digits),
};

await import('../src/index.js');

const stop = async () => {
  await pg.stop().catch(() => undefined);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

