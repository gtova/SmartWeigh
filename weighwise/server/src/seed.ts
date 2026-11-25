import { pool } from './db.js';
import { hashDeviceKey } from './auth/crypto.js';

// Creates a sample station. The device key comes from env or defaults to a dev-only value.
export async function seed(deviceKey = process.env.SEED_STATION_KEY ?? 'dev-station-key-104') {
  const hash = hashDeviceKey(deviceKey);
  const existing = await pool.query('SELECT id FROM stations WHERE name=$1', ['עמדה 104']);
  if (existing.rowCount) return existing.rows[0].id as string;
  const r = await pool.query('INSERT INTO stations(name, device_key_hash) VALUES($1,$2) RETURNING id', ['עמדה 104', hash]);
  return r.rows[0].id as string;
}

if (process.argv[1]?.endsWith('seed.ts')) {
  seed().then(() => {
    console.log('seeded');
    return pool.end();
  });
}
