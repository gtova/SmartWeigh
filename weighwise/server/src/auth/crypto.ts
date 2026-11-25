import crypto from 'node:crypto';
import { config } from '../config.js';

// Station keys are long random secrets, so a plain SHA-256 is adequate for lookup.
export const hashDeviceKey = (key: string) => crypto.createHash('sha256').update(key).digest('hex');

// OTP codes are low-entropy, so use a keyed HMAC bound to the target (a leaked table can't be reversed without the secret).
export const hashOtp = (target: string, code: string) =>
  crypto.createHmac('sha256', config.jwtSecret).update(`${target}:${code}`).digest('hex');

export const generateCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

export function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
