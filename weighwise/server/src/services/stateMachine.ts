import type pg from 'pg';
import { HttpError } from '../errors.js';

export type SessionState =
  | 'created' | 'paid' | 'hygiene_in_progress' | 'prep_confirmed' | 'measuring' | 'measured'
  | 'saved' | 'notified' | 'failed_payment' | 'abandoned' | 'failed_measure' | 'failed_notify';

// The server is the single authority on legal moves.
export const TRANSITIONS: Record<SessionState, SessionState[]> = {
  created: ['paid', 'failed_payment', 'abandoned'],
  failed_payment: ['paid', 'failed_payment', 'abandoned'],
  paid: ['hygiene_in_progress', 'abandoned'],
  hygiene_in_progress: ['prep_confirmed', 'abandoned'],
  prep_confirmed: ['measuring', 'hygiene_in_progress', 'abandoned'],
  measuring: ['measured', 'failed_measure'],
  failed_measure: ['measuring', 'hygiene_in_progress', 'abandoned'],
  measured: ['saved'],
  saved: ['notified', 'failed_notify'],
  failed_notify: ['notified', 'failed_notify'],
  notified: [],
  abandoned: [],
};

const TS_COLUMN: Partial<Record<SessionState, string>> = {
  paid: 'paid_at',
  prep_confirmed: 'prep_confirmed_at',
  measured: 'measured_at',
  saved: 'saved_at',
  notified: 'notified_at',
};

export interface SessionRow {
  id: string;
  user_id: string;
  station_id: string;
  state: SessionState;
  paid_at: Date | null;
  hygiene_done_at: Date | null;
  measure_attempts: number;
  hygiene_round: number;
  updated_at: Date;
}

export async function lockSession(c: pg.PoolClient, id: string): Promise<SessionRow> {
  const r = await c.query('SELECT * FROM weigh_sessions WHERE id=$1 FOR UPDATE', [id]);
  if (!r.rowCount) throw new HttpError(404, 'not_found');
  return r.rows[0];
}

/** Moves a (locked) session to `to`, stamping the time and logging a session_event. */
export async function transition(
  c: pg.PoolClient,
  s: SessionRow,
  to: SessionState,
  meta: Record<string, unknown> = {},
  extraSet = '',
) {
  if (!TRANSITIONS[s.state].includes(to)) throw new HttpError(409, 'invalid_transition', { from: s.state, to });
  const tsCol = TS_COLUMN[to];
  const sets = ['state=$2', 'updated_at=now()'];
  if (tsCol) sets.push(`${tsCol}=now()`);
  if (to === 'abandoned' && s.paid_at) sets.push('needs_review=true');
  if (extraSet) sets.push(extraSet);
  await c.query(`UPDATE weigh_sessions SET ${sets.join(', ')} WHERE id=$1`, [s.id, to]);
  await c.query('INSERT INTO session_events(session_id, from_state, to_state, meta) VALUES($1,$2,$3,$4)', [
    s.id, s.state, to, JSON.stringify(meta),
  ]);
  s.state = to;
}
