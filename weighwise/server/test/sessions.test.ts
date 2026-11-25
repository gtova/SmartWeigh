import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { pool } from '../src/db.js';
import { config } from '../src/config.js';
import { mockPayment } from '../src/providers/payment.js';
import { scaleFactory, waitForMeasure } from '../src/services/measure.js';
import { SimulatedScale } from '../src/providers/scale.js';
import { expireStaleSessions } from '../src/services/sessions.js';
import { app, as, makeUser, readyToMeasure, resetDb, sleep } from './helpers.js';

let user: { id: string; token: string };
const saved = { dry: config.hygiene.dryMs, expiry: config.hygiene.expiryMs, dur: config.measure.durationMs };

beforeEach(async () => {
  await resetDb();
  user = await makeUser();
  config.hygiene.dryMs = 0;
  config.hygiene.expiryMs = saved.expiry;
  config.measure.durationMs = 100;
  config.measure.manualEntry = false;
  scaleFactory.create = () => new SimulatedScale(config.measure.durationMs);
});
afterEach(() => {
  config.hygiene.dryMs = saved.dry;
  config.hygiene.expiryMs = saved.expiry;
  config.measure.durationMs = saved.dur;
});

const post = (path: string, body?: object, token = user.token) => request(app).post(path).set(as(token)).send(body);
const state = async (id: string) => (await pool.query('SELECT state FROM weigh_sessions WHERE id=$1', [id])).rows[0].state;

describe('auth on session endpoints', () => {
  it('needs both station key and user token', async () => {
    expect((await request(app).post('/sessions').set({ Authorization: `Bearer ${user.token}` })).status).toBe(401);
    expect((await request(app).post('/sessions').set({ 'X-Station-Key': 'test-station-key' })).status).toBe(401);
    expect((await request(app).post('/sessions').set({ ...as(user.token), 'X-Station-Key': 'wrong' })).status).toBe(401);
  });
  it('refuses a user without a completed profile', async () => {
    await pool.query('UPDATE users SET birth_year=NULL');
    expect((await post('/sessions')).status).toBe(409);
  });
  it("hides another user's session", async () => {
    const other = await makeUser('o@example.com');
    const id = (await post('/sessions')).body.id;
    expect((await request(app).get(`/sessions/${id}`).set(as(other.token))).status).toBe(404);
  });
});

describe('payment', () => {
  it('failed payment returns to payment without a weigh, then can succeed', async () => {
    const id = (await post('/sessions')).body.id;
    mockPayment.failNext = true;
    await post(`/sessions/${id}/pay`);
    expect(await state(id)).toBe('failed_payment');
    expect((await post(`/sessions/${id}/hygiene/1`)).status).toBe(409);
    await post(`/sessions/${id}/pay`);
    expect(await state(id)).toBe('paid');
  });
  it('is idempotent: repeating pay charges once', async () => {
    const id = (await post('/sessions')).body.id;
    const spy = vi.spyOn(mockPayment, 'charge');
    await post(`/sessions/${id}/pay`);
    const again = await post(`/sessions/${id}/pay`);
    expect(again.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await pool.query('SELECT count(*)::int n FROM payments')).rows[0].n).toBe(1);
    spy.mockRestore();
  });
});

describe('hygiene procedure', () => {
  it('cannot skip steps, confirm early, or measure before cleaning', async () => {
    const id = (await post('/sessions')).body.id;
    await post(`/sessions/${id}/pay`);
    expect((await post(`/sessions/${id}/hygiene/3`)).body.error).toBe('step_out_of_order');
    expect((await post(`/sessions/${id}/confirm-prep`, { deviceSuitability: true, cleanedPerInstructions: true })).status).toBe(409);
    expect((await post(`/sessions/${id}/measure`)).status).toBe(409);
    await post(`/sessions/${id}/hygiene/1`);
    expect(await state(id)).toBe('hygiene_in_progress');
  });
  it('enforces the drying wait on the server', async () => {
    config.hygiene.dryMs = 300;
    const id = (await post('/sessions')).body.id;
    await post(`/sessions/${id}/pay`);
    for (let i = 1; i <= 4; i++) await post(`/sessions/${id}/hygiene/${i}`);
    const early = await post(`/sessions/${id}/hygiene/5`);
    expect(early.status).toBe(409);
    expect(early.body.error).toBe('drying_not_finished');
    await sleep(320);
    expect((await post(`/sessions/${id}/hygiene/5`)).status).toBe(200);
  });
  it('requires explicit suitability and cleaning declarations', async () => {
    const id = (await post('/sessions')).body.id;
    await post(`/sessions/${id}/pay`);
    for (let i = 1; i <= 5; i++) await post(`/sessions/${id}/hygiene/${i}`);
    expect((await post(`/sessions/${id}/confirm-prep`, { deviceSuitability: false, cleanedPerInstructions: true })).status).toBe(400);
    expect((await post(`/sessions/${id}/confirm-prep`, { deviceSuitability: true, cleanedPerInstructions: true })).status).toBe(200);
    const c = await pool.query("SELECT 1 FROM consents WHERE type='device_suitability'");
    expect(c.rowCount).toBe(1);
  });
  it('restarts the procedure when too much time passes before measuring', async () => {
    const id = await readyToMeasure(user.token);
    config.hygiene.expiryMs = 30;
    await sleep(60);
    const r = await post(`/sessions/${id}/measure`);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('hygiene_expired');
    expect(await state(id)).toBe('hygiene_in_progress');
    const v = await request(app).get(`/sessions/${id}`).set(as(user.token));
    expect(v.body.hygiene.round).toBe(2);
    expect(v.body.hygiene.stepsDone).toBe(0);
    // old round is still on record
    expect((await pool.query('SELECT count(*)::int n FROM hygiene_steps WHERE session_id=$1', [id])).rows[0].n).toBe(5);
  });
});

