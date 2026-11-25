import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db/migrations');

export async function migrate(direction: 'up' | 'down' = 'up') {
  await pool.query('CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY)');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(`.${direction}.sql`)).sort();
  if (direction === 'down') files.reverse();
  for (const f of files) {
    const name = f.replace(`.${direction}.sql`, '');
    const done = (await pool.query('SELECT 1 FROM _migrations WHERE name=$1', [name])).rowCount;
    if (direction === 'up' && done) continue;
    if (direction === 'down' && !done) continue;
    await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (direction === 'up') await pool.query('INSERT INTO _migrations(name) VALUES($1)', [name]);
    else await pool.query('DELETE FROM _migrations WHERE name=$1', [name]);
  }
}

if (process.argv[1] && process.argv[1].endsWith('migrate.ts')) {
  migrate((process.argv[2] as 'up' | 'down') ?? 'up').then(() => pool.end());
}
