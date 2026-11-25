import { describe, it, expect, beforeEach } from 'vitest';
import { pool } from '../src/db.js';
import { computeFlags, type Point } from '../src/services/ai/flags.js';
import { ClaudeLLM, llm, MockLLM, SYSTEM_PROMPT, buildUserPrompt, type AgentInput, type LLMProvider } from '../src/services/ai/llm.js';
import { FORBIDDEN, NEUTRAL, parseOutput } from '../src/services/ai/schema.js';
import { buildInput, generateOutput, generateRecommendation } from '../src/services/ai/agent.js';
import { makeUser, resetDb } from './helpers.js';

const NOW = new Date('2026-06-30T08:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
const p = (kg: number, daysBack: number, fat: number | null = 20): Point => ({ weightKg: kg, bodyFatPct: fat, measuredAt: daysAgo(daysBack) });
const cur = (kg: number, fat: number | null = 20) => p(kg, 0, fat);

describe('flags (computed in code)', () => {
  it('first measurement', () => {
    expect(computeFlags(cur(70), []).flags).toEqual(['first_measurement']);
  });
  it('stable has no flags', () => {
    const r = computeFlags(cur(70.1), [p(70, 3)]);
    expect(r.flags).toEqual([]);
    expect(r.changes.trend).toBe('stable');
  });
  it('gradual weight loss is not extreme', () => {
    const r = computeFlags(cur(69), [p(70, 7), p(70.5, 14)]);
    expect(r.flags).not.toContain('extreme_change');
    expect(r.changes.vsPreviousKg).toBe(-1);
    expect(r.changes.trend).toBe('down');
  });
  it('big jump inside a week is an outlier and extreme', () => {
    const r = computeFlags(cur(78), [p(70, 3)]);
    expect(r.flags).toEqual(expect.arrayContaining(['outlier', 'extreme_change']));
    expect(r.suggestProfessional).toBe(true);
  });
  it('more than 2% in a week is extreme, but exactly under it is not', () => {
    expect(computeFlags(cur(71.5), [p(70, 6)]).flags).toContain('extreme_change'); // 2.14%
    expect(computeFlags(cur(71.3), [p(70, 6)]).flags).not.toContain('extreme_change'); // 1.86%
  });
  it('four consecutive rises totalling over 5% is a concerning trend', () => {
    const r = computeFlags(cur(75), [p(73, 10), p(71.5, 20), p(70, 30)]);
    expect(r.flags).toContain('concerning_trend');
    expect(r.suggestProfessional).toBe(true);
  });
  it('a broken run is not a trend', () => {
    expect(computeFlags(cur(75), [p(71, 10), p(73, 20), p(70, 30)]).flags).not.toContain('concerning_trend');
  });
  it('fat jump over 3 points flags composition_jump only', () => {
    const r = computeFlags(cur(70, 25), [p(70, 3, 20)]);
    expect(r.flags).toEqual(['composition_jump']);
    expect(r.suggestProfessional).toBe(false);
  });
});

const base = (flags: AgentInput['flags'], d: number | null): AgentInput => ({
  age: 35,
  heightCm: 175,
  current: { weightKg: 72.4, bmi: 23.6, bodyFatPct: 19.4, muscleMassKg: 32.8, bodyWaterPct: 58.2 },
  history: [],
  changes: { vsPreviousKg: d, vs30DaysKg: null, trend: d === null ? null : d > 0.3 ? 'up' : d < -0.3 ? 'down' : 'stable' },
  flags,
});
const scenarios: [string, AgentInput][] = [
  ['loss', base([], -1.2)],
  ['gain', base([], 1.4)],
  ['stable', base([], 0.1)],
  ['jump', base(['outlier', 'extreme_change'], 6)],
  ['first', base(['first_measurement'], null)],
  ['concerning', base(['concerning_trend'], 1)],
  ['composition', base(['composition_jump'], 0)],
];

describe('agent safety scenarios (mock provider)', () => {
  for (const [name, input] of scenarios) {
    it(`${name}: valid schema and no forbidden words`, async () => {
      const raw = await new MockLLM().generate({ system: SYSTEM_PROMPT, user: buildUserPrompt(input) });
      const out = parseOutput(raw);
      expect(out).not.toBeNull();
      const all = [out!.explanation, ...out!.recommendations].join(' ');
      for (const w of FORBIDDEN) expect(all).not.toContain(w);
      expect(out!.recommendations.length).toBeGreaterThanOrEqual(2);
      expect(out!.recommendations.length).toBeLessThanOrEqual(3);
    });
  }
  it('extreme and concerning flags suggest a professional gently', async () => {
    const out = parseOutput(await new MockLLM().generate({ system: '', user: buildUserPrompt(scenarios[3][1]) }))!;
    expect(out.recommendations.join(' ')).toContain('איש מקצוע');
  });
  it('system prompt carries the safety rules', () => {
    for (const s of ['בלי אבחון', 'בלי קלוריות', 'איש מקצוע']) expect(SYSTEM_PROMPT).toContain(s);
  });
});

describe('output validation and fallback', () => {
  const stub = (replies: (string | Error)[]): LLMProvider => {
    let i = 0;
    return {
      name: 'stub',
      model: 's',
      promptVersion: 'v1',
      systemPrompt: SYSTEM_PROMPT,
      async generate() {
        const r = replies[Math.min(i++, replies.length - 1)];
        if (r instanceof Error) throw r;
        return r;
      },
    };
  };
  const good = JSON.stringify({ explanation: 'המשקל יציב.', recommendations: ['מדידה באותה שעה.', 'שתייה סדירה.'], suggest_professional: false });
  const input = scenarios[0][1];

  it('rejects wrong shape, English, and forbidden words', () => {
    expect(parseOutput('not json')).toBeNull();
    expect(parseOutput(JSON.stringify({ explanation: 'ok', recommendations: ['a', 'b'], suggest_professional: false }))).toBeNull();
    expect(parseOutput(JSON.stringify({ explanation: 'כדאי לספור קלוריות', recommendations: ['א', 'ב'], suggest_professional: false }))).toBeNull();
    expect(parseOutput(JSON.stringify({ explanation: 'שלום', recommendations: ['אחת'], suggest_professional: false }))).toBeNull();
  });
  it('retries once, then succeeds', async () => {
    llm.provider = stub(['garbage', good]);
    expect((await generateOutput(input)).out.explanation).toBe('המשקל יציב.');
  });
  it('falls back to the neutral message after two failures', async () => {
    llm.provider = stub([new Error('boom'), 'garbage']);
    expect((await generateOutput(input)).out).toEqual(NEUTRAL);
  });
  it('real provider requires model and key', () => {
    expect(() => new ClaudeLLM('', 'k')).toThrow();
    expect(() => new ClaudeLLM('m', '')).toThrow();
  });
});

describe('persistence', () => {
  beforeEach(async () => {
    llm.provider = new MockLLM();
    await resetDb();
  });
  const addMeasurement = async (userId: string, kg: number, daysBack: number) => {
    const station = (await pool.query('SELECT id FROM stations LIMIT 1')).rows[0].id;
    const s = (await pool.query('INSERT INTO weigh_sessions(user_id, station_id, state) VALUES($1,$2,$3) RETURNING id', [userId, station, 'saved'])).rows[0].id;
    return (
      await pool.query(
        `INSERT INTO measurements(session_id,user_id,weight_kg,bmi,body_fat_pct,station_id,measured_at) VALUES($1,$2,$3,23,20,$4, now() - ($5||' days')::interval) RETURNING id`,
        [s, userId, kg, station, String(daysBack)],
      )
    ).rows[0].id as string;
  };

  it('never sends identifying data to the model', async () => {
    const u = await makeUser('secret.person@example.com');
    await addMeasurement(u.id, 70, 5);
    const m = await addMeasurement(u.id, 71, 0);
    const { input } = await buildInput(m);
    const text = buildUserPrompt(input);
    expect(text).not.toContain('secret');
    expect(text).not.toContain(u.id);
    expect(text).not.toContain('בדיקה'); // the user's name
    expect(input.history).toHaveLength(1);
  });

  it('stores the recommendation with prompt version and model; AI consent gates the call', async () => {
    const u = await makeUser();
    const m1 = await addMeasurement(u.id, 70, 0);
    let called = 0;
    llm.provider = { name: 'spy', model: 'x', promptVersion: 'v1', systemPrompt: SYSTEM_PROMPT, generate: async () => (called++, JSON.stringify({ explanation: 'שלום.', recommendations: ['א.', 'ב.'], suggest_professional: false })) };
    await generateRecommendation(m1);
    expect(called).toBe(0); // no ai_processing consent yet
    let row = (await pool.query('SELECT * FROM recommendations WHERE measurement_id=$1', [m1])).rows[0];
    expect(row.model).toBe('template:no-consent');
    expect(row.prompt_version).toBe('v1');

    await pool.query("INSERT INTO consents(user_id,type,terms_version) VALUES($1,'ai_processing','1.0')", [u.id]);
    const m2 = await addMeasurement(u.id, 71, 0);
    await generateRecommendation(m2);
    expect(called).toBe(1);
    row = (await pool.query('SELECT * FROM recommendations WHERE measurement_id=$1', [m2])).rows[0];
    expect(row.model).toBe('spy:x');
  });
});

// Runs only when a real key is provided: ANTHROPIC_API_KEY, LLM_MODEL.
describe.skipIf(!process.env.ANTHROPIC_API_KEY || !process.env.LLM_MODEL)('real Claude provider', () => {
  for (const [name, input] of scenarios) {
    it(name, async () => {
      llm.provider = new ClaudeLLM(process.env.LLM_MODEL!, process.env.ANTHROPIC_API_KEY!);
      const { out, model } = await generateOutput(input);
      expect(model).not.toContain('fallback');
      for (const w of FORBIDDEN) expect(out.explanation + out.recommendations.join(' ')).not.toContain(w);
    });
  }
});

