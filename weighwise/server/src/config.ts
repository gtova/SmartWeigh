const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' ? Number(v) : d);

// All values come from environment; defaults are the spec defaults.
export const config = {
  port: num(process.env.PORT, 4000),
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
  jwtSecret: jwtSecret(),
  redisUrl: process.env.REDIS_URL ?? '',
  devMode: process.env.NODE_ENV !== 'production',
  termsVersion: '1.0',
  otp: { ttlMs: num(process.env.OTP_TTL_MS, 5 * 60_000), maxAttempts: num(process.env.OTP_MAX_ATTEMPTS, 5) },
  hygiene: {
    dryMs: num(process.env.DRY_MS, 30_000),
    expiryMs: num(process.env.HYGIENE_EXPIRY_MS, 5 * 60_000),
    stepsCount: 5,
  },
  measure: {
    durationMs: num(process.env.MEASURE_DURATION_MS, 30_000),
    manualEntry: process.env.ENABLE_MANUAL_ENTRY === '1',
  },
  purgeAfterMs: num(process.env.PURGE_AFTER_MS, 24 * 3600_000),
  priceAgorot: num(process.env.PRICE_AGOROT, 1500),
  idleResetMs: num(process.env.IDLE_RESET_MS, 12_000),
  flags: {
    outlierKg: num(process.env.OUTLIER_KG, 5),
    outlierDays: num(process.env.OUTLIER_DAYS, 7),
    extremeWeekPct: num(process.env.EXTREME_WEEK_PCT, 2),
    extremeMonthPct: num(process.env.EXTREME_MONTH_PCT, 5),
    trendCount: num(process.env.TREND_COUNT, 4),
    trendPct: num(process.env.TREND_PCT, 5),
    compositionJumpPts: num(process.env.COMPOSITION_JUMP_PTS, 3),
  },
  ai: {
    // Background retries for a fallback analysis (spaced out so a transient 429/503 can clear).
    retryDelaysMs: (process.env.AI_RETRY_DELAYS_MS ?? '30000,120000,600000').split(',').map((s) => Number(s.trim())).filter((n) => n > 0),
    sweepIntervalMs: num(process.env.AI_SWEEP_INTERVAL_MS, 15 * 60_000),
  },
  llm: {
    provider: process.env.LLM_PROVIDER ?? 'mock',
    model: process.env.LLM_MODEL ?? '',
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    geminiKey: process.env.GEMINI_API_KEY ?? '',
    thinkingLevel: (process.env.GEMINI_THINKING_LEVEL ?? 'medium') as 'minimal' | 'low' | 'medium' | 'high',
    googleSearch: process.env.GEMINI_GOOGLE_SEARCH !== '0',
    maxOutputTokens: num(process.env.LLM_MAX_TOKENS, 65536),
    timeoutMs: num(process.env.LLM_TIMEOUT_MS, 90_000),
  },
};


function jwtSecret(): string {
  const s = process.env.JWT_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === 'production') throw new Error('JWT_SECRET is required in production');
  return 'dev-only-secret-change-me';
}



