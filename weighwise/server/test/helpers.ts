import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { signToken } from '../src/auth/middleware.js';
import { seed } from '../src/seed.js';
import { resetRateLimits } from '../src/rateLimit.js';

export const app = createApp();
export const STATION_KEY = 'test-station-key';

export async function resetDb() {
  resetRateLimits();
  await pool.query('TRUNCATE users, stations, otp_codes, audit_log CASCADE');
  return seed(STATION_KEY);
}

export async function makeUser(email = 'u@example.com', extra: Partial<{ birth: number; height: number; channel: string }> = {}) {
  const r = await pool.query(
    `INSERT INTO users(email, full_name, birth_year, height_cm, preferred_channel) VALUES($1,'בדיקה',$2,$3,$4) RETURNING id`,
    [email, extra.birth ?? 1990, extra.height ?? 175, extra.channel ?? 'email'],
  );
  return { id: r.rows[0].id as string, token: signToken(r.rows[0].id) };
}

export const as = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Station-Key': STATION_KEY });

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Walks a fresh paid session through the full hygiene procedure and prep confirmation. */
export async function readyToMeasure(token: string) {
  const s = await request(app).post('/sessions').set(as(token));
  const id = s.body.id as string;
  await request(app).post(`/sessions/${id}/pay`).set(as(token));
  for (let i = 1; i <= 5; i++) await request(app).post(`/sessions/${id}/hygiene/${i}`).set(as(token));
  const c = await request(app).post(`/sessions/${id}/confirm-prep`).set(as(token)).send({ deviceSuitability: true, cleanedPerInstructions: true });
  if (c.status !== 200) throw new Error(`prep failed ${c.status} ${JSON.stringify(c.body)}`);
  return id;
}
