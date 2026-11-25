import { useState } from 'react';
import { api, ApiError, type Profile } from '../api';

interface Props {
  token: string;
  initial?: Partial<Profile> & { hasEmail?: boolean; hasPhone?: boolean };
  hasEmail: boolean;
  hasPhone: boolean;
  submitLabel: string;
  onSaved: () => void;
}

/** Registration / profile settings. Terms are required; AI processing and SMS are optional consents. */
export function ProfileForm({ token, initial, hasEmail, hasPhone, submitLabel, onSaved }: Props) {
  const consents = initial?.consents ?? [];
  const [fullName, setFullName] = useState(initial?.fullName ?? '');
  const [birthYear, setBirthYear] = useState(initial?.birthYear ? String(initial.birthYear) : '');
  const [heightCm, setHeightCm] = useState(initial?.heightCm ? String(initial.heightCm) : '');
  const [channel, setChannel] = useState<'email' | 'sms'>(initial?.preferredChannel ?? (hasEmail ? 'email' : 'sms'));
  const [terms, setTerms] = useState(consents.includes('terms'));
  const [ai, setAi] = useState(consents.includes('ai_processing'));
  const [sms, setSms] = useState(consents.includes('sms') || (!hasEmail && hasPhone));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api('/users/profile', {
        method: 'POST',
        token,
        body: { fullName, birthYear: Number(birthYear), heightCm: Number(heightCm), preferredChannel: channel, consents: { terms, ai_processing: ai, sms } },
      });
      onSaved();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : '';
      setError(code === 'sms_requires_phone_and_consent' ? 'שליחה ב-SMS דורשת מספר טלפון והסכמה לקבלת הודעות.' : 'בדקו שכל השדות מולאו נכון (שנת לידה, גובה והסכמה לתנאים).');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ textAlign: 'right' }}>
      <label htmlFor="fn">שם מלא</label>
      <input id="fn" type="text" value={fullName} onChange={(e) => setFullName(e.target.value)} required maxLength={100} autoComplete="name" />
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <label htmlFor="by">שנת לידה</label>
          <input id="by" type="number" inputMode="numeric" min={1900} max={new Date().getFullYear() - 5} value={birthYear} onChange={(e) => setBirthYear(e.target.value)} required />
        </div>
        <div style={{ flex: 1 }}>
          <label htmlFor="h">גובה (ס״מ)</label>
          <input id="h" type="number" inputMode="numeric" min={80} max={250} value={heightCm} onChange={(e) => setHeightCm(e.target.value)} required />
        </div>
      </div>
      <label htmlFor="ch">ערוץ שליחת התוצאות</label>
      <select id="ch" value={channel} onChange={(e) => setChannel(e.target.value as 'email' | 'sms')}>
        {hasEmail && <option value="email">דוא״ל</option>}
        {hasPhone && <option value="sms">SMS</option>}
      </select>
      <label className="check">
        <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} required />
        <span>קראתי ואני מסכים/ה לתנאי השימוש ולמדיניות הפרטיות, כולל עיבוד נתוני משקל והרכב גוף (מידע בריאותי רגיש).</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={ai} onChange={(e) => setAi(e.target.checked)} />
        <span>אני מסכים/ה שנתוני המדידה, ללא פרטים מזהים, יעובדו על ידי סוכן AI לצורך הסבר והמלצות.</span>
      </label>
      {hasPhone && (
        <label className="check">
          <input type="checkbox" checked={sms} onChange={(e) => setSms(e.target.checked)} />
          <span>אני מסכים/ה לקבל הודעות SMS עם קישור לתוצאות.</span>
        </label>
      )}
      {error && <div className="error" role="alert">{error}</div>}
      <button className="btn" style={{ marginTop: '1rem' }} disabled={busy}>
        {submitLabel}
      </button>
    </form>
  );
}
