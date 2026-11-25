import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db.js';
import { requireStation, requireUser } from '../auth/middleware.js';
import { HttpError } from '../errors.js';
import { beginMeasuring, cancelSession, completeHygieneStep, confirmPrep, createSession, getOwnedSession, pay, sessionView } from '../services/sessions.js';
import { getLive, startMeasurement } from '../services/measure.js';

export const sessionsRouter = Router();
// Every session endpoint needs the kiosk key AND the signed-in customer.
sessionsRouter.use(requireStation, requireUser);

const idParam = z.string().uuid();
const owned = async (req: import('express').Request) => {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) throw new HttpError(404, 'not_found');
  return getOwnedSession(id.data, req.user!.id, req.station!.id);
};

sessionsRouter.post('/', async (req, res) => {
  const id = await createSession(req.user!.id, req.station!.id);
  res.status(201).json({ id });
});

sessionsRouter.get('/:id', async (req, res) => {
  const s = await owned(req);
  res.json({ ...(await sessionView(s)), live: getLive(s.id), config: { idleResetMs: config.idleResetMs, measureDurationMs: config.measure.durationMs } });
});

sessionsRouter.post('/:id/pay', async (req, res) => {
  const s = await owned(req);
  const key = (req.header('idempotency-key') ?? `session:${s.id}`).slice(0, 100);
  res.json(await pay(s.id, key));
});

sessionsRouter.post('/:id/hygiene/:step', async (req, res) => {
  const s = await owned(req);
  const step = z.coerce.number().int().min(1).max(5).safeParse(req.params.step);
  if (!step.success) throw new HttpError(400, 'invalid_request');
  res.json(await completeHygieneStep(s.id, step.data));
});

sessionsRouter.post('/:id/confirm-prep', async (req, res) => {
  const s = await owned(req);
  const b = z.object({ deviceSuitability: z.literal(true), cleanedPerInstructions: z.literal(true) }).safeParse(req.body);
  if (!b.success) throw new HttpError(400, 'invalid_request');
  await confirmPrep(s.id, req.user!.id, b.data);
  res.json({ ok: true });
});

const measureBody = z
  .object({
    manual: z.object({ weightKg: z.number(), bodyFatPct: z.number(), muscleMassKg: z.number(), bodyWaterPct: z.number() }).optional(),
  })
  .optional();

sessionsRouter.post('/:id/measure', async (req, res) => {
  const s = await owned(req);
  const b = measureBody.safeParse(req.body && Object.keys(req.body).length ? req.body : undefined);
  if (!b.success) throw new HttpError(400, 'invalid_request');
  // Manual entry exists for testing only and is hidden behind a dev flag.
  if (b.data?.manual && !config.measure.manualEntry) throw new HttpError(403, 'forbidden');
  await beginMeasuring(s.id);
  const m = b.data?.manual;
  startMeasurement(s.id, m && { weightKg: m.weightKg, composition: { bodyFatPct: m.bodyFatPct, muscleMassKg: m.muscleMassKg, bodyWaterPct: m.bodyWaterPct } });
  res.status(202).json({ ok: true });
});

sessionsRouter.get('/:id/result', async (req, res) => {
  const s = await owned(req);
  const r = await pool.query(
    `SELECT m.id, m.weight_kg AS "weightKg", m.bmi, m.body_fat_pct AS "bodyFatPct", m.muscle_mass_kg AS "muscleMassKg", m.body_water_pct AS "bodyWaterPct",
            m.is_outlier AS "isOutlier", m.measured_at AS "measuredAt",
            r.explanation, r.recommendations, r.suggest_professional AS "suggestProfessional",
            (SELECT weight_kg FROM measurements p WHERE p.user_id=m.user_id AND p.measured_at < m.measured_at ORDER BY p.measured_at DESC LIMIT 1) AS "previousWeightKg"
     FROM measurements m LEFT JOIN recommendations r ON r.measurement_id=m.id WHERE m.session_id=$1`,
    [s.id],
  );
  if (!r.rowCount) throw new HttpError(404, 'not_found');
  res.json(r.rows[0]);
});

sessionsRouter.post('/:id/cancel', async (req, res) => {
  const s = await owned(req);
  await cancelSession(s.id);
  res.json({ ok: true });
});

