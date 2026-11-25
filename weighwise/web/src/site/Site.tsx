import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, ApiError, COMPOSITION_DISCLAIMER, DISCLAIMER, type Measurement, type Profile } from '../api';
import { LoginForm } from '../components/LoginForm';
import { ProfileForm } from '../components/ProfileForm';
import { Report } from '../components/Report';

// ---------- auth context ----------
interface Auth {
  token: string | null;
  setToken: (t: string | null) => void;
  profile: Profile | null;
  reloadProfile: () => Promise<void>;
}
const Ctx = createContext<Auth>(null!);
const useAuth = () => useContext(Ctx);

export function SiteLayout() {
  const [token, setTokenState] = useState<string | null>(() => sessionStorage.getItem('ww_token'));
  const [profile, setProfile] = useState<Profile | null>(null);
  const setToken = useCallback((t: string | null) => {
    if (t) sessionStorage.setItem('ww_token', t);
    else sessionStorage.removeItem('ww_token');
    setTokenState(t);
    if (!t) setProfile(null);
  }, []);
  const reloadProfile = useCallback(async () => {
    if (!token) return;
    try {
      setProfile(await api<Profile>('/users/me', { token }));
    } catch {
      setToken(null);
    }
  }, [token, setToken]);
  useEffect(() => void reloadProfile(), [reloadProfile]);
  const value = useMemo(() => ({ token, setToken, profile, reloadProfile }), [token, setToken, profile, reloadProfile]);

  return (
    <Ctx.Provider value={value}>
      <header className="nav">
        <Link to="/" className="brand">WeighWise</Link>
        {token ? (
          <>
            <NavLink to="/dashboard">דשבורד אישי</NavLink>
            <NavLink to="/history">היסטוריית שקילות</NavLink>
            <NavLink to="/settings">הגדרות</NavLink>
            <button className="btn ghost" onClick={() => setToken(null)}>יציאה</button>
          </>
        ) : (
          <Link className="btn" to="/login">כניסה</Link>
        )}
      </header>
      <main>
        <Outlet />
      </main>
      <footer className="footer">{DISCLAIMER}<br />{COMPOSITION_DISCLAIMER}</footer>
    </Ctx.Provider>
  );
}

export function Landing() {
  return (
    <div className="page">
      <section className="hero">
        <h1>שקילה וניתוח הרכב גוף, בשירות עצמי</h1>
        <p className="muted" style={{ fontSize: '1.2rem' }}>ניגשים לעמדה, נמדדים בכמה דקות, ומקבלים את התוצאה ואת ההיסטוריה שלכם באזור אישי. בלי סיסמאות.</p>
        <Link className="btn big" to="/login" style={{ display: 'inline-block', textDecoration: 'none' }}>לאזור האישי</Link>
      </section>
      <section className="grid">
        {[
          ['נוהל חיטוי מודרך', 'כל מדידה מתחילה בניקוי המשטחים לפי הנחיות ברורות, שלב אחר שלב.'],
          ['הסבר פשוט', 'מספרים בשפה ברורה והמלצות מעודדות, בלי שיפוטיות.'],
          ['הפרטיות שלכם', 'המידע שלכם מוצג רק לכם. אפשר לייצא או למחוק אותו בכל עת.'],
        ].map(([t, d]) => (
          <div className="card" key={t}>
            <h3>{t}</h3>
            <p className="muted">{d}</p>
          </div>
        ))}
      </section>
    </div>
  );
}

function useRequireAuth() {
  const { token } = useAuth();
  const loc = useLocation();
  return token ? null : <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} replace />;
}

export function LoginPage() {
  const { token, setToken, reloadProfile } = useAuth();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [registering, setRegistering] = useState(false);
  const rawNext = params.get('next') ?? '/dashboard';
  // Only same-site relative paths are allowed as a post-login target.
  const next = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/dashboard';

  if (token && !registering) return <Navigate to={next} replace />;
  return (
    <div className="page" style={{ maxWidth: 560 }}>
      <div className="card">
        {registering && token ? <Register next={next} /> : (
          <LoginForm
            onDone={(t, needsProfile) => {
              setToken(t);
              void reloadProfile();
              if (needsProfile) setRegistering(true);
              else nav(next, { replace: true });
            }}
          />
        )}
      </div>
    </div>
  );

  function Register({ next }: { next: string }) {
    const { token, profile, reloadProfile } = useAuth();
    useEffect(() => void reloadProfile(), [reloadProfile]);
    if (!token || !profile) return <p>טוען...</p>;
    return (
      <>
        <h2>השלמת הרשמה</h2>
        <ProfileForm token={token} hasEmail={!!profile.email} hasPhone={!!profile.phone} submitLabel="סיום הרשמה" onSaved={() => nav(next, { replace: true })} />
      </>
    );
  }
}

