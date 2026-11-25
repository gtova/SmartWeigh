import pg from 'pg';

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// An idle client dropping (DB restart) must not crash the process.
pool.on('error', () => undefined);

// numeric columns come back as strings by default; parse to numbers.
pg.types.setTypeParser(1700, (v) => parseFloat(v));

export type Queryable = Pick<pg.Pool, 'query'>;

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

