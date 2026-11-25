import { config } from '../config.js';
import { pool, tx } from '../db.js';
import { HttpError } from '../errors.js';
import { paymentProviders } from '../providers/payment.js';
import { lockSession, transition, type SessionRow } from './stateMachine.js';

export async function createSession(userId: string, stationId: string) {
  const u = await pool.query('SELECT birth_year, height_cm FROM users WHERE id=$1 AND deleted_at IS NULL', [userId]);
  if (!u.rows[0]?.birth_year || !u.rows[0]?.height_cm) throw new HttpError(409, 'profile_incomplete');
  return tx(async (c) => {
    const r = await c.query('INSERT INTO weigh_sessions(user_id, station_id) VALUES($1,$2) RETURNING id', [userId, stationId]);
    await c.query("INSERT INTO session_events(session_id, from_state, to_state) VALUES($1, NULL, 'created')", [r.rows[0].id]);
    return r.rows[0].id as string;
  });
}

export async function getOwnedSession(id: string, userId: string, stationId: string) {
  const r = await pool.query('SELECT * FROM weigh_sessions WHERE id=$1 AND user_id=$2 AND station_id=$3', [id, userId, stationId]);
  if (!r.rowCount) throw new HttpError(404, 'not_found');
  return r.rows[0] as SessionRow;
}

export async function pay(sessionId: string, idempotencyKey: string) {
  // Phase 1: validate under lock. Phase 2: charge outside the transaction. Phase 3: record.
  const existing = await tx(async (c) => {
    const s = await lockSession(c, sessionId);
    const p = await c.query('SELECT status FROM payments WHERE session_id=$1', [sessionId]);
    if (p.rows[0]?.status === 'succeeded') return 'done';
    if (s.state !== 'created' && s.state !== 'failed_payment') throw new HttpError(409, 'invalid_transition', { from: s.state, to: 'paid' });
    return 'charge';
  });
  if (existing === 'done') return { state: 'paid' as const };

  const res = await paymentProviders.payment.charge({ sessionId, amountAgorot: config.priceAgorot, idempotencyKey });
  return tx(async (c) => {
    const s = await lockSession(c, sessionId);
    if (s.state !== 'created' && s.state !== 'failed_payment') return { state: s.state };
    await c.query(
      `INSERT INTO payments(session_id, status, provider, provider_txn_id, amount, idempotency_key)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT (session_id) DO UPDATE SET status=EXCLUDED.status, provider_txn_id=EXCLUDED.provider_txn_id, idempotency_key=EXCLUDED.idempotency_key`,
      [sessionId, res.ok ? 'succeeded' : 'failed', paymentProviders.payment.name, res.txnId ?? null, config.priceAgorot, idempotencyKey],
    );
    await transition(c, s, res.ok ? 'paid' : 'failed_payment', { provider: paymentProviders.payment.name });
    return { state: s.state };
  });
}

export const HYGIENE_STEPS = 5;

/** Records one guided hygiene step. Steps must be done in order; the drying step enforces the wait server-side. */
export async function completeHygieneStep(sessionId: string, stepNo: number) {
  return tx(async (c) => {
    const s = await lockSession(c, sessionId);
    if (s.state !== 'paid' && s.state !== 'hygiene_in_progress') throw new HttpError(409, 'invalid_transition', { from: s.state });
    const steps = await c.query('SELECT step_no, completed_at FROM hygiene_steps WHERE session_id=$1 AND round=$2 ORDER BY step_no', [sessionId, s.hygiene_round]);
    const done = steps.rowCount ?? 0;
    if (stepNo <= done) return { stepsDone: done }; // idempotent repeat
    if (stepNo !== done + 1) throw new HttpError(409, 'step_out_of_order', { expected: done + 1 });
    if (stepNo === HYGIENE_STEPS) {
      const prev = new Date(steps.rows[done - 1].completed_at).getTime();
      const remaining = prev + config.hygiene.dryMs - Date.now();
      if (remaining > 0) throw new HttpError(409, 'drying_not_finished', { remainingMs: remaining });
    }
    await c.query('INSERT INTO hygiene_steps(session_id, step_no, round) VALUES($1,$2,$3)', [sessionId, stepNo, s.hygiene_round]);
    if (s.state === 'paid') await transition(c, s, 'hygiene_in_progress');
    else await c.query('UPDATE weigh_sessions SET updated_at=now() WHERE id=$1', [sessionId]);
    if (stepNo === HYGIENE_STEPS) await c.query('UPDATE weigh_sessions SET hygiene_done_at=now() WHERE id=$1', [sessionId]);
    return { stepsDone: stepNo };
  });
}

const hygieneExpired = (s: SessionRow) => !s.hygiene_done_at || Date.now() - new Date(s.hygiene_done_at).getTime() > config.hygiene.expiryMs;

