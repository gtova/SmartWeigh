import { config } from '../config.js';
import { pool, tx } from '../db.js';
import { providers } from '../providers/message.js';
import { createQueue } from './queue.js';
import { lockSession, transition } from './stateMachine.js';

// Fixed templates: only what is needed goes into a message body.
export const resultLink = (measurementId: string) =>
  `${config.webOrigin}/login?next=${encodeURIComponent(`/measurements/${measurementId}`)}`;

export const emailTemplate = (weight: number, explanation: string, link: string) => ({
  subject: 'התוצאה שלך מ-WeighWise מוכנה',
  body: `משקל: ${weight.toFixed(1)} ק"ג\n${explanation}\nלפרטים המלאים: ${link}\nהתוכן נועד לעידוד בלבד ואינו מהווה ייעוץ רפואי או תזונתי.`,
});
export const smsTemplate = (link: string) => `WeighWise: התוצאה שלך מוכנה. לצפייה: ${link}`;

export interface NotifyJob {
  measurementId: string;
}
export const notifyQueue = createQueue<NotifyJob>('notify');

interface Ctx {
  userId: string;
  sessionId: string;
  weight: number;
  explanation: string;
  email: string | null;
  phone: string | null;
  preferred: 'email' | 'sms';
  smsConsent: boolean;
}

async function load(measurementId: string): Promise<Ctx> {
  const r = await pool.query(
    `SELECT m.user_id, m.session_id, m.weight_kg, u.email, u.phone, u.preferred_channel, r.explanation,
            EXISTS(SELECT 1 FROM consents c WHERE c.user_id=u.id AND c.type='sms' AND c.revoked_at IS NULL) AS sms_consent
     FROM measurements m JOIN users u ON u.id=m.user_id LEFT JOIN recommendations r ON r.measurement_id=m.id WHERE m.id=$1`,
    [measurementId],
  );
  const x = r.rows[0];
  return {
    userId: x.user_id, sessionId: x.session_id, weight: x.weight_kg, explanation: x.explanation ?? '', email: x.email,
    phone: x.phone, preferred: x.preferred_channel, smsConsent: x.sms_consent,
  };
}

/** SMS only with consent; otherwise fall back to email when we have one. */
function pickChannel(c: Ctx): 'email' | 'sms' | null {
  const smsOk = !!c.phone && c.smsConsent;
  if (c.preferred === 'sms' && smsOk) return 'sms';
  if (c.email) return 'email';
  return smsOk ? 'sms' : null;
}

async function attempt(measurementId: string) {
  const c = await load(measurementId);
  const channel = pickChannel(c);
  if (!channel) throw new Error('no_deliverable_channel');
  await pool.query(
    `INSERT INTO notifications(measurement_id, channel, status, attempts) SELECT $1,$2,'pending',0
     WHERE NOT EXISTS (SELECT 1 FROM notifications WHERE measurement_id=$1 AND channel=$2)`,
    [measurementId, channel],
  );
  const n = (await pool.query('SELECT id FROM notifications WHERE measurement_id=$1 AND channel=$2', [measurementId, channel])).rows[0].id;
  await pool.query('UPDATE notifications SET attempts=attempts+1 WHERE id=$1', [n]);
  try {
    const link = resultLink(measurementId);
    if (channel === 'email') {
      const t = emailTemplate(c.weight, c.explanation, link);
      await providers.email.sendEmail(c.email!, t.subject, t.body);
    } else {
      await providers.message.sendSms(c.phone!, smsTemplate(link));
    }
  } catch (e) {
    await pool.query("UPDATE notifications SET last_error=$2, status='retrying' WHERE id=$1", [n, e instanceof Error ? e.message.slice(0, 200) : 'error']);
    throw e;
  }
  await pool.query("UPDATE notifications SET status='sent', sent_at=now(), last_error=NULL WHERE id=$1", [n]);
  await tx(async (cl) => {
    const s = await lockSession(cl, c.sessionId);
    if (s.state === 'saved' || s.state === 'failed_notify') await transition(cl, s, 'notified', { channel });
  });
}

async function giveUp(job: NotifyJob, err: Error) {
  await pool.query("UPDATE notifications SET status='failed', last_error=$2 WHERE measurement_id=$1", [job.measurementId, err.message.slice(0, 200)]);
  const sid = (await pool.query('SELECT session_id FROM measurements WHERE id=$1', [job.measurementId])).rows[0]?.session_id;
  if (!sid) return;
  await tx(async (cl) => {
    const s = await lockSession(cl, sid);
    if (s.state === 'saved' || s.state === 'failed_notify') await transition(cl, s, 'failed_notify', { error: err.message.slice(0, 100) });
  });
}

notifyQueue.process((j) => attempt(j.measurementId), giveUp);

