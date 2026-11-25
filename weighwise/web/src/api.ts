export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public data: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

// The station key identifies this kiosk. In production it is provisioned on the device; the default is dev-only.
export const stationKey = () => localStorage.getItem('ww_station_key') ?? (import.meta.env.VITE_STATION_KEY as string | undefined) ?? 'dev-station-key-104';

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; token?: string | null; station?: boolean; headers?: Record<string, string> } = {},
): Promise<T> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.station) headers['x-station-key'] = stationKey();
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method: opts.method ?? 'GET', headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  } catch {
    throw new ApiError(0, 'network');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'error', data);
  return data as T;
}

export interface Measurement {
  id: string;
  weightKg: number;
  bmi: number | null;
  bodyFatPct: number | null;
  muscleMassKg: number | null;
  bodyWaterPct: number | null;
  measuredAt: string;
  isOutlier: boolean;
  explanation?: string | null;
  recommendations?: string[] | null;
  suggestProfessional?: boolean | null;
  report?: string | null;
  previous?: Measurement | null;
}

export interface Profile {
  id: string;
  email: string | null;
  phone: string | null;
  fullName: string | null;
  birthYear: number | null;
  heightCm: number | null;
  preferredChannel: 'email' | 'sms';
  consents: string[];
}

export const DISCLAIMER = 'התוכן נועד לעידוד בלבד ואינו מהווה ייעוץ רפואי או תזונתי.';
export const COMPOSITION_DISCLAIMER = 'הערכות הרכב גוף הן הערכה בלבד ואינן אבחון.';