/** If more than the allowed time passed since cleaning finished, the procedure restarts (new round, history kept). */
async function restartHygiene(c: import('pg').PoolClient, s: SessionRow) {
  if (s.state === 'hygiene_in_progress') {
    await c.query('UPDATE weigh_sessions SET hygiene_done_at=NULL, hygiene_round=hygiene_round+1, updated_at=now() WHERE id=$1', [s.id]);
    await c.query("INSERT INTO session_events(session_id, from_state, to_state, meta) VALUES($1,'hygiene_in_progress','hygiene_in_progress',$2)", [s.id, JSON.stringify({ reason: 'hygiene_expired' })]);
    return;
  }
  await transition(c, s, 'hygiene_in_progress', { reason: 'hygiene_expired' }, 'hygiene_done_at=NULL, hygiene_round=hygiene_round+1');
}

export async function confirmPrep(sessionId: string, userId: string, body: { deviceSuitability: true; cleanedPerInstructions: true }) {
  void body;
  const res = await tx(async (c) => {
    const s = await lockSession(c, sessionId);
    if (s.state !== 'hygiene_in_progress' || !s.hygiene_done_at) throw new HttpError(409, 'hygiene_incomplete');
    if (hygieneExpired(s)) {
      await restartHygiene(c, s);
      return { expired: true };
    }
    await c.query('INSERT INTO consents(user_id, type, terms_version) VALUES($1,$2,$3)', [userId, 'device_suitability', config.termsVersion]);
    await c.query('UPDATE weigh_sessions SET device_suitability_confirmed_at=now() WHERE id=$1', [sessionId]);
    await transition(c, s, 'prep_confirmed');
    return { expired: false };
  });
  if (res.expired) throw new HttpError(409, 'hygiene_expired');
}

/** Gate before a measurement starts. Returns the locked session on success. */
export async function beginMeasuring(sessionId: string) {
  const res = await tx(async (c) => {
    const s = await lockSession(c, sessionId);
    const retry = s.state === 'failed_measure';
    if (s.state !== 'prep_confirmed' && !retry) throw new HttpError(409, 'invalid_transition', { from: s.state, to: 'measuring' });
    if (retry && s.measure_attempts >= 2) throw new HttpError(409, 'no_retries_left');
    if (hygieneExpired(s)) {
      await restartHygiene(c, s);
      return { expired: true };
    }
    await transition(c, s, 'measuring', { attempt: s.measure_attempts + 1 }, 'measure_attempts=measure_attempts+1');
    return { expired: false };
  });
  if (res.expired) throw new HttpError(409, 'hygiene_expired');
}

export async function cancelSession(sessionId: string) {
  await tx(async (c) => {
    const s = await lockSession(c, sessionId);
    if (['notified', 'abandoned', 'saved', 'measured', 'failed_notify'].includes(s.state)) return; // nothing to cancel
    await transition(c, s, 'abandoned', { reason: 'cancelled' });
  });
}

/** Marks sessions with no progress for 5 minutes as abandoned (paid ones are flagged for review). */
export async function expireStaleSessions() {
  const stale = await pool.query(
    `SELECT id FROM weigh_sessions
     WHERE state IN ('created','failed_payment','paid','hygiene_in_progress','prep_confirmed','failed_measure')
       AND updated_at < now() - ($1 || ' milliseconds')::interval`,
    [String(config.hygiene.expiryMs)],
  );
  for (const row of stale.rows) {
    await tx(async (c) => {
      const s = await lockSession(c, row.id);
      if (['created', 'failed_payment', 'paid', 'hygiene_in_progress', 'prep_confirmed', 'failed_measure'].includes(s.state)) {
        await transition(c, s, 'abandoned', { reason: 'timeout' });
      }
    });
  }
  return stale.rowCount ?? 0;
}

export async function sessionView(s: SessionRow) {
  const steps = await pool.query('SELECT step_no, completed_at FROM hygiene_steps WHERE session_id=$1 AND round=$2 ORDER BY step_no', [s.id, s.hygiene_round]);
  const last = steps.rows[steps.rowCount! - 1];
  const dryRemainingMs =
    steps.rowCount === HYGIENE_STEPS - 1 ? Math.max(0, new Date(last.completed_at).getTime() + config.hygiene.dryMs - Date.now()) : 0;
  const m = await pool.query('SELECT id FROM measurements WHERE session_id=$1', [s.id]);
  const n = m.rowCount ? await pool.query('SELECT status, channel FROM notifications WHERE measurement_id=$1 ORDER BY attempts DESC LIMIT 1', [m.rows[0].id]) : null;
  return {
    id: s.id,
    state: s.state,
    notification: n?.rows[0] ? { status: n.rows[0].status as string, channel: n.rows[0].channel as string } : null,
    hygiene: { round: s.hygiene_round, stepsDone: steps.rowCount, totalSteps: HYGIENE_STEPS, dryRemainingMs },
    attempts: s.measure_attempts,
    measurementId: (m.rows[0]?.id as string) ?? null,
  };
}


