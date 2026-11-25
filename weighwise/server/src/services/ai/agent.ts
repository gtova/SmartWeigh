import { pool } from '../../db.js';
import { computeFlags, type Point } from './flags.js';
import { buildUserPrompt, llm, SYSTEM_PROMPT, templateOutput, type AgentInput } from './llm.js';
import { NEUTRAL, parseOutput, PROMPT_VERSION, type LlmOutput } from './schema.js';

const toPoint = (r: { weight_kg: number; body_fat_pct: number | null; measured_at: Date }): Point => ({
  weightKg: r.weight_kg,
  bodyFatPct: r.body_fat_pct,
  measuredAt: new Date(r.measured_at),
});

export async function buildInput(measurementId: string) {
  const cur = (
    await pool.query(
      `SELECT m.*, u.birth_year, u.height_cm FROM measurements m JOIN users u ON u.id=m.user_id WHERE m.id=$1`,
      [measurementId],
    )
  ).rows[0];
  const hist = (
    await pool.query(
      'SELECT weight_kg, body_fat_pct, measured_at FROM measurements WHERE user_id=$1 AND measured_at < $2 ORDER BY measured_at DESC LIMIT 10',
      [cur.user_id, cur.measured_at],
    )
  ).rows;
  const { flags, changes, suggestProfessional } = computeFlags(toPoint(cur), hist.map(toPoint));
  const input: AgentInput = {
    age: new Date().getFullYear() - cur.birth_year,
    heightCm: cur.height_cm,
    current: { weightKg: cur.weight_kg, bmi: cur.bmi, bodyFatPct: cur.body_fat_pct, muscleMassKg: cur.muscle_mass_kg, bodyWaterPct: cur.body_water_pct },
    history: hist.map((h) => ({ date: new Date(h.measured_at).toISOString().slice(0, 10), weightKg: h.weight_kg, bodyFatPct: h.body_fat_pct })),
    changes,
    flags,
  };
  return { input, suggestProfessional, userId: cur.user_id as string };
}

/** Calls the model (one retry), validates the output, and falls back to a neutral message. */
export async function generateOutput(input: AgentInput): Promise<{ out: LlmOutput; model: string }> {
  const p = llm.provider;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = parseOutput(await p.generate({ system: SYSTEM_PROMPT, user: buildUserPrompt(input) }));
      if (out) return { out, model: `${p.name}:${p.model}` };
    } catch {
      /* retry */
    }
  }
  return { out: NEUTRAL, model: `${p.name}:fallback` };
}

export async function generateRecommendation(measurementId: string) {
  const { input, suggestProfessional, userId } = await buildInput(measurementId);
  const consent = await pool.query("SELECT 1 FROM consents WHERE user_id=$1 AND type='ai_processing' AND revoked_at IS NULL", [userId]);
  // No AI-processing consent: nothing leaves the server; use the fixed template instead.
  const res = consent.rowCount ? await generateOutput(input) : { out: templateOutput(input), model: 'template:no-consent' };
  await pool.query(
    `INSERT INTO recommendations(measurement_id, explanation, recommendations, suggest_professional, prompt_version, model)
     VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (measurement_id) DO NOTHING`,
    [measurementId, res.out.explanation, JSON.stringify(res.out.recommendations), suggestProfessional, PROMPT_VERSION, res.model],
  );
}