describe('measurement', () => {
  it('runs a full session and records the timeline', async () => {
    const id = await readyToMeasure(user.token);
    expect((await post(`/sessions/${id}/measure`)).status).toBe(202);
    await waitForMeasure(id);
    expect(await state(id)).toBe('saved');
    const m = (await pool.query('SELECT * FROM measurements WHERE session_id=$1', [id])).rows[0];
    expect(m.weight_kg).toBeGreaterThanOrEqual(20);
    expect(Math.round(m.weight_kg * 10) / 10).toBe(m.weight_kg);
    expect(m.bmi).toBeGreaterThan(0);
    const ev = (await pool.query('SELECT to_state FROM session_events WHERE session_id=$1 ORDER BY at, id', [id])).rows.map((r) => r.to_state);
    expect(ev).toEqual(expect.arrayContaining(['created', 'paid', 'hygiene_in_progress', 'prep_confirmed', 'measuring', 'measured', 'saved']));
    console.log('timeline:', ev.join(' -> '));
  });

  it('manual entry is blocked unless the dev flag is on', async () => {
    const id = await readyToMeasure(user.token);
    const body = { manual: { weightKg: 70, bodyFatPct: 20, muscleMassKg: 30, bodyWaterPct: 55 } };
    expect((await post(`/sessions/${id}/measure`, body)).status).toBe(403);
    config.measure.manualEntry = true;
    expect((await post(`/sessions/${id}/measure`, body)).status).toBe(202);
    await waitForMeasure(id);
    expect((await pool.query('SELECT weight_kg FROM measurements')).rows[0].weight_kg).toBe(70);
  });

  it('drops composition outside plausible ranges but keeps the weight', async () => {
    config.measure.manualEntry = true;
    const id = await readyToMeasure(user.token);
    await post(`/sessions/${id}/measure`, { manual: { weightKg: 80, bodyFatPct: 70, muscleMassKg: 30, bodyWaterPct: 20 } });
    await waitForMeasure(id);
    const m = (await pool.query('SELECT * FROM measurements')).rows[0];
    expect(m.weight_kg).toBe(80);
    expect(m.body_fat_pct).toBeNull();
    expect(m.body_water_pct).toBeNull();
  });

  it('fails when weight is out of range, with one free retry then flagged for refund', async () => {
    config.measure.manualEntry = true;
    const id = await readyToMeasure(user.token);
    const bad = { manual: { weightKg: 5, bodyFatPct: 20, muscleMassKg: 30, bodyWaterPct: 55 } };
    await post(`/sessions/${id}/measure`, bad);
    await waitForMeasure(id);
    expect(await state(id)).toBe('failed_measure');
    await post(`/sessions/${id}/measure`, bad); // free retry
    await waitForMeasure(id);
    expect(await state(id)).toBe('failed_measure');
    expect((await pool.query('SELECT needs_review FROM weigh_sessions')).rows[0].needs_review).toBe(true);
    expect((await post(`/sessions/${id}/measure`, bad)).body.error).toBe('no_retries_left');
    expect((await pool.query('SELECT count(*)::int n FROM payments')).rows[0].n).toBe(1); // never charged twice
  });

  it('fails without proper contact on hands and feet', async () => {
    const id = await readyToMeasure(user.token);
    scaleFactory.create = () => {
      const s = new SimulatedScale(config.measure.durationMs);
      const start = s.start.bind(s);
      s.start = (i, o) => start(i, { ...o, contacts: { leftHand: false } });
      return s;
    };
    await post(`/sessions/${id}/measure`);
    await waitForMeasure(id);
    expect(await state(id)).toBe('failed_measure');
    expect((await pool.query('SELECT count(*)::int n FROM measurements')).rows[0].n).toBe(0);
  });

  it('flags a jump of more than 5 kg within 7 days as an outlier without blocking', async () => {
    config.measure.manualEntry = true;
    const run = async (w: number) => {
      const id = await readyToMeasure(user.token);
      await post(`/sessions/${id}/measure`, { manual: { weightKg: w, bodyFatPct: 20, muscleMassKg: 30, bodyWaterPct: 55 } });
      await waitForMeasure(id);
      return id;
    };
    await run(70);
    const second = await run(78);
    expect(await state(second)).toBe('saved');
    const rows = (await pool.query('SELECT weight_kg, is_outlier FROM measurements ORDER BY measured_at')).rows;
    expect(rows.map((r) => r.is_outlier)).toEqual([false, true]);
  });
});

describe('abandoned sessions', () => {
  it('cancel after payment is flagged for review', async () => {
    const id = (await post('/sessions')).body.id;
    await post(`/sessions/${id}/pay`);
    await post(`/sessions/${id}/cancel`);
    expect(await state(id)).toBe('abandoned');
    expect((await pool.query('SELECT needs_review FROM weigh_sessions')).rows[0].needs_review).toBe(true);
  });
  it('times out after inactivity', async () => {
    const id = (await post('/sessions')).body.id;
    await post(`/sessions/${id}/pay`);
    config.hygiene.expiryMs = 20;
    await sleep(50);
    expect(await expireStaleSessions()).toBe(1);
    expect(await state(id)).toBe('abandoned');
  });
  it('rejects illegal transitions after abandonment', async () => {
    const id = (await post('/sessions')).body.id;
    await post(`/sessions/${id}/cancel`);
    expect((await post(`/sessions/${id}/pay`)).status).toBe(409);
  });
});
