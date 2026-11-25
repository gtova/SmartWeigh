import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Starts a throwaway Postgres (no Docker needed) and applies the Prisma schema.
let pg: EmbeddedPostgres | undefined;
const dir = path.join(os.tmpdir(), `weighwise-pg-${process.pid}`);

// Cleans up Postgres instances left behind by crashed earlier runs (they hold the port).
function killStale() {
  for (const name of fs.readdirSync(os.tmpdir())) {
    if (!name.startsWith('weighwise-pg-')) continue;
    const d = path.join(os.tmpdir(), name);
    try {
      const pid = Number(fs.readFileSync(path.join(d, 'postmaster.pid'), 'utf8').split('\n')[0]);
      if (pid) process.kill(pid);
    } catch {
      /* not running */
    }
  }
}

export async function setup() {
  killStale();
  await new Promise((r) => setTimeout(r, 1500));
  for (const name of fs.readdirSync(os.tmpdir())) {
    if (name.startsWith('weighwise-pg-')) fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true, maxRetries: 5 });
  }
  pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'test',
    password: 'test',
    port: 54329,
    persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('weighwise_test');
  const url = 'postgresql://test:test@localhost:54329/weighwise_test';
  process.env.DATABASE_URL = url;
  const { migrate } = await import('../src/migrate.js');
  const { pool } = await import('../src/db.js');
  await migrate('up');
  await pool.end();
}

export async function teardown() {
  await pg?.stop();
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    /* temp dir cleanup is best effort on Windows */
  }
}




