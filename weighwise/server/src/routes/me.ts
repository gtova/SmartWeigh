import { Router } from 'express';
import { z } from 'zod';
import { requireUser } from '../auth/middleware.js';
import { config } from '../config.js';
import { pool, tx } from '../db.js';
import { HttpError } from '../errors.js';

export const measurementsRouter = Router();
export const meRouter = Router();
measurementsRouter.use(requireUser);
meRouter.use(requireUser);

const COLS = `m.id, m.weight_kg AS "weightKg", m.bmi, m.body_fat_pct AS "bodyFatPct", m.muscle_mass_kg AS "muscleMassKg",
  m.body_water_pct AS "bodyWaterPct", m.measured_at AS "measuredAt", m.is_outlier AS "isOutlier"`;

const listQuery = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() });

measurementsRouter.get('/', async (req, res) => {
  const q = listQuery.safeParse(req.query);
  if (!q.success) throw new HttpError(400, 'invalid_request');
  const r = await pool.query(
    `SELECT ${COLS} FROM measurements m WHERE m.user_id=$1 AND ($2::timestamptz IS NULL OR m.measured_at >= $2) AND ($3::timestamptz IS NULL OR m.measured_at <= $3)
     ORDER BY m.measured_at DESC LIMIT 1000`,
    [req.user!.id, q.data.from ?? null, q.data.to ?? null],
  );
  res.json(r.rows);
});

// Always scoped by user_id, so another user's id simply returns 404.
measurementsRouter.get('/:id', async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) throw new HttpError(404, 'not_found');
  const r = await pool.query(
    `SELECT ${COLS}, r.explanation, r.recommendations, r.suggest_professional AS "suggestProfessional"
     FROM measurements m LEFT JOIN recommendations r ON r.measurement_id=m.id WHERE m.id=$1 AND m.user_id=$2`,
    [id.data, req.user!.id],
  );
  if (!r.rowCount) throw new HttpError(404, 'not_found');
  const prev = await pool.query(`SELECT ${COLS} FROM measurements m WHERE m.user_id=$1 AND m.measured_at < $2 ORDER BY m.measured_at DESC LIMIT 1`, [
    req.user!.id,
    r.rows[0].measuredAt,
  ]);
  res.json({ ...r.rows[0], previous: prev.rows[0] ?? null });
});

meRouter.get('/export', async (req, res) => {
  const uid = req.user!.id;
  const q = async (sql: string) => (await pool.query(sql, [uid])).rows;
  const data = {
    exportedAt: new Date().toISOString(),
    profile: (await q('SELECT email, phone, full_name, birth_year, height_cm, preferred_channel, created_at FROM users WHERE id=$1'))[0],
    consents: await q('SELECT type, terms_version, granted_at, revoked_at FROM consents WHERE user_id=$1'),
    measurements: await q('SELECT id, weight_kg, bmi, body_fat_pct, muscle_mass_kg, body_water_pct, measured_at FROM measurements WHERE user_id=$1 ORDER BY measured_at'),
    recommendations: await q(
      'SELECT r.measurement_id, r.explanation, r.recommendations, r.created_at FROM recommendations r JOIN measurements m ON m.id=r.measurement_id WHERE m.user_id=$1',
    ),
  };
  res.setHeader('Content-Disposition', 'attachment; filename="weighwise-export.json"');
  res.json(data);
});

/** Marks the account deleted and strips personal details now; physical removal follows in `purgeDeletedUsers`. */
meRouter.delete('/', async (req, res) => {
  const uid = req.user!.id;
  await tx(async (c) => {
    const u = (await c.query('SELECT email, phone FROM users WHERE id=$1', [uid])).rows[0];
    await c.query('DELETE FROM otp_codes WHERE target = ANY($1)', [[u.email, u.phone].filter(Boolean)]);
    await c.query(
      `UPDATE users SET deleted_at=now(), full_name=NULL, birth_year=NULL, height_cm=NULL,
         email = CASE WHEN email IS NOT NULL THEN 'deleted-' || id || '@invalid' END,
         phone = CASE WHEN phone IS NOT NULL THEN 'deleted-' || id END WHERE id=$1`,
      [uid],
    );
    await c.query("INSERT INTO audit_log(actor_id, actor_role, action, target) VALUES($1,'customer','delete_account',$1)", [uid]);
  });
  res.json({ ok: true });
});

/** Removes all of a deleted user's data (measurements, recommendations, consents, sessions). Payment rows keep only status + txn id. */
export async function purgeDeletedUsers(olderThanMs = config.purgeAfterMs) {
  const r = await pool.query("DELETE FROM users WHERE deleted_at IS NOT NULL AND deleted_at <= now() - ($1 || ' milliseconds')::interval", [String(olderThanMs)]);
  return r.rowCount ?? 0;
}