// ---------- data hooks ----------
function useMeasurements() {
  const { token } = useAuth();
  const [data, setData] = useState<Measurement[] | null>(null);
  useEffect(() => {
    if (token) void api<Measurement[]>('/measurements', { token }).then(setData).catch(() => setData([]));
  }, [token]);
  return data;
}

const fmt = (n: number | null | undefined, unit = '') => (n == null ? '—' : `${n.toFixed(1)}${unit}`);
const dateStr = (s: string) => new Date(s).toLocaleDateString('he-IL', { day: 'numeric', month: 'short', year: 'numeric' });

function MetricCard({ l, v, hint }: { l: string; v: string; hint?: string }) {
  return (
    <div className="card metric">
      <div className="l">{l}</div>
      <div className="v">{v}</div>
      {hint && <div className="muted" style={{ fontSize: '.85rem' }}>{hint}</div>}
    </div>
  );
}

export function Dashboard() {
  const redirect = useRequireAuth();
  const { profile } = useAuth();
  const data = useMeasurements();
  const [latest, setLatest] = useState<Measurement | null>(null);
  const { token } = useAuth();
  useEffect(() => {
    if (token && data?.[0]) void api<Measurement>(`/measurements/${data[0].id}`, { token }).then(setLatest);
  }, [token, data]);
  if (redirect) return redirect;
  if (!data) return <div className="page">טוען...</div>;
  if (!data.length)
    return (
      <div className="page">
        <div className="card">
          <h2>שלום {profile?.fullName ?? ''}</h2>
          <p>עדיין אין מדידות. ניגשו לעמדה כדי לבצע את המדידה הראשונה.</p>
        </div>
      </div>
    );
  const m = data[0];
  const prev = data[1];
  const diff = prev ? Math.round((m.weightKg - prev.weightKg) * 10) / 10 : null;
  return (
    <div className="page">
      <h1>שלום {profile?.fullName}</h1>
      <div className="card">
        <div className="muted">מדידה אחרונה · {dateStr(m.measuredAt)}</div>
        <div className="big-weight">{fmt(m.weightKg)} <span style={{ fontSize: '1.6rem' }}>ק״ג</span></div>
        {diff != null && <div className="muted">{diff === 0 ? 'ללא שינוי' : `${diff > 0 ? '+' : ''}${diff} ק״ג`} לעומת המדידה הקודמת</div>}
        {m.isOutlier && <div className="notice" style={{ marginTop: '.8rem' }}>זיהינו שינוי גדול יחסית מהמדידה הקודמת. ייתכן שהוא קשור לתנאי המדידה.</div>}
      </div>
      <div className="grid">
        <MetricCard l="BMI (הערכה)" v={fmt(m.bmi)} />
        <MetricCard l="אחוז שומן (הערכה)" v={fmt(m.bodyFatPct, '%')} />
        <MetricCard l="מסת שריר (הערכה)" v={fmt(m.muscleMassKg, ' ק״ג')} />
        <MetricCard l="אחוז מים (הערכה)" v={fmt(m.bodyWaterPct, '%')} />
      </div>
      <TrendChart items={data.slice(0, 10)} metric="weightKg" />
      {latest?.explanation && (
        <div className="card">
          <h3>ההמלצה האחרונה</h3>
          <p>{latest.explanation}</p>
          <ul>{latest.recommendations?.map((r) => <li key={r}>{r}</li>)}</ul>
          <div className="notice">{DISCLAIMER}</div>
        </div>
      )}
      <Link to={`/measurements/${m.id}`}>לפרטי השקילה המלאים</Link>
    </div>
  );
}

const METRICS = [
  { key: 'weightKg', label: 'משקל', unit: 'ק״ג' },
  { key: 'bmi', label: 'BMI', unit: '' },
  { key: 'bodyFatPct', label: 'אחוז שומן', unit: '%' },
  { key: 'muscleMassKg', label: 'מסת שריר', unit: 'ק״ג' },
  { key: 'bodyWaterPct', label: 'אחוז מים', unit: '%' },
] as const;
type MetricKey = (typeof METRICS)[number]['key'];

