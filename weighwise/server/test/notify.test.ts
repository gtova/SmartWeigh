import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { pool } from '../src/db.js';
import { config } from '../src/config.js';
import { providers, outbox, logEmailProvider, logMessageProvider } from '../src/providers/message.js';
import { backoffMs } from '../src/services/queue.js';
import { notifyQueue } from '../src/services/notify.js';
import { startPipeline } from '../src/services/pipeline.js';
import { waitForMeasure } from '../src/services/measure.js';
import { app, as, makeUser, readyToMeasure, resetDb, sleep } from './helpers.js';

startPipeline();
const saved = { dry: config.hygiene.dryMs, dur: config.measure.durationMs, base: backoffMs.base };

beforeEach(async () => {
  await resetDb();
  outbox.length = 0;
  config.hygiene.dryMs = 0;
  config.measure.durationMs = 60;
  backoffMs.base = 1;
});
afterEach(() => {
  config.hygiene.dryMs = saved.dry;
  config.measure.durationMs = saved.dur;
  backoffMs.base = saved.base;
  providers.email = logEmailProvider;
  providers.message = logMessageProvider;
});

async function weigh(token: string) {
  const id = await readyToMeasure(token);
  await request(app).post(`/sessions/${id}/measure`).set(as(token));
  await waitForMeasure(id);
  await sleep(100); // let AI + queue run
  await notifyQueue.idle();
  return id;
}
const stateOf = async (id: string) => (await pool.query('SELECT state FROM weigh_sessions WHERE id=$1', [id])).rows[0].state;
const consent = (uid: string, type: string) => pool.query('INSERT INTO consents(user_id,type,terms_version) VALUES($1,$2,$3)', [uid, type, '1.0']);

describe('result delivery', () => {
  it('emails the result with a login link and moves to notified; kiosk sees the outcome', async () => {
    const u = await makeUser('a@example.com');
    await consent(u.id, 'ai_processing');
    const id = await weigh(u.token);
    expect(await stateOf(id)).toBe('notified');
    const mail = outbox.find((o) => o.kind === 'email')!;
    expect(mail.to).toBe('a@example.com');
    expect(mail.text).toMatch(/\/login\?next=%2Fmeasurements%2F[0-9a-f-]{36}/);
    expect(mail.text).toContain('התוכן נועד לעידוד בלבד');
    const v = await request(app).get(`/sessions/${id}`).set(as(u.token));
    expect(v.body.notification).toEqual({ status: 'sent', channel: 'email' });
    const rec = (await pool.query('SELECT * FROM recommendations')).rows[0];
    expect(rec.prompt_version).toBe('v1');
  });

  it('sends a minimal SMS only when the user consented', async () => {
    const u = await makeUser('b@example.com', { channel: 'sms' });
    await pool.query("UPDATE users SET phone='0548291430' WHERE id=$1", [u.id]);
    // no sms consent: falls back to email
    await weigh(u.token);
    expect(outbox.some((o) => o.kind === 'sms')).toBe(false);
    expect(outbox.some((o) => o.kind === 'email')).toBe(true);

    outbox.length = 0;
    await consent(u.id, 'sms');
    await weigh(u.token);
    const sms = outbox.find((o) => o.kind === 'sms')!;
    expect(sms.to).toBe('0548291430');
    expect(sms.text).toContain('/login?next=');
    expect(sms.text).not.toMatch(/\d+\.\d\s*ק/); // no weight value in SMS
    expect(outbox.some((o) => o.kind === 'email')).toBe(false);
  });

  it('retries with backoff and eventually succeeds', async () => {
    const u = await makeUser();
    let calls = 0;
    providers.email = { sendEmail: async (...a) => (++calls < 3 ? Promise.reject(new Error('smtp down')) : logEmailProvider.sendEmail(...a)) };
    const id = await weigh(u.token);
    expect(calls).toBe(3);
    expect(await stateOf(id)).toBe('notified');
    expect((await pool.query('SELECT attempts, status FROM notifications')).rows[0]).toEqual({ attempts: 3, status: 'sent' });
  });

  it('after exhausting retries the result stays saved and the session is failed_notify', async () => {
    const u = await makeUser();
    providers.email = { sendEmail: async () => Promise.reject(new Error('smtp down')) };
    const id = await weigh(u.token);
    expect(await stateOf(id)).toBe('failed_notify');
    const n = (await pool.query('SELECT attempts, status FROM notifications')).rows[0];
    expect(n.status).toBe('failed');
    expect(n.attempts).toBe(4); // first try + 3 retries
    expect((await pool.query('SELECT count(*)::int n FROM measurements')).rows[0].n).toBe(1);
    const v = await request(app).get(`/sessions/${id}`).set(as(u.token));
    expect(v.body.notification.status).toBe('failed');
  });
});
