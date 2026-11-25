import { config } from '../config.js';

// Provider abstraction: swap in a real SMS/voice/email vendor without touching the rest of the system.
export interface MessageProvider {
  sendSms(to: string, text: string): Promise<void>;
  /** Reads digits one by one; `repeat` times (voice channel). */
  sendVoice(to: string, digits: string, repeat: number): Promise<void>;
}
export interface EmailProvider {
  sendEmail(to: string, subject: string, body: string): Promise<void>;
}

export interface OutboxItem {
  kind: 'sms' | 'voice' | 'email';
  to: string;
  text: string;
}
/** Captured messages (tests / dev inspection). */
export const outbox: OutboxItem[] = [];

const mask = (s: string) => (s.length <= 4 ? '***' : `${s.slice(0, 2)}***${s.slice(-2)}`);

// Dev implementation: prints to the log. The body is printed only outside production so the OTP can be read.
const log = (kind: OutboxItem['kind'], to: string, text: string) => {
  outbox.push({ kind, to, text });
  if (outbox.length > 200) outbox.shift();
  if (process.env.NODE_ENV === 'test') return;
  console.log(`[${kind}] to=${mask(to)} ${config.devMode ? text : '(hidden)'}`);
};

export const logMessageProvider: MessageProvider = {
  async sendSms(to, text) {
    log('sms', to, text);
  },
  async sendVoice(to, digits, repeat) {
    log('voice', to, Array(repeat).fill(digits.split('').join(' ')).join(' ... '));
  },
};

export const logEmailProvider: EmailProvider = {
  async sendEmail(to, subject, body) {
    log('email', to, `${subject}: ${body}`);
  },
};

export const providers: { message: MessageProvider; email: EmailProvider } = {
  message: logMessageProvider,
  email: logEmailProvider,
};
