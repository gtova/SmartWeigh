import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, COMPOSITION_DISCLAIMER, DISCLAIMER, type Profile } from '../api';
import { LoginForm } from '../components/LoginForm';
import { ProfileForm } from '../components/ProfileForm';

type Step = 'welcome' | 'auth' | 'profile' | 'pay' | 'hygiene' | 'prep' | 'measure' | 'result' | 'done';

const BAR: { label: string; steps: Step[] }[] = [
  { label: 'התחלה', steps: ['welcome'] },
  { label: 'זיהוי', steps: ['auth', 'profile'] },
  { label: 'תשלום', steps: ['pay'] },
  { label: 'הכנה', steps: ['hygiene', 'prep'] },
  { label: 'שקילה', steps: ['measure'] },
  { label: 'תוצאות', steps: ['result', 'done'] },
];

const HYGIENE = [
  'חיטוי ידיים בג׳ל שבעמדה',
  'ניגוב לוחות האלקטרודות לכפות הרגליים במגבון חדש',
  'ניגוב ידיות האחיזה במגבון נוסף',
  'בדיקה שאין נוזל על המשטח, והשלכת המגבונים לפח',
  'המתנה לייבוש המשטחים',
];

const IDLE_MS = 90_000;
const ANALYSIS_WAIT_MS = 60_000;

interface SessionView {
  state: string;
  hygiene: { round: number; stepsDone: number; totalSteps: number; dryRemainingMs: number };
  attempts: number;
  live: { progress: number; weightKg: number | null; contactsOk: boolean; stable: boolean } | null;
  notification: { status: string; channel: string } | null;
  config: { idleResetMs: number; measureDurationMs: number };
}
interface Result {
  weightKg: number;
  bmi: number | null;
  bodyFatPct: number | null;
  muscleMassKg: number | null;
  bodyWaterPct: number | null;
  explanation: string | null;
  recommendations: string[] | null;
  suggestProfessional: boolean | null;
  previousWeightKg: number | null;
}

const fmt = (n: number | null | undefined) => (n == null ? '—' : n.toFixed(1));

