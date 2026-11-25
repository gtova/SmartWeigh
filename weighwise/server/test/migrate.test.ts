import { describe, it, expect, afterAll } from 'vitest';
import { migrate } from '../src/migrate.js';
import { pool } from '../src/db.js';

const count = async () =>
  (await pool.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name='weigh_sessions'")).rows[0].n;

describe('migrations', () => {
  afterAll(async () => {
    await migrate('up');
  });
  it('goes down and up cleanly', async () => {
    expect(await count()).toBe(1);
    await migrate('down');
    expect(await count()).toBe(0);
    await migrate('up');
    expect(await count()).toBe(1);
  });
});
