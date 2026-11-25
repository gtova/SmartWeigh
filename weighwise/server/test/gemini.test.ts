import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { pool } from '../src/db.js';
import { GeminiLLM, llm, MockLLM, type AgentInput, type LLMProvider } from '../src/services/ai/llm.js';
import { generateOutput, generateRecommendation, buildInput } from '../src/services/ai/agent.js';
import { parseOutput, REPORT_FORBIDDEN } from '../src/services/ai/schema.js';
import { GEMINI_PROMPT_VERSION, GEMINI_SYSTEM_PROMPT } from '../src/services/ai/prompts.js';
import { makeUser, resetDb } from './helpers.js';

const report = `## א. תמונת מצב כללית\nהמשקל יציב לאורך התקופה.\n## ה. ההמלצות להמשך\n1. מדידה באותה שעה.\n## ו. מסר מסכם\nכל מדידה היא הזדמנות ללמוד ולהשתפר.`;
const reply = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ explanation: 'המשקל יציב.', recommendations: ['מדידה באותה שעה.', 'שתייה סדירה.'], suggest_professional: false, report, ...over });

const stub = (text: string | (() => string), name = 'gemini'): LLMProvider & { calls: { system: string; user: string }[] } => {
  const calls: { system: string; user: string }[] = [];
  return {
    name,
    model: 'models/test',
    promptVersion: GEMINI_PROMPT_VERSION,
    systemPrompt: GEMINI_SYSTEM_PROMPT,
    calls,
    async generate(p) {
      calls.push(p);
      return typeof text === 'function' ? text() : text;
    },
  };
};

const input: AgentInput = {
  age: 36,
  heightCm: 176,
  current: { weightKg: 72.4, bmi: 23.4, bodyFatPct: 19.4, muscleMassKg: 32.8, bodyWaterPct: 58.2 },
  history: [],
  changes: { vsPreviousKg: null, vs30DaysKg: null, trend: null },
  flags: ['first_measurement'],
};

describe('gemini prompt and output contract', () => {
  it('uses the supplied agent instruction plus the JSON envelope', () => {
    for (const s of ['# תפקיד הסוכן', '# 4. ניתוח היסטוריית ההמלצות', '## ו. מסר מסכם', '# 10. פורמט החזרה טכני', '"report"', 'suggest_professional']) {
      expect(GEMINI_SYSTEM_PROMPT).toContain(s);
    }
  });

  it('keeps the full report when it passes the checks', () => {
    const out = parseOutput(reply())!;
    expect(out.report).toContain('## א. תמונת מצב כללית');
  });

  it('drops only the report when it breaks a hard rule, keeping the validated short texts', () => {
    for (const bad of REPORT_FORBIDDEN) {
      const out = parseOutput(reply({ report: `${report}\nהמשקל ${bad} לגמרי.` }))!;
      expect(out).not.toBeNull();
      expect(out.report).toBeUndefined();
    }
  });

  it('rejects a "normal" judgement in the short kiosk texts (any inflection)', () => {
    expect(parseOutput(reply({ explanation: 'רמת הנוזלים תקינה.' }))).toBeNull();
    expect(parseOutput(reply({ explanation: 'המשקל תקין.' }))).toBeNull();
  });

  it('tolerates a fenced JSON reply', () => {
    expect(parseOutput('```json\n' + reply() + '\n```')?.explanation).toBe('המשקל יציב.');
  });

  it('records the provider prompt version and model', async () => {
    llm.provider = stub(reply());
    const r = await generateOutput(input);
    expect(r.promptVersion).toBe(GEMINI_PROMPT_VERSION);
    expect(r.model).toBe('gemini:models/test');
  });

  it('requires a key', () => {
    expect(() => new GeminiLLM('models/x', '', { thinkingLevel: 'medium', googleSearch: true, maxOutputTokens: 100, timeoutMs: 1000 })).toThrow();
  });
});