export function Kiosk() {
  const [step, setStep] = useState<Step>('welcome');
  const [token, setToken] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [view, setView] = useState<SessionView | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [idleResetMs, setIdleResetMs] = useState(12_000);
  const idleTimer = useRef<ReturnType<typeof setTimeout>>();
  const resultRequested = useRef(false);

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  const call = useCallback(
    <T,>(path: string, method = 'POST', body?: unknown) => api<T>(path, { method, body, token, station: true }),
    [token],
  );

  const reset = useCallback(() => {
    setStep('welcome');
    setToken(null);
    setSessionId(null);
    setView(null);
    setProfile(null);
    setResult(null);
    setMsg('');
    setBusy(false);
    resultRequested.current = false;
  }, []);

  const cancel = useCallback(async () => {
    if (sessionId && token) await api(`/sessions/${sessionId}/cancel`, { method: 'POST', token, station: true }).catch(() => undefined);
    reset();
  }, [sessionId, token, reset]);

  // Inactivity timeout: abandon the session if nobody touches the screen (not during a live measurement).
  useEffect(() => {
    const arm = () => {
      clearTimeout(idleTimer.current);
      if (step === 'welcome' || step === 'measure' || step === 'done') return;
      idleTimer.current = setTimeout(() => void cancel(), IDLE_MS);
    };
    arm();
    window.addEventListener('pointerdown', arm);
    window.addEventListener('keydown', arm);
    return () => {
      clearTimeout(idleTimer.current);
      window.removeEventListener('pointerdown', arm);
      window.removeEventListener('keydown', arm);
    };
  }, [step, cancel]);

  // Final screen resets itself.
  useEffect(() => {
    if (step !== 'done') return;
    const t = setTimeout(reset, idleResetMs);
    return () => clearTimeout(t);
  }, [step, idleResetMs, reset]);

  const refresh = useCallback(async () => {
    if (!sessionId) return null;
    const v = await call<SessionView>(`/sessions/${sessionId}`, 'GET');
    setView(v);
    setIdleResetMs(v.config.idleResetMs);
    return v;
  }, [sessionId, call]);

  async function startSession(t: string) {
    const me = await api<Profile>('/users/me', { token: t });
    setProfile(me);
    const s = await api<{ id: string }>('/sessions', { method: 'POST', token: t, station: true });
    setSessionId(s.id);
    setStep('pay');
  }

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg('');
    try {
      await fn();
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) setMsg('אין חיבור לשרת. נסו שוב בעוד רגע.');
      else if (e instanceof ApiError && e.code === 'hygiene_expired') {
        setMsg('עבר זמן רב מדי מאז הניקוי. יש לחזור על נוהל החיטוי.');
        await refresh();
        setStep('hygiene');
      } else if (e instanceof ApiError && e.code === 'drying_not_finished') setMsg('יש להמתין לסיום זמן הייבוש.');
      else setMsg('אירעה תקלה. נסו שוב או פנו לצוות.');
    } finally {
      setBusy(false);
    }
  };

  // ---------- polling ----------
  useEffect(() => {
    if (!sessionId || (step !== 'hygiene' && step !== 'measure' && step !== 'result')) return;
    const id = setInterval(() => void refresh().catch(() => undefined), step === 'measure' ? 400 : 700);
    return () => clearInterval(id);
  }, [sessionId, step, refresh]);

  // Measurement outcome -> result screen. Polling re-runs this effect, so only one request may be in flight,
  // and a late response must never pull the kiosk back once the user has moved on.
  useEffect(() => {
    if (step !== 'measure' || !view || result || resultRequested.current) return;
    if (!['saved', 'notified', 'failed_notify'].includes(view.state)) return;
    resultRequested.current = true;
    const forSession = sessionId;
    void call<Result>(`/sessions/${forSession}/result`, 'GET')
      .then((r) => {
        setResult(r);
        setStep((s) => (s === 'measure' ? 'result' : s));
      })
      .catch(() => {
        resultRequested.current = false; // allow the next poll to retry
      });
  }, [view, step, result, sessionId, call]);

  // The AI analysis runs after the save and can take tens of seconds; poll until it lands, then stop waiting.
  const [analysisTimedOut, setAnalysisTimedOut] = useState(false);
  useEffect(() => {
    if (step !== 'result' || !result || result.explanation) return;
    const started = Date.now();
    let active = true;
    const id = setInterval(() => {
      if (Date.now() - started > ANALYSIS_WAIT_MS) {
        setAnalysisTimedOut(true);
        clearInterval(id);
        return;
      }
      void call<Result>(`/sessions/${sessionId}/result`, 'GET')
        .then((r) => active && r.explanation && setResult(r))
        .catch(() => undefined);
    }, 2500);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [step, result, sessionId, call]);
  useEffect(() => {
    if (step === 'welcome') setAnalysisTimedOut(false);
  }, [step]);

  const stepIdx = BAR.findIndex((b) => b.steps.includes(step));
  const showCancel = step !== 'welcome' && step !== 'done' && !(step === 'measure' && view?.state === 'measuring');

  let body: React.ReactNode = null;
  if (step === 'welcome') {
    body = (
      <>
        <h1 style={{ fontSize: '3rem', color: 'var(--green)' }}>ברוכים הבאים ל-WeighWise</h1>
        <p className="muted">שקילה וניתוח הרכב גוף בכמה דקות. הכל פשוט ומודרך.</p>
        <button className="btn big" style={{ justifySelf: 'center' }} onClick={() => setStep('auth')}>
          התחלה
        </button>
      </>
    );
  } else if (step === 'auth') {
    body = (
      <div className="card">
        <LoginForm
          kiosk
          onDone={(t, needsProfile) => {
            setToken(t);
            if (needsProfile) {
              void api<Profile>('/users/me', { token: t }).then(setProfile);
              setStep('profile');
            } else void guard(() => startSession(t));
          }}
        />
      </div>
    );
  } else if (step === 'profile' && token && profile) {
    body = (
      <div className="card">
        <h2>עוד רגע ואנחנו מתחילים</h2>
        <ProfileForm token={token} hasEmail={!!profile.email} hasPhone={!!profile.phone} submitLabel="שמירה והמשך" onSaved={() => void guard(() => startSession(token))} />
      </div>
    );
  } else if (step === 'pay') {
    body = (
      <>
        <h2>תשלום</h2>
        <p className="muted">מחיר שקילה: ₪15 · התשלום מדומה בגרסה זו</p>
        {view?.state === 'failed_payment' && <div className="error">התשלום נכשל. אפשר לנסות שוב, ולא תתבצע שקילה ללא תשלום.</div>}
        <button
          className="btn big"
          style={{ justifySelf: 'center' }}
          disabled={busy || !online}
          onClick={() =>
            guard(async () => {
              const r = await call<{ state: string }>(`/sessions/${sessionId}/pay`);
              const v = await refresh();
              if (r.state === 'paid' || v?.state === 'paid') setStep('hygiene');
            })
          }
        >
          תשלום
        </button>
      </>
    );
  } else if (step === 'hygiene') {
    const done = view?.hygiene.stepsDone ?? 0;
    const dry = view?.hygiene.dryRemainingMs ?? 0;
    const current = Math.min(done + 1, 5);
    body = (
      <>
        <h2>נוהל חיטוי מודרך</h2>
        <p className="muted">בצעו כל שלב בעצמכם. אי אפשר לדלג.</p>
        {view && view.hygiene.round > 1 && <div className="notice warn">הנוהל מתחיל מחדש כי עבר זמן מאז הניקוי.</div>}
        <div className="steplist">
          {HYGIENE.map((t, i) => (
            <div key={t} className={i + 1 <= done ? 'done' : i + 1 === current ? 'on' : ''}>
              {i + 1}. {t}
              {i === 4 && done === 4 && (
                <strong> · {dry > 0 ? `נותרו ${Math.ceil(dry / 1000)} שניות` : 'הייבוש הסתיים'}</strong>
              )}
            </div>
          ))}
        </div>
        {done < 5 ? (
          <button
            className="btn big"
            style={{ justifySelf: 'center' }}
            disabled={busy || !online || (done === 4 && dry > 0)}
            onClick={() => guard(async () => {
              await call(`/sessions/${sessionId}/hygiene/${current}`);
              await refresh();
            })}
          >
            {done === 4 ? 'הייבוש הסתיים' : 'בוצע'}
          </button>
        ) : (
          <button className="btn big" style={{ justifySelf: 'center' }} onClick={() => setStep('prep')}>
            המשך
          </button>
        )}
      </>
    );
  } else if (step === 'prep') {
    body = <Prep busy={busy || !online} msg={msg} onConfirm={() => guard(async () => {
      await call(`/sessions/${sessionId}/confirm-prep`, 'POST', { deviceSuitability: true, cleanedPerInstructions: true });
      await refresh();
      setStep('measure');
    })} />;
  } else if (step === 'measure') {
    const live = view?.live;
    const measuring = view?.state === 'measuring';
    const failed = view?.state === 'failed_measure';
    body = (
      <>
        <h2>{measuring ? 'עומדים במקום ללא תנועה' : 'מוכנים למדידה'}</h2>
        {!measuring && !failed && (
          <>
            <p className="muted">עלו יחפים על המשטח ואחזו בשתי הידיות. המדידה נמשכת כחצי דקה.</p>
            <button
              className="btn big"
              style={{ justifySelf: 'center' }}
              disabled={busy || !online}
              onClick={() => guard(async () => {
                await call(`/sessions/${sessionId}/measure`);
                await refresh();
              })}
            >
              התחלת מדידה
            </button>
          </>
        )}
        {measuring && (
          <>
            <div className="big-weight" aria-live="off">{live?.weightKg != null ? live.weightKg.toFixed(1) : '--.-'} <span style={{ fontSize: '2rem' }}>ק״ג</span></div>
            <div className="progress" role="progressbar" aria-valuenow={Math.round((live?.progress ?? 0) * 100)} aria-valuemin={0} aria-valuemax={100}>
              <div style={{ width: `${Math.round((live?.progress ?? 0) * 100)}%` }} />
            </div>
            <div className={live?.contactsOk ? 'muted' : 'error'}>{live?.contactsOk ? 'מגע תקין בידיים וברגליים' : 'ודאו שהרגליים והידיים נוגעות באלקטרודות'}</div>
          </>
        )}
        {failed && (
          <>
            <div className="error">
              {view!.attempts < 2 ? 'לא הצלחנו לקלוט את המדידה. אפשר לנסות שוב ללא חיוב נוסף.' : 'המדידה לא הצליחה. פנו לצוות, התשלום סומן לבדיקה והחזר.'}
            </div>
            {view!.attempts < 2 && (
              <button className="btn big" style={{ justifySelf: 'center' }} disabled={busy} onClick={() => guard(async () => {
                await call(`/sessions/${sessionId}/measure`);
                await refresh();
              })}>
                ניסיון נוסף
              </button>
            )}
          </>
        )}
      </>
    );
  } else if (step === 'result' && result) {
    const n = view?.notification;
    const diff = result.previousWeightKg != null ? Math.round((result.weightKg - result.previousWeightKg) * 10) / 10 : null;
    body = (
      <div className="card" style={{ display: 'grid', gap: '1rem' }}>
        <h2>התוצאה שלכם</h2>
        <div className="big-weight">{fmt(result.weightKg)} <span style={{ fontSize: '2rem' }}>ק״ג</span></div>
        {diff != null && <div className="muted">{diff === 0 ? 'ללא שינוי' : `${diff > 0 ? '+' : ''}${diff} ק״ג`} לעומת המדידה הקודמת</div>}
        <div className="grid">
          <Metric l="BMI (הערכה)" v={fmt(result.bmi)} />
          <Metric l="אחוז שומן (הערכה)" v={result.bodyFatPct != null ? `${fmt(result.bodyFatPct)}%` : '—'} />
          <Metric l="מסת שריר (הערכה)" v={result.muscleMassKg != null ? `${fmt(result.muscleMassKg)} ק״ג` : '—'} />
          <Metric l="אחוז מים (הערכה)" v={result.bodyWaterPct != null ? `${fmt(result.bodyWaterPct)}%` : '—'} />
        </div>
        {result.explanation ? (
          <p style={{ textAlign: 'right' }}>{result.explanation}</p>
        ) : analysisTimedOut ? (
          <div className="notice">הפענוח האישי עדיין בהכנה. הוא יופיע באזור האישי ובהודעה שתישלח אליכם.</div>
        ) : (
          <div className="notice" role="status" aria-live="polite">מנתחים את הנתונים שלכם ומכינים פענוח אישי...</div>
        )}
        <ul style={{ textAlign: 'right' }}>{result.recommendations?.map((r) => <li key={r}>{r}</li>)}</ul>
        {result.suggestProfessional && <div className="notice">אם השינוי מעסיק אתכם, אפשר להתייעץ עם איש מקצוע.</div>}
        <div className="notice">{DISCLAIMER} {COMPOSITION_DISCLAIMER}</div>
        <div role="status">
          {!n || n.status === 'pending' || n.status === 'retrying'
            ? result.explanation
              ? 'שולחים את התוצאה...'
              : null
            : n.status === 'sent'
              ? `התוצאה נשלחה אליכם ${n.channel === 'sms' ? 'ב-SMS' : 'למייל'}`
              : 'השליחה תתבצע בהמשך, התוצאה שמורה באזור האישי'}
        </div>
        <button className="btn big" style={{ justifySelf: 'center' }} onClick={() => setStep('done')}>
          סיום
        </button>
      </div>
    );
  } else if (step === 'done') {
    body = (
      <>
        <h2>תודה!</h2>
        <p>לפני שעוזבים: נגבו את המשטח והידיות במגבון חדש והשליכו אותו לפח.</p>
        <p className="muted">המסך יתאפס אוטומטית</p>
        <button className="btn big" style={{ justifySelf: 'center' }} onClick={reset}>
          חזרה למסך הפתיחה
        </button>
      </>
    );
  }

  return (
    <div className="kiosk">
      <header className="kiosk-top">
        <span className="brand">WeighWise</span>
        <nav className="steps" aria-label="שלבים">
          {BAR.map((b, i) => (
            <span key={b.label} className={i === stepIdx ? 'on' : i < stepIdx ? 'done' : ''} aria-current={i === stepIdx ? 'step' : undefined}>
              {b.label}
            </span>
          ))}
        </nav>
        {showCancel && (
          <button className="btn danger" onClick={() => void cancel()}>
            ביטול ויציאה
          </button>
        )}
      </header>
      <main className="kiosk-main">
        <div className="kiosk-card">
          {body}
          {msg && <div className="error" role="alert">{msg}</div>}
        </div>
      </main>
      <footer className="kiosk-bottom">{DISCLAIMER}</footer>
      {!online && (
        <div className="overlay" role="alertdialog" aria-label="אין חיבור">
          <div>
            אין חיבור לאינטרנט.
            <br />
            לא ניתן לשלם או לבצע שקילה כרגע.
          </div>
        </div>
      )}
    </div>
  );
}

