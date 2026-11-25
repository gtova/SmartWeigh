import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { NumPad } from './NumPad';

interface Props {
  kiosk?: boolean;
  onDone: (token: string, needsProfile: boolean) => void;
}

type Kind = 'phone' | 'email';
type Channel = 'email' | 'sms' | 'voice';

/** One-time-code login, shared by the kiosk (touch keypad) and the website (regular inputs). */
export function LoginForm({ kiosk, onDone }: Props) {
  const [kind, setKind] = useState<Kind>('phone');
  const [target, setTarget] = useState('');
  const [channel, setChannel] = useState<Channel>('sms');
  const [stage, setStage] = useState<'target' | 'code'>('target');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [devCode, setDevCode] = useState('');

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const switchKind = (k: Kind) => {
    setKind(k);
    setTarget('');
    setChannel(k === 'email' ? 'email' : 'sms');
    setError('');
  };

  async function request(ch: Channel = channel) {
    setBusy(true);
    setError('');
    try {
      await api('/auth/otp/request', { method: 'POST', body: { target, channel: ch }, station: kiosk });
      setChannel(ch);
      setStage('code');
      setCode('');
      setCooldown(30);
      if (import.meta.env.DEV) {
        // Dev builds only: the server (DEV_SHOW_OTP=1) exposes the code because no real message is sent.
        fetch(`/api/dev/last-code?target=${encodeURIComponent(target)}`).then((r) => r.json()).then((d) => setDevCode(d.code ?? '')).catch(() => setDevCode(''));
      }
    } catch (e) {
      setError(e instanceof ApiError && e.status === 429 ? 'נעשו יותר מדי ניסיונות. נסו שוב בעוד מספר דקות.' : 'הפרטים אינם תקינים. בדקו ונסו שוב.');
    } finally {
      setBusy(false);
    }
  }

  async function verify(c: string) {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ token: string; needsProfile: boolean }>('/auth/otp/verify', { method: 'POST', body: { target, code: c }, station: kiosk });
      onDone(r.token, r.needsProfile);
    } catch {
      setError('הקוד שגוי או שפג תוקפו.');
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  const addCode = (d: string) => {
    if (busy || code.length >= 6) return;
    const next = code + d;
    setCode(next);
    if (next.length === 6) void verify(next);
  };

  if (stage === 'code') {
    return (
      <div style={{ display: 'grid', gap: '1rem' }}>
        <h2>הזינו את הקוד בן 6 הספרות</h2>
        <p className="muted">
          {channel === 'voice' ? 'הקוד מוקרא בשיחה קולית' : 'הקוד נשלח אליכם'} · תקף ל-5 דקות
        </p>
        {kiosk ? (
          <>
            <div className="otp-boxes" aria-live="polite" aria-label={`הוזנו ${code.length} ספרות`}>
              {Array.from({ length: 6 }, (_, i) => (
                <span key={i}>{code[i] ?? '•'}</span>
              ))}
            </div>
            <NumPad onDigit={addCode} onBackspace={() => setCode(code.slice(0, -1))} onClear={() => setCode('')} />
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void verify(code);
            }}
          >
            <label htmlFor="code">קוד אימות</label>
            <input id="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
            <button className="btn" style={{ marginTop: '1rem' }} disabled={busy || code.length !== 6}>
              כניסה
            </button>
          </form>
        )}
        {devCode && (
          <div className="notice warn">
            קוד לפיתוח: <strong dir="ltr">{devCode}</strong>{' '}
            <button type="button" className="btn ghost" onClick={() => (kiosk ? (setCode(devCode), void verify(devCode)) : setCode(devCode))}>
              מילוי אוטומטי
            </button>
          </div>
        )}
        {error && <div className="error" role="alert">{error}</div>}
        <div className="row" style={{ justifyContent: 'center' }}>
          <button className="btn ghost" disabled={busy || cooldown > 0} onClick={() => request()}>
            {cooldown > 0 ? `שליחה חוזרת בעוד ${cooldown} שניות` : 'לא קיבלתי קוד? שלחו שוב'}
          </button>
          {kind === 'phone' && channel !== 'voice' && (
            <button className="btn ghost" disabled={busy || cooldown > 0} onClick={() => request('voice')}>
              קבלת הקוד בשיחה קולית
            </button>
          )}
          <button className="btn ghost" onClick={() => setStage('target')}>
            החלפת יעד
          </button>
        </div>
      </div>
    );
  }

  const valid = kind === 'email' ? /\S+@\S+\.\S+/.test(target) : target.replace(/\D/g, '').length >= 9;
  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      <h2>התחברות מהירה וללא סיסמה</h2>
      <div className="seg" role="tablist" style={{ justifySelf: 'center' }}>
        <button role="tab" aria-selected={kind === 'phone'} className={kind === 'phone' ? 'on' : ''} onClick={() => switchKind('phone')}>
          מספר טלפון נייד
        </button>
        <button role="tab" aria-selected={kind === 'email'} className={kind === 'email' ? 'on' : ''} onClick={() => switchKind('email')}>
          כתובת דוא"ל
        </button>
      </div>
      {kiosk && kind === 'phone' ? (
        <>
          <div className="display" aria-live="polite">{target || '05_-_______'}</div>
          <NumPad onDigit={(d) => target.length < 10 && setTarget(target + d)} onBackspace={() => setTarget(target.slice(0, -1))} onClear={() => setTarget('')} />
        </>
      ) : (
        <div>
          <label htmlFor="target">{kind === 'email' ? 'כתובת דוא"ל' : 'מספר הטלפון הנייד'}</label>
          <input
            id="target"
            type={kind === 'email' ? 'email' : 'tel'}
            inputMode={kind === 'email' ? 'email' : 'tel'}
            autoComplete={kind === 'email' ? 'email' : 'tel'}
            dir="ltr"
            placeholder={kind === 'email' ? 'name@example.com' : '054-8291430'}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
        </div>
      )}
      {kind === 'phone' && (
        <div className="row" style={{ justifyContent: 'center' }} role="radiogroup" aria-label="דרך קבלת הקוד">
          <label className="check">
            <input type="radio" checked={channel === 'sms'} onChange={() => setChannel('sms')} /> קבלת קוד ב-SMS (מומלץ)
          </label>
          <label className="check">
            <input type="radio" checked={channel === 'voice'} onChange={() => setChannel('voice')} /> קבלת קוד בשיחה קולית
          </label>
        </div>
      )}
      {error && <div className="error" role="alert">{error}</div>}
      <button className={`btn ${kiosk ? 'big' : ''}`} disabled={!valid || busy} onClick={() => request()}>
        שלחו לי קוד
      </button>
    </div>
  );
}


