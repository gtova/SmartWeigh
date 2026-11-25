import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { pool } from '../db.js';
import { hashDeviceKey } from './crypto.js';

export interface AuthUser {
  id: string;
  email: string | null;
  phone: string | null;
}
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      station?: { id: string; name: string };
    }
  }
}

export const signToken = (userId: string) =>
  jwt.sign({ sub: userId, role: 'customer' }, config.jwtSecret, { expiresIn: '1h' });

export async function requireUser(req: Request, res: Response, next: NextFunction) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return void res.status(401).json({ error: 'unauthorized' });
  try {
    const p = jwt.verify(h.slice(7), config.jwtSecret) as { sub: string; role: string };
    if (p.role !== 'customer') throw new Error('role');
    const r = await pool.query('SELECT id, email, phone FROM users WHERE id=$1 AND deleted_at IS NULL', [p.sub]);
    if (!r.rowCount) throw new Error('nouser');
    req.user = r.rows[0];
    next();
  } catch {
    res.status(401).json({ error: 'unauthorized' });
  }
}

/** Resolves the kiosk from the X-Station-Key header (stored hashed, revocable by changing status). */
export async function stationFromHeader(req: Request) {
  const key = req.headers['x-station-key'];
  if (typeof key !== 'string' || !key) return null;
  const r = await pool.query("SELECT id, name FROM stations WHERE device_key_hash=$1 AND status='active'", [hashDeviceKey(key)]);
  if (!r.rowCount) return null;
  await pool.query('UPDATE stations SET last_seen_at=now() WHERE id=$1', [r.rows[0].id]);
  return r.rows[0] as { id: string; name: string };
}

export async function requireStation(req: Request, res: Response, next: NextFunction) {
  const s = await stationFromHeader(req);
  if (!s) return void res.status(401).json({ error: 'unauthorized' });
  req.station = s;
  next();
}