function TrendChart({ items, metric, smooth }: { items: Measurement[]; metric: MetricKey; smooth?: boolean }) {
  const asc = [...items].reverse().filter((m) => m[metric] != null);
  const points = asc.map((m, i) => {
    const win = asc.slice(Math.max(0, i - 2), i + 1);
    return {
      date: dateStr(m.measuredAt),
      value: m[metric] as number,
      avg: Math.round((win.reduce((s, x) => s + (x[metric] as number), 0) / win.length) * 10) / 10,
    };
  });
  const label = METRICS.find((x) => x.key === metric)!;
  return (
    <div className="card" style={{ height: 320 }} aria-label={`גרף ${label.label}`} role="img">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 10, right: 10, left: 10, bottom: 10 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e4e5f0" />
          <XAxis dataKey="date" reversed />
          <YAxis domain={['auto', 'auto']} orientation="right" />
          <Tooltip formatter={(v: number) => `${v} ${label.unit}`} />
          <Line type="monotone" dataKey="value" name={label.label} stroke="#2f6143" strokeWidth={2} dot />
          {smooth && <Line type="monotone" dataKey="avg" name="ממוצע נע" stroke="#8a3b12" strokeDasharray="5 4" dot={false} />}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function History() {
  const redirect = useRequireAuth();
  const data = useMeasurements();
  const [metric, setMetric] = useState<MetricKey>('weightKg');
  const [range, setRange] = useState<'30' | '90' | '365' | 'all'>('90');
  const [smooth, setSmooth] = useState(true);
  if (redirect) return redirect;
  if (!data) return <div className="page">טוען...</div>;
  const cutoff = range === 'all' ? 0 : Date.now() - Number(range) * 86_400_000;
  const items = data.filter((m) => new Date(m.measuredAt).getTime() >= cutoff);
  return (
    <div className="page">
      <h1>היסטוריית שקילות</h1>
      <div className="row">
        <label style={{ margin: 0 }}>
          מדד{' '}
          <select value={metric} onChange={(e) => setMetric(e.target.value as MetricKey)} style={{ width: 'auto' }}>
            {METRICS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        </label>
        <label style={{ margin: 0 }}>
          טווח{' '}
          <select value={range} onChange={(e) => setRange(e.target.value as typeof range)} style={{ width: 'auto' }}>
            <option value="30">30 יום</option>
            <option value="90">3 חודשים</option>
            <option value="365">שנה</option>
            <option value="all">הכל</option>
          </select>
        </label>
        <label className="check" style={{ margin: 0 }}>
          <input type="checkbox" checked={smooth} onChange={(e) => setSmooth(e.target.checked)} /> ממוצע נע
        </label>
      </div>
      {items.length ? <TrendChart items={items} metric={metric} smooth={smooth} /> : <div className="card">אין מדידות בטווח שנבחר.</div>}
      <div className="card" style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'right' }}>
          <thead>
            <tr><th>תאריך</th><th>משקל</th><th>BMI</th><th>שומן</th><th>שריר</th><th>מים</th><th></th></tr>
          </thead>
          <tbody>
            {items.map((m) => (
              <tr key={m.id} style={{ borderTop: '1px solid var(--line)' }}>
                <td>{dateStr(m.measuredAt)}</td>
                <td>{fmt(m.weightKg, ' ק״ג')}</td>
                <td>{fmt(m.bmi)}</td>
                <td>{fmt(m.bodyFatPct, '%')}</td>
                <td>{fmt(m.muscleMassKg, ' ק״ג')}</td>
                <td>{fmt(m.bodyWaterPct, '%')}</td>
                <td><Link to={`/measurements/${m.id}`}>פרטים</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="notice">{COMPOSITION_DISCLAIMER}</div>
    </div>
  );
}

export function MeasurementPage() {
  const redirect = useRequireAuth();
  const { id } = useParams();
  const { token } = useAuth();
  const [m, setM] = useState<Measurement | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (token && id) void api<Measurement>(`/measurements/${id}`, { token }).then(setM).catch(() => setMissing(true));
  }, [token, id]);
  if (redirect) return redirect;
  if (missing) return <div className="page"><div className="card">השקילה לא נמצאה.</div></div>;
  if (!m) return <div className="page">טוען...</div>;
  const d = (k: 'weightKg' | 'bmi' | 'bodyFatPct' | 'muscleMassKg' | 'bodyWaterPct') => {
    const a = m[k];
    const b = m.previous?.[k];
    return a != null && b != null ? `${a - b >= 0 ? '+' : ''}${(Math.round((a - b) * 10) / 10).toFixed(1)} לעומת הקודמת` : undefined;
  };
  return (
    <div className="page">
      <h1>פרטי שקילה · {dateStr(m.measuredAt)}</h1>
      <div className="card">
        <div className="big-weight">{fmt(m.weightKg)} <span style={{ fontSize: '1.6rem' }}>ק״ג</span></div>
        <div className="muted">{d('weightKg') ?? 'זו המדידה הראשונה'}</div>
      </div>
      <div className="grid">
        <MetricCard l="BMI (הערכה)" v={fmt(m.bmi)} hint={d('bmi')} />
        <MetricCard l="אחוז שומן (הערכה)" v={fmt(m.bodyFatPct, '%')} hint={d('bodyFatPct')} />
        <MetricCard l="מסת שריר (הערכה)" v={fmt(m.muscleMassKg, ' ק״ג')} hint={d('muscleMassKg')} />
        <MetricCard l="אחוז מים (הערכה)" v={fmt(m.bodyWaterPct, '%')} hint={d('bodyWaterPct')} />
      </div>
      {m.report && (
        <div className="card">
          <h2>פענוח אישי</h2>
          <Report text={m.report} />
        </div>
      )}
      {m.explanation && (
        <div className="card">
          <h3>הסבר והמלצות</h3>
          <p>{m.explanation}</p>
          <ul>{m.recommendations?.map((r) => <li key={r}>{r}</li>)}</ul>
          {m.suggestProfessional && <div className="notice">אם השינוי מעסיק אתכם, אפשר להתייעץ עם איש מקצוע.</div>}
        </div>
      )}
      <div className="notice">{DISCLAIMER} {COMPOSITION_DISCLAIMER}</div>
      <Link to="/history">חזרה להיסטוריה</Link>
    </div>
  );
}

export function Settings() {
  const redirect = useRequireAuth();
  const { token, profile, reloadProfile, setToken } = useAuth();
  const nav = useNavigate();
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');
  if (redirect) return redirect;
  if (!profile || !token) return <div className="page">טוען...</div>;

  async function exportData() {
    try {
      const res = await fetch('/api/me/export', { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error();
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = 'weighwise-export.json';
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError('הייצוא נכשל. נסו שוב.');
    }
  }
  async function deleteAccount() {
    try {
      await api('/me', { method: 'DELETE', token });
      setToken(null);
      nav('/', { replace: true });
    } catch (e) {
      setError(e instanceof ApiError ? 'המחיקה נכשלה. נסו שוב.' : 'שגיאה');
    }
  }
  return (
    <div className="page" style={{ maxWidth: 640 }}>
      <h1>הגדרות</h1>
      <div className="card">
        <h3>פרופיל והסכמות</h3>
        <ProfileForm
          key={profile.id + profile.consents.join()}
          token={token}
          initial={profile}
          hasEmail={!!profile.email}
          hasPhone={!!profile.phone}
          submitLabel="שמירה"
          onSaved={() => {
            setSaved(true);
            void reloadProfile();
          }}
        />
        {saved && <div role="status" style={{ color: 'var(--green)', marginTop: '.5rem' }}>השינויים נשמרו.</div>}
      </div>
      <div className="card">
        <h3>הנתונים שלי</h3>
        <button className="btn ghost" onClick={exportData}>ייצוא כל הנתונים (JSON)</button>
        <hr style={{ border: 0, borderTop: '1px solid var(--line)', margin: '1.2rem 0' }} />
        {!confirmDelete ? (
          <button className="btn danger" onClick={() => setConfirmDelete(true)}>מחיקת חשבון ונתונים</button>
        ) : (
          <div className="notice warn">
            <p>המחיקה היא סופית: כל המדידות, ההמלצות וההסכמות יימחקו.</p>
            <div className="row">
              <button className="btn danger" onClick={deleteAccount}>כן, למחוק הכל</button>
              <button className="btn ghost" onClick={() => setConfirmDelete(false)}>ביטול</button>
            </div>
          </div>
        )}
        {error && <div className="error" role="alert">{error}</div>}
      </div>
    </div>
  );
}

