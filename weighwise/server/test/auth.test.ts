import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { outbox } from '../src/providers/message.js';
import { resetRateLimits } from '../src/rateLimit.js';

const app = createApp();
const lastCode = () => /(\d{6})/.exec(outbox[outbox.length - 1].text)![1];

beforeEach(async () => {
  resetRateLimits();
  outbox.length = 0;
  await pool.query('TRUNCATE users, otp_codes CASCADE');
});

describe('otp auth', () => {
  it('request returns the same body for any valid target and rejects bad input', async () => {
    const a = await request(app).post('/auth/otp/request').send({ target: 'a@b.co', channel: 'email' });
    const b = await request(app).post('/auth/otp/request').send({ target: '054-8291430', channel: 'sms' });
    expect(a.body).toEqual(b.body);
    const bad = await request(app).post('/auth/otp/request').send({ target: 'nope', channel: 'sms' });
    expect(bad.status).toBe(400);
  });

  it('stores only a hash and verifies a correct code', async () => {
    await request(app).post('/auth/otp/request').send({ target: 'a@b.co', channel: 'email' });
    const code = lastCode();
    const row = (await pool.query('SELECT code_hash FROM otp_codes')).rows[0];
    expect(row.code_hash).not.toContain(code);
    const v = await request(app).post('/auth/otp/verify').send({ target: 'a@b.co', code });
    expect(v.status).toBe(200);
    expect(v.body.needsProfile).toBe(true);
    expect(v.body.token).toBeTruthy();
    // single use
    const again = await request(app).post('/auth/otp/verify').send({ target: 'a@b.co', code });
    expect(again.status).toBe(401);
  });

  it('gives identical errors for unknown targets and wrong codes', async () => {
    await request(app).post('/auth/otp/request').send({ target: 'a@b.co', channel: 'email' });
    const wrong = await request(app).post('/auth/otp/verify').send({ target: 'a@b.co', code: '000000' === lastCode() ? '111111' : '000000' });
    const unknown = await request(app).post('/auth/otp/verify').send({ target: 'zzz@b.co', code: '123456' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it('locks after 5 attempts even with the right code', async () => {
    await request(app).post('/auth/otp/request').send({ target: 'a@b.co', channel: 'email' });
    const code = lastCode();
    const wrong = code === '111111' ? '222222' : '111111';
    for (let i = 0; i < 5; i++) await request(app).post('/auth/otp/verify').send({ target: 'a@b.co', code: wrong });
    const r = await request(app).post('/auth/otp/verify').send({ target: 'a@b.co', code });
    expect(r.status).toBe(401);
  });

  it('rejects expired codes', async () => {
    await request(app).post('/auth/otp/request').send({ target: 'a@b.co', channel: 'email' });
    const code = lastCode();
    await pool.query("UPDATE otp_codes SET expires_at = now() - interval '1 second'");
    const r = await request(app).post('/auth/otp/verify').send({ target: 'a@b.co', code });
    expect(r.status).toBe(401);
  });

  it('rate limits requests per target', async () => {
    const send = () => request(app).post('/auth/otp/request').send({ target: '0548291430', channel: 'sms' });
    for (let i = 0; i < 3; i++) expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(429);
  });

  it('voice channel reads digits one by one, twice', async () => {
    await request(app).post('/auth/otp/request').send({ target: '0548291430', channel: 'voice' });
    const item = outbox[outbox.length - 1];
    expect(item.kind).toBe('voice');
    expect(item.text.split(' ... ').length).toBe(2);
    expect(item.text.split(' ... ')[0]).toMatch(/^\d( \d){5}$/);
  });
});

describe('profile and consents', () => {
  async function login(target = 'a@b.co') {
    await request(app).post('/auth/otp/request').send({ target, channel: 'email' });
    const v = await request(app).post('/auth/otp/verify').send({ target, code: lastCode() });
    return v.body.token as string;
  }
  const body = { fullName: 'רועי', birthYear: 1990, heightCm: 178, preferredChannel: 'email', consents: { terms: true, ai_processing: true, sms: false } };

  it('requires auth and valid input', async () => {
    expect((await request(app).post('/users/profile').send(body)).status).toBe(401);
    const t = await login();
    const bad = await request(app).post('/users/profile').set('Authorization', `Bearer ${t}`).send({ ...body, consents: { terms: false } });
    expect(bad.status).toBe(400);
  });

  it('saves the profile and records consents with terms version', async () => {
    const t = await login();
    const r = await request(app).post('/users/profile').set('Authorization', `Bearer ${t}`).send(body);
    expect(r.status).toBe(200);
    const c = await pool.query('SELECT type, terms_version FROM consents');
    expect(c.rows.map((x) => x.type).sort()).toEqual(['ai_processing', 'terms']);
    expect(c.rows[0].terms_version).toBe('1.0');
    const me = await request(app).get('/users/me').set('Authorization', `Bearer ${t}`);
    expect(me.body.fullName).toBe('רועי');
  });

  it('sms channel needs a phone and sms consent', async () => {
    const t = await login();
    const r = await request(app).post('/users/profile').set('Authorization', `Bearer ${t}`).send({ ...body, preferredChannel: 'sms' });
    expect(r.status).toBe(400);
  });
});

