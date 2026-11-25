import { config } from '../config.js';
import { pool, tx } from '../db.js';
import { emitSaved } from '../events.js';
import { SimulatedScale, type Composition, type ScaleOverride, type ScaleProvider, type ScaleReading } from '../providers/scale.js';
import { lockSession, transition } from './stateMachine.js';

export const scaleFactory: { create: () => ScaleProvider } = {
  create: () => new SimulatedScale(config.measure.durationMs),
};

export const LIMITS = { weight: [20, 300], fat: [3, 60], water: [30, 80] } as const;
const inRange = (v: number, [lo, hi]: readonly [number, number] | readonly number[]) => v >= lo && v <= hi;

export interface LiveState {
  progress: number;
  weightKg: number | null;
  contactsOk: boolean;
  stable: boolean;
}
const live = new Map<string, LiveState>();
const running = new Map<string, Promise<void>>();

export const getLive = (sessionId: string) => live.get(sessionId) ?? null;
/** Resolves when the in-flight measurement for a session finishes (tests / graceful shutdown). */
export const waitForMeasure = (sessionId: string) => running.get(sessionId) ?? Promise.resolve();

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Three consecutive readings within 0.1 kg with good contact on both hands and both feet. */
export function isStable(readings: ScaleReading[]): boolean {
  if (readings.length < 3) return false;
  const last = readings.slice(-3);
  const ws = last.map((r) => r.weightKg);
  const contactOk = last.every((r) => Object.values(r.contacts).every(Boolean));
  return contactOk && round1(Math.max(...ws) - Math.min(...ws)) <= 0.1;
}

/** Composition values outside plausible ranges are dropped (weight is kept). */
export function sanitizeComposition(c: Composition | undefined, bmi: number) {
  const fat = c && inRange(c.bodyFatPct, LIMITS.fat) ? round1(c.bodyFatPct) : null;
  const water = c && inRange(c.bodyWaterPct, LIMITS.water) ? round1(c.bodyWaterPct) : null;
  const muscle = c && c.muscleMassKg > 0 ? round1(c.muscleMassKg) : null;
  return { bmi: round1(bmi), fat, water, muscle };
}

export function startMeasurement(sessionId: string, override?: ScaleOverride) {
  const p = run(sessionId, override).finally(() => {
    running.delete(sessionId);
    setTimeout(() => live.delete(sessionId), 60_000).unref();
  });
  running.set(sessionId, p);
}

async function run(sessionId: string, override?: ScaleOverride) {
  const info = (
    await pool.query(
      'SELECT s.user_id, s.station_id, u.birth_year, u.height_cm FROM weigh_sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1',
      [sessionId],
    )
  ).rows[0];
  const age = new Date().getFullYear() - info.birth_year;
  const scale = scaleFactory.create();
  const readings: ScaleReading[] = [];
  const t0 = Date.now();
  live.set(sessionId, { progress: 0, weightKg: null, contactsOk: false, stable: false });

  const result = await new Promise<ScaleReading | null>((resolve) => {
    const timeout = setTimeout(() => resolve(null), config.measure.durationMs * 2 + 50);
    scale.onReading((r) => {
      readings.push(r);
      const stable = isStable(readings) && !!r.composition;
      live.set(sessionId, {
        progress: Math.min(1, (Date.now() - t0) / config.measure.durationMs),
        weightKg: r.weightKg,
        contactsOk: Object.values(r.contacts).every(Boolean),
        stable,
      });
      if (stable) {
        clearTimeout(timeout);
        resolve(r);
      }
    });
    scale.start({ age, heightCm: info.height_cm }, override);
  });
  scale.stop();

  if (!result || !inRange(result.weightKg, LIMITS.weight)) return fail(sessionId);
  await save(sessionId, info.user_id, info.station_id, info.height_cm, result, readings.length);
}

async function fail(sessionId: string) {
  await tx(async (c) => {
    const s = await lockSession(c, sessionId);
    if (s.state !== 'measuring') return;
    // One free retry; after the second failure the paid session is flagged for refund review.
    await transition(c, s, 'failed_measure', {}, s.measure_attempts >= 2 ? 'needs_review=true' : '');
  });
}

async function save(sessionId: string, userId: string, stationId: string, heightCm: number, r: ScaleReading, nReadings: number) {
  const m = sanitizeComposition(r.composition, r.weightKg / (heightCm / 100) ** 2);
  const out = await tx(async (c) => {
    const s = await lockSession(c, sessionId);
    if (s.state !== 'measuring') return null;
    const prev = await c.query(
      `SELECT weight_kg FROM measurements WHERE user_id=$1 AND measured_at > now() - ($2 || ' days')::interval ORDER BY measured_at DESC LIMIT 1`,
      [userId, String(config.flags.outlierDays)],
    );
    const isOutlier = prev.rowCount ? Math.abs(r.weightKg - prev.rows[0].weight_kg) > config.flags.outlierKg : false;
    const ins = await c.query(
      `INSERT INTO measurements(session_id, user_id, weight_kg, bmi, body_fat_pct, muscle_mass_kg, body_water_pct, raw_payload, station_id, is_outlier, is_stable)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)
       ON CONFLICT (session_id) DO NOTHING RETURNING id`,
      [sessionId, userId, r.weightKg, m.bmi, m.fat, m.muscle, m.water, JSON.stringify({ readings: nReadings, contacts: r.contacts }), stationId, isOutlier],
    );
    await transition(c, s, 'measured');
    await transition(c, s, 'saved');
    return ins.rows[0]?.id as string | undefined;
  });
  if (out) emitSaved({ sessionId, measurementId: out, userId });
}
