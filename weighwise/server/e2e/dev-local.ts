// Local run without Docker: persistent embedded Postgres in server/.pgdata, real timings,
// one-time codes printed to this console (log providers).
import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.pgdata');
const first = !fs.existsSync(dir);
const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'dev', password: 'dev', port: 54331, persistent: true, initdbFlags: ['--encoding=UTF8', '--locale=C'] });
if (first) await pg.initialise();
await pg.start();
if (first) await pg.createDatabase('weighwise_dev');

process.env.DATABASE_URL ??= 'postgresql://dev:dev@localhost:54331/weighwise_dev';
process.env.PORT ??= '4000';
await import('../src/index.js');

const stop = async () => {
  await pg.stop().catch(() => undefined);
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