describe('gemini agent with stored history', () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(() => {
    llm.provider = new MockLLM();
  });

  const add = async (userId: string, kg: number, daysBack: number, recs?: string[]) => {
    const station = (await pool.query('SELECT id FROM stations LIMIT 1')).rows[0].id;
    const s = (await pool.query("INSERT INTO weigh_sessions(user_id, station_id, state) VALUES($1,$2,'saved') RETURNING id", [userId, station])).rows[0].id;
    const m = (
      await pool.query(
        `INSERT INTO measurements(session_id,user_id,weight_kg,bmi,body_fat_pct,muscle_mass_kg,body_water_pct,station_id,measured_at)
         VALUES($1,$2,$3,23,20,32,57,$4, now() - ($5||' days')::interval) RETURNING id`,
        [s, userId, kg, station, String(daysBack)],
      )
    ).rows[0].id as string;
    if (recs) {
      await pool.query(
        `INSERT INTO recommendations(measurement_id, explanation, recommendations, prompt_version, model, created_at)
         VALUES($1,'x',$2,'gemini-v2','gemini:m', now() - ($3||' days')::interval)`,
        [m, JSON.stringify(recs), String(daysBack)],
      );
    }
    return m;
  };

  it('sends full history and earlier recommendations, never identifiers', async () => {
    const u = await makeUser('private.person@example.com');
    await pool.query("INSERT INTO consents(user_id,type,terms_version) VALUES($1,'ai_processing','1.0')", [u.id]);
    await add(u.id, 73.3, 30, ['הליכה של 20 דקות ביום']);
    await add(u.id, 72.6, 14, ['שתיית מים לאורך היום']);
    const m = await add(u.id, 72.4, 0);
    const p = stub(reply());
    llm.provider = p;
    await generateRecommendation(m);

    const sent = JSON.parse(p.calls[0].user) as AgentInput;
    expect(sent.history).toHaveLength(2);
    expect(sent.history[0]).toMatchObject({ weightKg: 72.6, muscleMassKg: 32, bodyWaterPct: 57 });
    expect(sent.previousRecommendations?.map((r) => r.recommendations[0])).toEqual(['שתיית מים לאורך היום', 'הליכה של 20 דקות ביום']);
    expect(p.calls[0].user).not.toContain('private.person');
    expect(p.calls[0].user).not.toContain(u.id);
    expect(p.calls[0].system).toBe(GEMINI_SYSTEM_PROMPT);

    const row = (await pool.query('SELECT report, prompt_version, model FROM recommendations WHERE measurement_id=$1', [m])).rows[0];
    expect(row.report).toContain('## א. תמונת מצב כללית');
    expect(row.prompt_version).toBe(GEMINI_PROMPT_VERSION);
  });

  it('code-computed flags force suggest_professional even if the model says false', async () => {
    const u = await makeUser();
    await pool.query("INSERT INTO consents(user_id,type,terms_version) VALUES($1,'ai_processing','1.0')", [u.id]);
    await add(u.id, 70, 3);
    const m = await add(u.id, 78, 0); // > 2% in a week -> extreme_change
    llm.provider = stub(reply({ suggest_professional: false }));
    await generateRecommendation(m);
    const row = (await pool.query('SELECT suggest_professional FROM recommendations WHERE measurement_id=$1', [m])).rows[0];
    expect(row.suggest_professional).toBe(true);
    expect((await buildInput(m)).input.flags).toContain('extreme_change');
  });

  it('skips neutral fallbacks when collecting earlier recommendations', async () => {
    const u = await makeUser();
    const old = await add(u.id, 72, 5);
    await pool.query("INSERT INTO recommendations(measurement_id, explanation, recommendations, prompt_version, model) VALUES($1,'x','[\"נייטרלי\"]','v','gemini:fallback')", [old]);
    const m = await add(u.id, 72.1, 0);
    expect((await buildInput(m)).input.previousRecommendations).toEqual([]);
  });
});

// Live check against Google. Runs only with RUN_LIVE_LLM=1 and a key (quota is consumed).
describe.skipIf(process.env.RUN_LIVE_LLM !== '1' || !process.env.GEMINI_API_KEY)('live gemini', () => {
  it('returns a valid analysis', async () => {
    const { configureOutboundProxy } = await import('../src/net.js');
    configureOutboundProxy();
    llm.provider = new GeminiLLM(process.env.LLM_MODEL || 'models/gemini-3.5-flash', process.env.GEMINI_API_KEY!, {
      thinkingLevel: 'medium',
      googleSearch: process.env.GEMINI_GOOGLE_SEARCH !== '0',
      maxOutputTokens: 65536,
      timeoutMs: 120_000,
    });
    const r = await generateOutput(input);
    expect(r.model).not.toContain('fallback');
  }, 300_000);
});