function Metric({ l, v }: { l: string; v: string }) {
  return (
    <div className="metric">
      <div className="v">{v}</div>
      <div className="l">{l}</div>
    </div>
  );
}

function Prep({ busy, msg, onConfirm }: { busy: boolean; msg: string; onConfirm: () => void }) {
  const [suit, setSuit] = useState(false);
  const [clean, setClean] = useState(false);
  return (
    <div className="card" style={{ display: 'grid', gap: '.5rem', textAlign: 'right' }}>
      <h2>הצהרות והכנה</h2>
      <label className="check">
        <input type="checkbox" checked={suit} onChange={(e) => setSuit(e.target.checked)} />
        <span>המכשיר מתאים לי: אין לי קוצב לב או משתל אלקטרוני, ואין מגבלה נוספת לפי הוראות היצרן.</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={clean} onChange={(e) => setClean(e.target.checked)} />
        <span>ניקיתי לפי ההנחיות.</span>
      </label>
      <div className="notice">הסירו נעליים, גרביים וחפצי מתכת (שעון, תכשיטים) לפני העלייה על המשטח.</div>
      {msg && <div className="error">{msg}</div>}
      <button className="btn big" style={{ justifySelf: 'center' }} disabled={!suit || !clean || busy} onClick={onConfirm}>
        המשך למדידה
      </button>
    </div>
  );
}

