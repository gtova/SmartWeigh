import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { pool } from '../src/db.js';
import { purgeDeletedUsers } from '../src/routes/me.js';
import { app, makeUser, resetDb } from './helpers.js';

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
let stationId: string;

async function addM(userId: string, kg: number, daysBack: number) {
  const s = (await pool.query("INSERT INTO weigh_sessions(user_id, station_id, state) VALUES($1,$2,'saved') RETURNING id", [userId, stationId])).rows[0].id;
  const m = (
    await pool.query(
      `INSERT INTO measurements(session_id,user_id,weight_kg,bmi,station_id,measured_at) VALUES($1,$2,$3,23,$4, now() - ($5||' days')::interval) RETURNING id`,
      [s, userId, kg, stationId, String(daysBack)],
    )
  ).rows[0].id;
  await pool.query("INSERT INTO recommendations(measurement_id, explanation, recommendations, prompt_version, model) VALUES($1,'שלום','[\"א\",\"ב\"]','v1','mock')", [m]);
  await pool.query("INSERT INTO payments(session_id, status, provider, provider_txn_id, amount) VALUES($1,'succeeded','mock','txn1',1500)", [s]);
  return m as string;
}

beforeEach(async () => {
  stationId = await resetDb();
});

describe('customer data access', () => {
  it('requires login', async () => {
    expect((await request(app).get('/measurements')).status).toBe(401);
    expect((await request(app).get('/me/export')).status).toBe(401);
    expect((await request(app).delete('/me')).status).toBe(401);
  });

  it("lists only the caller's measurements and hides others' details", async () => {
    const a = await makeUser('a@x.co');
    const b = await makeUser('b@x.co');
    const ma = await addM(a.id, 70, 2);
    const mb = await addM(b.id, 90, 1);
    const list = await request(app).get('/measurements').set(bearer(a.token));
    expect(list.body).toHaveLength(1);
    expect(list.body[0].weightKg).toBe(70);
    expect((await request(app).get(`/measurements/${mb}`).set(bearer(a.token))).status).toBe(404);
    expect((await request(app).get(`/measurements/${ma}`).set(bearer(a.token))).status).toBe(200);
  });

  it('detail includes recommendation and the previous measurement', async () => {
    const a = await makeUser();
    await addM(a.id, 71, 5);
    const m2 = await addM(a.id, 72.5, 0);
    const d = await request(app).get(`/measurements/${m2}`).set(bearer(a.token));
    expect(d.body.explanation).toBe('שלום');
    expect(d.body.previous.weightKg).toBe(71);
  });

  it('filters by date range', async () => {
    const a = await makeUser();
    await addM(a.id, 70, 40);
    await addM(a.id, 71, 2);
    const from = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const r = await request(app).get('/measurements').query({ from }).set(bearer(a.token));
    expect(r.body).toHaveLength(1);
  });

  it('exports own data only', async () => {
    const a = await makeUser('a@x.co');
    const b = await makeUser('b@x.co');
    await addM(a.id, 70, 1);
    await addM(b.id, 99, 1);
    const r = await request(app).get('/me/export').set(bearer(a.token));
    expect(r.headers['content-disposition']).toContain('attachment');
    expect(r.body.measurements).toHaveLength(1);
    expect(r.body.measurements[0].weight_kg).toBe(70);
    expect(r.body.profile.email).toBe('a@x.co');
    expect(JSON.stringify(r.body)).not.toContain('b@x.co');
  });
});

describe('account deletion', () => {
  it('blocks the old token, strips personal data, then purges everything but payment status', async () => {
    const a = await makeUser('gone@x.co');
    const keep = await makeUser('stay@x.co');
    await addM(a.id, 70, 1);
    await addM(keep.id, 80, 1);
    expect((await request(app).delete('/me').set(bearer(a.token))).status).toBe(200);
    expect((await request(app).get('/measurements').set(bearer(a.token))).status).toBe(401);
    const row = (await pool.query('SELECT email, full_name, deleted_at FROM users WHERE id=$1', [a.id])).rows[0];
    expect(row.full_name).toBeNull();
    expect(row.email).not.toContain('gone@x.co');
    expect(row.deleted_at).not.toBeNull();

    expect(await purgeDeletedUsers(0)).toBe(1);
    expect((await pool.query('SELECT count(*)::int n FROM measurements WHERE user_id=$1', [a.id])).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int n FROM users WHERE id=$1', [a.id])).rows[0].n).toBe(0);
    const pays = (await pool.query('SELECT status, provider_txn_id, session_id FROM payments ORDER BY created_at')).rows;
    expect(pays).toHaveLength(2); // accounting rows are kept, detached from the person
    expect(pays.some((p) => p.session_id === null && p.provider_txn_id === 'txn1')).toBe(true);
    expect((await pool.query('SELECT count(*)::int n FROM measurements WHERE user_id=$1', [keep.id])).rows[0].n).toBe(1);
  });

  it('the same email can register again after deletion', async () => {
    const a = await makeUser('again@x.co');
    await request(app).delete('/me').set(bearer(a.token));
    await expect(makeUser('again@x.co')).resolves.toBeTruthy();
  });
});
