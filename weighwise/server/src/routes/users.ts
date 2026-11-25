import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { pool, tx } from '../db.js';
import { requireUser } from '../auth/middleware.js';

export const usersRouter = Router();

const year = new Date().getFullYear();
const profileSchema = z.object({
  fullName: z.string().trim().min(1).max(100),
  birthYear: z.number().int().min(1900).max(year - 5),
  heightCm: z.number().int().min(80).max(250),
  preferredChannel: z.enum(['email', 'sms']),
  consents: z.object({
    terms: z.literal(true),
    ai_processing: z.boolean().default(false),
    sms: z.boolean().default(false),
  }),
});

usersRouter.get('/me', requireUser, async (req, res) => {
  const u = await pool.query(
    'SELECT id, email, phone, full_name AS "fullName", birth_year AS "birthYear", height_cm AS "heightCm", preferred_channel AS "preferredChannel" FROM users WHERE id=$1',
    [req.user!.id],
  );
  const c = await pool.query('SELECT type FROM consents WHERE user_id=$1 AND revoked_at IS NULL', [req.user!.id]);
  res.json({ ...u.rows[0], consents: c.rows.map((x) => x.type) });
});

// Completes registration or updates the profile. Consents are recorded with the terms version.
usersRouter.post('/profile', requireUser, async (req, res) => {
  const p = profileSchema.safeParse(req.body);
  if (!p.success) return void res.status(400).json({ error: 'invalid_request' });
  const d = p.data;
  const { email, phone } = req.user!;
  if (d.preferredChannel === 'sms' && (!phone || !d.consents.sms)) return void res.status(400).json({ error: 'sms_requires_phone_and_consent' });
  if (d.preferredChannel === 'email' && !email) return void res.status(400).json({ error: 'email_missing' });

  await tx(async (c) => {
    await c.query('UPDATE users SET full_name=$2, birth_year=$3, height_cm=$4, preferred_channel=$5 WHERE id=$1', [
      req.user!.id, d.fullName, d.birthYear, d.heightCm, d.preferredChannel,
    ]);
    for (const [type, granted] of Object.entries(d.consents)) {
      const active = await c.query('SELECT id FROM consents WHERE user_id=$1 AND type=$2 AND revoked_at IS NULL', [req.user!.id, type]);
      if (granted && !active.rowCount) {
        await c.query('INSERT INTO consents(user_id, type, terms_version) VALUES($1,$2,$3)', [req.user!.id, type, config.termsVersion]);
      } else if (!granted && active.rowCount) {
        await c.query('UPDATE consents SET revoked_at=now() WHERE user_id=$1 AND type=$2 AND revoked_at IS NULL', [req.user!.id, type]);
      }
    }
  });
  res.json({ ok: true });
});
