import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db.js';
import { generateCode, hashOtp, safeEqual } from '../auth/crypto.js';
import { signToken, stationFromHeader } from '../auth/middleware.js';
import { hit } from '../rateLimit.js';
import { providers } from '../providers/message.js';

export const authRouter = Router();

/** Normalizes an email or Israeli phone number; returns null when invalid. */
export function normalizeTarget(raw: string): { target: string; kind: 'email' | 'phone' } | null {
  const v = raw.trim();
  if (v.includes('@')) {
    const ok = z.string().email().max(254).safeParse(v).success;
    return ok ? { target: v.toLowerCase(), kind: 'email' } : null;
  }
  let d = v.replace(/[\s\-()]/g, '');
  if (d.startsWith('+972')) d = '0' + d.slice(4);
  else if (d.startsWith('972')) d = '0' + d.slice(3);
  return /^0\d{8,9}$/.test(d) ? { target: d, kind: 'phone' } : null;
}

const requestSchema = z.object({
  target: z.string().min(3).max(254),
  channel: z.enum(['email', 'sms', 'voice']),
});
const verifySchema = z.object({
  target: z.string().min(3).max(254),
  code: z.string().regex(/^\d{6}$/),
});

// Same response for every outcome so the endpoint reveals nothing about existing accounts.
const GENERIC = { ok: true };
const BAD_CODE = { error: 'invalid_or_expired_code' };

authRouter.post('/otp/request', async (req, res) => {
  const p = requestSchema.safeParse(req.body);
  const t = p.success ? normalizeTarget(p.data.target) : null;
  if (!p.success || !t) return void res.status(400).json({ error: 'invalid_request' });
  const { channel } = p.data;
  if ((channel === 'email') !== (t.kind === 'email')) return void res.status(400).json({ error: 'invalid_request' });

  const station = await stationFromHeader(req);
  const ip = req.ip ?? 'unknown';
  const allowed =
    hit(`otp:target:${t.target}`, 3, 10 * 60_000) &&
    hit(`otp:ip:${ip}`, 20, 10 * 60_000) &&
    (!station || hit(`otp:station:${station.id}`, 60, 10 * 60_000));
  if (!allowed) return void res.status(429).json({ error: 'too_many_requests' });

  const code = generateCode();
  // Invalidate any earlier outstanding code for this target.
  await pool.query('UPDATE otp_codes SET consumed_at=now() WHERE target=$1 AND consumed_at IS NULL', [t.target]);
  await pool.query('INSERT INTO otp_codes(target, channel, code_hash, expires_at) VALUES($1,$2,$3,$4)', [
    t.target,
    channel,
    hashOtp(t.target, code),
    new Date(Date.now() + config.otp.ttlMs),
  ]);

  try {
    if (channel === 'email') await providers.email.sendEmail(t.target, 'קוד כניסה ל-WeighWise', `קוד הכניסה שלך: ${code}. תקף ל-5 דקות.`);
    else if (channel === 'sms') await providers.message.sendSms(t.target, `קוד הכניסה ל-WeighWise: ${code}`);
    else await providers.message.sendVoice(t.target, code, 2);
  } catch {
    // Delivery failures are not disclosed to the caller.
  }
  res.json(GENERIC);
});

authRouter.post('/otp/verify', async (req, res) => {
  const p = verifySchema.safeParse(req.body);
  const t = p.success ? normalizeTarget(p.data.target) : null;
  if (!p.success || !t) return void res.status(401).json(BAD_CODE);
  if (!hit(`verify:ip:${req.ip ?? 'unknown'}`, 60, 10 * 60_000)) return void res.status(429).json({ error: 'too_many_requests' });

  // Atomically count the attempt on the latest live code.
  const r = await pool.query(
    `UPDATE otp_codes SET attempts = attempts + 1
     WHERE id = (SELECT id FROM otp_codes WHERE target=$1 AND consumed_at IS NULL AND expires_at > now() AND attempts < $2
                 ORDER BY created_at DESC LIMIT 1)
     RETURNING id, code_hash`,
    [t.target, config.otp.maxAttempts],
  );
  if (!r.rowCount || !safeEqual(r.rows[0].code_hash, hashOtp(t.target, p.data.code))) return void res.status(401).json(BAD_CODE);

  const used = await pool.query('UPDATE otp_codes SET consumed_at=now() WHERE id=$1 AND consumed_at IS NULL', [r.rows[0].id]);
  if (!used.rowCount) return void res.status(401).json(BAD_CODE);

  const col = t.kind === 'email' ? 'email' : 'phone';
  let u = await pool.query(`SELECT id, full_name FROM users WHERE ${col}=$1 AND deleted_at IS NULL`, [t.target]);
  if (!u.rowCount) {
    u = await pool.query(`INSERT INTO users(${col}) VALUES($1) RETURNING id, full_name`, [t.target]);
  }
  res.json({ token: signToken(u.rows[0].id), needsProfile: !u.rows[0].full_name });
});
