import { config } from '../../config.js';

export interface Point {
  weightKg: number;
  bodyFatPct: number | null;
  measuredAt: Date;
}
export type Flag = 'outlier' | 'extreme_change' | 'concerning_trend' | 'first_measurement' | 'composition_jump';
export type Thresholds = typeof config.flags;

const DAY = 86_400_000;
const r1 = (n: number) => Math.round(n * 10) / 10;

export interface Changes {
  vsPreviousKg: number | null;
  vs30DaysKg: number | null;
  trend: 'up' | 'down' | 'stable' | null;
}

/** `history` is any order; flags are computed in code, never by the model. */
export function computeFlags(current: Point, history: Point[], t: Thresholds = config.flags) {
  const prior = history.filter((h) => h.measuredAt < current.measuredAt).sort((a, b) => b.measuredAt.getTime() - a.measuredAt.getTime());
  const flags: Flag[] = [];
  const ageDays = (p: Point) => (current.measuredAt.getTime() - p.measuredAt.getTime()) / DAY;
  const pct = (from: number) => (Math.abs(current.weightKg - from) / from) * 100;

  if (!prior.length) flags.push('first_measurement');
  const prev = prior[0];

  if (prev && ageDays(prev) <= t.outlierDays && Math.abs(current.weightKg - prev.weightKg) > t.outlierKg) flags.push('outlier');

  // Extreme change: > 2% in a week or > 5% in a month, against the oldest reading inside each window.
  const oldestIn = (days: number) => [...prior].reverse().find((p) => ageDays(p) <= days);
  const wk = oldestIn(7);
  const mo = oldestIn(30);
  if ((wk && pct(wk.weightKg) > t.extremeWeekPct) || (mo && pct(mo.weightKg) > t.extremeMonthPct)) flags.push('extreme_change');

  // Concerning trend: a run of >= N consecutive same-direction readings ending now, totalling > 5%.
  const series = [current, ...prior]; // newest first
  let dir = 0;
  let run = 1;
  for (let i = 0; i < series.length - 1; i++) {
    const d = Math.sign(series[i].weightKg - series[i + 1].weightKg);
    if (d === 0 || (dir !== 0 && d !== dir)) break;
    dir = d;
    run++;
  }
  if (run >= t.trendCount) {
    const start = series[run - 1].weightKg;
    if ((Math.abs(current.weightKg - start) / start) * 100 > t.trendPct) flags.push('concerning_trend');
  }

  if (prev && current.bodyFatPct != null && prev.bodyFatPct != null && Math.abs(current.bodyFatPct - prev.bodyFatPct) > t.compositionJumpPts) {
    flags.push('composition_jump');
  }

  const m30 = oldestIn(30);
  const changes: Changes = {
    vsPreviousKg: prev ? r1(current.weightKg - prev.weightKg) : null,
    vs30DaysKg: m30 ? r1(current.weightKg - m30.weightKg) : null,
    trend: prev ? (Math.abs(current.weightKg - prev.weightKg) < 0.3 ? 'stable' : current.weightKg > prev.weightKg ? 'up' : 'down') : null,
  };
  return { flags, changes, suggestProfessional: flags.includes('extreme_change') || flags.includes('concerning_trend') };
}
